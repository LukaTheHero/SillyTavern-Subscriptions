// ──────────────────────────────────────────────
// Codex app-server client (JSON-RPC 2.0 over stdio, newline-delimited)
// ──────────────────────────────────────────────
//
// `codex exec --json` only emits whole messages, so replies would appear all
// at once after a long wait. `codex app-server` — the same protocol the VS Code
// extension and the desktop app speak — streams token deltas
// (item/agentMessage/delta), reasoning summaries, token usage and rate-limit
// updates, lets us pass a custom system prompt (baseInstructions, replacing
// the coding preamble), run ephemeral threads (nothing written to disk), and
// interrupt a turn for stop sequences. One long-lived process serves every
// request; it is restarted transparently if it dies.
//
// Isolation: the user's config.toml stays in charge of auth and the model
// provider (so their LinkAPI overflow toggle is respected), but MCP servers,
// plugins, notify hooks and AGENTS.md loading are switched off with -c
// overrides — roleplay threads must never spawn tooling.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { resolveExecutable, commonBinDirs } from '../common/exec.js';
import { IS_TERMUX, termuxPrefix } from '../common/platform.js';
import { runtimeDir } from '../common/runtime.js';
import { readCodexConfig, resolveCodexHome, isolationOverrides } from './config.js';

const TAG = '[subscriptions/codex]';
const REQUEST_TIMEOUT_MS = 30000;
const CLIENT_INFO = { name: 'sillytavern-subscriptions', version: '3.0.0' };

/** Launch spec for the codex CLI, or null. */
export function codexLaunchSpec() {
    const h = homedir();
    const extra = [join(h, '.codex-cli', 'bin'), join(h, '.codex', 'bin'), ...commonBinDirs()];
    if (IS_TERMUX) extra.unshift(join(termuxPrefix(), 'bin'));
    return resolveExecutable({
        envVars: ['ST_SUBSCRIPTIONS_CODEX_PATH', 'CODEX_PATH'],
        names: ['codex'],
        extraDirs: extra,
        npm: { pkg: '@openai/codex', files: ['bin/codex.js'] },
    });
}

export class CodexAppServer extends EventEmitter {
    #proc = null;
    #nextId = 1;
    #pending = new Map();
    #starting = null;
    #threadListeners = new Map();
    #stderrTail = '';
    #relaunched = false;
    info = null;
    codexHome = null;
    launch = null;
    lastRateLimits = null;

    get alive() {
        return !!this.#proc && this.#proc.exitCode === null && !this.#proc.killed;
    }

    /** Start (or return the in-flight start of) the process. */
    start() {
        if (this.alive && this.info) return Promise.resolve(this);
        if (this.#starting) return this.#starting;
        this.#starting = this.#doStart(resolveCodexHome()).finally(() => { this.#starting = null; });
        return this.#starting;
    }

    async #doStart(configHome) {
        const launch = codexLaunchSpec();
        if (!launch) {
            throw new Error('Codex CLI not found. Install it (`npm i -g @openai/codex`) and run `codex login`, or set ST_SUBSCRIPTIONS_CODEX_PATH.');
        }
        this.launch = launch;
        const config = readCodexConfig(configHome);
        const args = [...launch.args, 'app-server', '--stdio', ...isolationOverrides(config)];
        const env = { ...process.env, CODEX_CI: '1' };
        if (process.env.ST_SUBSCRIPTIONS_CODEX_HOME) env.CODEX_HOME = process.env.ST_SUBSCRIPTIONS_CODEX_HOME;

        const proc = spawn(launch.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: runtimeDir('codex-cwd'), windowsHide: true, shell: !!launch.shell });
        this.#proc = proc;
        this.info = null;
        this.#stderrTail = '';

        proc.stderr.on('data', (d) => {
            const s = String(d).replace(/\x1b\[[0-9;]*m/g, '');
            this.#stderrTail = (this.#stderrTail + s).slice(-4000);
            if (/\bERROR\b|panic/i.test(s) && !/websocket/i.test(s)) console.warn(`${TAG} app-server: ${s.trim().slice(0, 300)}`);
        });
        createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line));
        proc.on('exit', (code, signal) => {
            if (this.#proc !== proc) return; // superseded by a relaunch
            console.warn(`${TAG} app-server exited (code ${code}, signal ${signal})`);
            const err = new Error(`Codex app-server exited (code ${code})${this.#stderrTail ? ': ' + this.#stderrTail.trim().slice(-300) : ''}`);
            this.#failAll(err);
            this.#proc = null;
            this.info = null;
            this.emit('exit', code);
        });
        proc.on('error', (err) => {
            console.error(`${TAG} app-server spawn error:`, err.message);
            this.#failAll(err);
        });

        const init = await this.request('initialize', { clientInfo: CLIENT_INFO }, { timeoutMs: 60000 });
        this.notify('initialized', {});
        this.info = init;
        this.codexHome = init?.codexHome ?? configHome;

        // The CLI's real home may differ from the heuristic one (e.g. ~/.codex-cli
        // vs ~/.codex): the isolation flags were then computed against the wrong
        // config.toml — relaunch once against the real one.
        if (this.codexHome !== configHome && !this.#relaunched) {
            const real = readCodexConfig(this.codexHome);
            const current = config;
            const differs = real.mcpNames.join() !== current.mcpNames.join() || real.pluginNames.join() !== current.pluginNames.join();
            if (differs) {
                console.log(`${TAG} codex home is ${this.codexHome} (config scanned ${configHome}) — relaunching with matching isolation flags`);
                this.#relaunched = true;
                this.stop();
                return this.#doStart(this.codexHome);
            }
        }
        console.log(`${TAG} app-server ready (home ${this.codexHome}, cli ${launch.source})`);
        return this;
    }

    #failAll(err) {
        for (const p of this.#pending.values()) p.reject(err);
        this.#pending.clear();
        for (const [threadId, fns] of this.#threadListeners) for (const fn of fns) fn({ method: 'st/exit', params: { threadId, error: err } });
        this.#threadListeners.clear();
    }

    #onLine(line) {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id !== undefined && msg.method === undefined) {
            const p = this.#pending.get(msg.id);
            if (!p) return;
            this.#pending.delete(msg.id);
            if (msg.error) {
                const err = new Error(msg.error.message ?? 'app-server error');
                err.code = msg.error.code;
                err.data = msg.error.data;
                p.reject(err);
            } else {
                p.resolve(msg.result);
            }
            return;
        }
        if (msg.method && msg.id !== undefined) {
            this.#answerServerRequest(msg);
            return;
        }
        if (msg.method) {
            const params = msg.params ?? {};
            if (msg.method === 'account/rateLimits/updated' && params.rateLimits) this.lastRateLimits = { ...params.rateLimits, observedAt: Date.now() };
            const threadId = params.threadId ?? params.thread?.id;
            if (threadId && this.#threadListeners.has(threadId)) {
                for (const fn of this.#threadListeners.get(threadId)) fn(msg);
            }
            this.emit('notification', msg);
        }
    }

    /** Server → client requests: approvals are always refused (roleplay never runs tools). */
    #answerServerRequest(msg) {
        let result;
        switch (msg.method) {
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval':
                result = { decision: 'decline' };
                break;
            case 'execCommandApproval':
            case 'applyPatchApproval':
                result = { decision: 'abort' };
                break;
            case 'item/tool/requestUserInput':
                result = { answers: {} };
                break;
            case 'mcpServer/elicitation/request':
                result = { action: 'decline', content: null };
                break;
            default:
                this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } });
                return;
        }
        this.#write({ jsonrpc: '2.0', id: msg.id, result });
    }

    #write(obj) {
        if (!this.alive) throw new Error('Codex app-server is not running');
        this.#proc.stdin.write(JSON.stringify(obj) + '\n');
    }

    request(method, params, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Codex app-server request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref?.();
            this.#pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            try {
                this.#write({ jsonrpc: '2.0', id, method, params: params ?? null });
            } catch (err) {
                clearTimeout(timer);
                this.#pending.delete(id);
                reject(err);
            }
        });
    }

    notify(method, params) {
        this.#write({ jsonrpc: '2.0', method, params: params ?? {} });
    }

    /** Receive every notification for a thread. Returns an unsubscribe fn. */
    subscribeThread(threadId, fn) {
        if (!this.#threadListeners.has(threadId)) this.#threadListeners.set(threadId, new Set());
        this.#threadListeners.get(threadId).add(fn);
        return () => {
            const set = this.#threadListeners.get(threadId);
            if (!set) return;
            set.delete(fn);
            if (set.size === 0) this.#threadListeners.delete(threadId);
        };
    }

    stop() {
        const proc = this.#proc;
        this.#proc = null;
        this.info = null;
        if (proc && proc.exitCode === null) {
            try { proc.stdin.end(); } catch { /* ignore */ }
            const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 1500);
            t.unref?.();
        }
    }
}

let singleton = null;

/** Lazily started shared app-server. */
export async function getAppServer() {
    if (!singleton) singleton = new CodexAppServer();
    await singleton.start();
    return singleton;
}

export function peekAppServer() {
    return singleton;
}

export function stopAppServer() {
    singleton?.stop();
}
