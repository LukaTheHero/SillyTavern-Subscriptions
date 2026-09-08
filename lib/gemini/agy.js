// ──────────────────────────────────────────────
// Google Antigravity CLI (`agy`) driver
// ──────────────────────────────────────────────
//
// Print mode with `--output-format stream-json` gives NDJSON events:
//   {"event":"init", ...}
//   {"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"…"}}
//   {"event":"step_update","step_update":{"state":"DONE", "usage":{…}}}
//   {"event":"result","result":{"status":"SUCCESS"|"ERROR","response":"…","error":"…","usage":{…}}}
// The prompt is piped on STDIN with `--input-format text` (no -p), which
// sidesteps the command-line length limit that would truncate long chats.
// agy never streams its thinking in this mode, so reasoning display is
// unavailable for Gemini through the CLI (the "api" backend does stream it
// when the relay supports reasoning_content).
//
// agy's tool set cannot be disabled by flag; the prompt carries a text-only
// instruction and any non-text step is ignored. Requests run with cwd set to
// the plugin's scratch dir so no project rules or knowledge leak in.

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { resolveExecutable, commonBinDirs } from '../common/exec.js';
import { IS_WINDOWS, IS_TERMUX, termuxPrefix } from '../common/platform.js';
import { runtimeDir } from '../common/runtime.js';

const TAG = '[subscriptions/gemini]';
const execFileAsync = promisify(execFile);

export function agyLaunchSpec() {
    const h = homedir();
    const extra = [];
    if (IS_WINDOWS) extra.push(join(process.env.LOCALAPPDATA || join(h, 'AppData', 'Local'), 'agy', 'bin'));
    extra.push(join(h, '.agy', 'bin'), join(h, '.local', 'bin'), ...commonBinDirs());
    if (IS_TERMUX) extra.unshift(join(termuxPrefix(), 'bin'));
    return resolveExecutable({
        envVars: ['ST_SUBSCRIPTIONS_AGY_PATH', 'AGY_PATH'],
        names: ['agy', 'agy.bin'],
        extraDirs: extra,
        npm: { pkg: 'agy', files: ['bin/agy.js', 'bin/agy'] },
    });
}

export function antigravitySettingsPath() {
    return join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

export function readAntigravitySettings() {
    try {
        const p = antigravitySettingsPath();
        if (!existsSync(p)) return null;
        return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

let versionCache = { at: 0, value: null };
export async function agyVersion(launch = agyLaunchSpec()) {
    if (!launch) return null;
    if (Date.now() - versionCache.at < 5 * 60 * 1000) return versionCache.value;
    try {
        const { stdout } = await execFileAsync(launch.command, [...launch.args, '--version'], { timeout: 8000, windowsHide: true, shell: !!launch.shell });
        versionCache = { at: Date.now(), value: stdout.trim().split(/\r?\n/).pop() };
    } catch {
        versionCache = { at: Date.now(), value: null };
    }
    return versionCache.value;
}

/** `agy models` → [{ id, name }] (network call; cached by the caller). */
export async function agyListModels(launch = agyLaunchSpec()) {
    if (!launch) return null;
    const { stdout } = await execFileAsync(launch.command, [...launch.args, 'models'], { timeout: 20000, windowsHide: true, shell: !!launch.shell, env: { ...process.env, NO_COLOR: '1' } });
    const out = [];
    for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*([a-z0-9][a-z0-9.\-_]*)\s+(.+?)\s*$/i);
        if (!m || /^fetching/i.test(m[1])) continue;
        out.push({ id: m[1], name: m[2] });
    }
    return out.length ? out : null;
}

/**
 * Run one print-mode turn.
 * @param {object} args
 * @param {string} args.prompt
 * @param {string} args.model
 * @param {string} [args.effort]
 * @param {number} [args.timeoutMs]
 * @param {(delta: string) => boolean} args.onText returns true to stop
 * @param {(delta: string) => void} [args.onReasoning]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ usage: object|null, response: string, status: string }>}
 */
export function runAgy({ prompt, model, effort, timeoutMs = 10 * 60 * 1000, onText, onReasoning, signal }) {
    const launch = agyLaunchSpec();
    if (!launch) return Promise.reject(new Error('Antigravity CLI (agy) not found.'));

    const args = [...launch.args, '--output-format', 'stream-json', '--input-format', 'text', '--disable-slash-commands', '--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    return new Promise((resolve, reject) => {
        const proc = spawn(launch.command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: runtimeDir('gemini-cwd'), windowsHide: true, shell: !!launch.shell, env: { ...process.env, NO_COLOR: '1' } });
        let usage = null;
        let response = '';
        let status = null;
        let errorText = null;
        let stderr = '';
        let terminated = false;
        let settled = false;

        const finish = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(killer);
            signal?.removeEventListener('abort', onAbort);
            if (err) reject(err); else resolve({ usage, response, status });
        };
        const terminate = () => {
            if (terminated) return;
            terminated = true;
            try { proc.kill(); } catch { /* ignore */ }
        };
        const onAbort = () => { terminate(); finish(null); };
        signal?.addEventListener('abort', onAbort, { once: true });
        const killer = setTimeout(() => { terminate(); finish(new Error(`agy did not finish within ${timeoutMs}ms`)); }, timeoutMs + 5000);
        killer.unref?.();

        proc.on('error', (err) => finish(new Error(`failed to start agy (${launch.path}): ${err.message}`)));
        proc.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-4000); });

        createInterface({ input: proc.stdout }).on('line', (line) => {
            if (terminated) return;
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) return;
            let ev;
            try { ev = JSON.parse(trimmed); } catch { return; }
            if (ev.event === 'step_update' && ev.step_update) {
                const step = ev.step_update;
                if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
                    response += step.text_delta;
                    if (onText(step.text_delta)) { terminate(); finish(null); return; }
                }
                if (onReasoning && typeof step.reasoning_delta === 'string' && step.reasoning_delta) onReasoning(step.reasoning_delta);
                if (onReasoning && typeof step.thinking_delta === 'string' && step.thinking_delta) onReasoning(step.thinking_delta);
                if (step.usage) usage = step.usage;
            } else if (ev.event === 'result' && ev.result) {
                status = ev.result.status ?? null;
                if (ev.result.usage) usage = ev.result.usage;
                if (status && status !== 'SUCCESS') errorText = ev.result.error || `agy result status ${status}`;
                if (!response && typeof ev.result.response === 'string' && ev.result.response && status === 'SUCCESS') {
                    // Nothing streamed (should not happen) — emit the final text.
                    response = ev.result.response;
                    onText(ev.result.response);
                }
            }
        });

        proc.stdin.on('error', () => { /* EPIPE when agy exits early — reported via close */ });
        proc.on('close', (code) => {
            if (terminated && settled) return;
            if (errorText) return finish(new Error(`agy: ${errorText}`));
            if (code !== 0 && !response) return finish(new Error(`agy exited with code ${code}${stderr ? ': ' + stderr.trim().slice(-400) : ''}`));
            finish(null);
        });

        proc.stdin.write(prompt);
        proc.stdin.end();
    });
}

export { TAG as AGY_TAG };
