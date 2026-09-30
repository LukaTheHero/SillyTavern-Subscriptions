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
// request; it is restarted transparently if it dies or stops answering.
//
// Isolation: the user's config.toml stays in charge of auth and the model
// provider (so a provider switch made in the CLI is respected), but the agent
// toolset (shell, MCP, plugins, apps, web search, sub-agents…), notify hooks,
// AGENTS.md project docs and the host-context prompt blocks are switched off
// with -c overrides — roleplay threads must never reach the host. After
// `initialize` the effective config is read back (`config/read`); an MCP
// server that is still enabled triggers one relaunch with it switched off,
// and the start fails closed when that is not possible.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { resolveExecutable, commonBinDirs } from '../common/exec.js';
import { IS_TERMUX, termuxPrefix } from '../common/platform.js';
import { runtimeDir } from '../common/runtime.js';
import { pluginVersion } from '../status.js';
import { readCodexConfig, resolveCodexHome, isolationOverrides, enabledMcpServers, SAFE_MCP_NAME } from './config.js';

const TAG = '[subscriptions/codex]';
const REQUEST_TIMEOUT_MS = 30000;
const INIT_TIMEOUT_MS = 60000;
/** Consecutive request timeouts after which a live-but-silent app-server is recycled. */
const MAX_CONSECUTIVE_TIMEOUTS = 2;

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

/** An error the chat runner reports as a configuration problem (HTTP 400). */
function configError(message) {
    return Object.assign(new Error(message), { httpStatus: 400 });
}

export class CodexAppServer extends EventEmitter {
    #proc = null;
    #nextId = 1;
    #pending = new Map();
    #starting = null;
    #threadListeners = new Map();
    #stderrTail = '';
    #timeouts = 0;
    #lastLineAt = 0;
    /** MCP servers config/read reported enabled during the current start sequence. */
    #learnedMcp = new Set();
    info = null;
    codexHome = null;
    launch = null;
    lastRateLimits = null;
    /** Last `account/read` result ({ type, planType, email, at }) or null. */
    lastAccount = null;
    /** instructionSources reported by the last thread/start (global AGENTS.md…), or null when unknown. */
    lastInstructionSources = null;
    /** Result of the post-launch isolation check. */
    isolation = null;
    /** Message of the last failed start (shown by /status). */
    lastStartError = null;

    get alive() {
        return !!this.#proc && this.#proc.exitCode === null && !this.#proc.killed;
    }

    /** Running, initialised and isolation-checked (not in the middle of a start or relaunch). */
    get ready() {
        return this.alive && !!this.info && !this.#starting;
    }

    /** Start (or return the in-flight start of) the process. */
    start() {
        // The in-flight start first: `info` is already set while the isolation
        // check (and a possible relaunch) is still running, and no caller may
        // use the process before that check passed.
        if (this.#starting) return this.#starting;
        if (this.alive && this.info) return Promise.resolve(this);
        // An explicit home wins; otherwise restarts scan the real home the
        // previous process reported instead of guessing again.
        const explicit = process.env.ST_SUBSCRIPTIONS_CODEX_HOME || process.env.CODEX_HOME;
        const configHome = explicit ? resolveCodexHome() : (this.codexHome ?? resolveCodexHome());
        this.#learnedMcp.clear();
        this.#starting = this.#doStart(configHome, 0)
            .then((v) => { this.lastStartError = null; return v; })
            .catch((err) => { this.lastStartError = err instanceof Error ? err.message : String(err); throw err; })
            .finally(() => { this.#starting = null; });
        return this.#starting;
    }

    #spawn(launch, args) {
        const env = { ...process.env, CODEX_CI: '1' };
        if (process.env.ST_SUBSCRIPTIONS_CODEX_HOME) env.CODEX_HOME = process.env.ST_SUBSCRIPTIONS_CODEX_HOME;

        // A previous process that exited but whose exit is still being reported
        // (see the 'exit' handler) must not strand its callers once replaced.
        if (this.#proc) this.#failAll(new Error('Codex app-server exited'));
        const proc = spawn(launch.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: runtimeDir('codex-cwd'), windowsHide: true, shell: false });
        this.#proc = proc;
        this.#resetProcessState();
        this.#stderrTail = '';
        this.#timeouts = 0;
        this.#lastLineAt = Date.now();

        // A write racing the child's exit raises EPIPE on stdin; unhandled, that
        // 'error' event would take the whole SillyTavern process down (POSIX).
        proc.stdin.on('error', (err) => console.warn(`${TAG} app-server stdin: ${err.message}`));
        proc.stdout.on('error', () => { /* the exit handler reports the failure */ });
        proc.stderr.on('error', () => { /* ignore */ });
        proc.stderr.on('data', (d) => {
            const s = String(d).replace(/\x1b\[[0-9;]*m/g, '');
            this.#stderrTail = (this.#stderrTail + s).slice(-4000);
            if (/\bERROR\b|panic/i.test(s) && !/websocket/i.test(s)) console.warn(`${TAG} app-server: ${s.trim().slice(0, 300)}`);
        });
        createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line));
        proc.on('exit', (code, signal) => {
            if (this.#proc !== proc) return; // stopped or superseded by a relaunch
            // stdio can still hold the last stderr lines when 'exit' fires (POSIX),
            // and #doStart reads that text to decide on a relaunch — wait briefly.
            let reported = false;
            const report = () => {
                if (reported) return;
                reported = true;
                if (this.#proc !== proc) return;
                console.warn(`${TAG} app-server exited (code ${code}, signal ${signal})`);
                const err = new Error(`Codex app-server exited (code ${code})${this.#stderrTail ? ': ' + this.#stderrTail.trim().slice(-300) : ''}`);
                this.#failAll(err);
                this.#proc = null;
                this.#resetProcessState();
                this.emit('exit', code);
            };
            if (proc.stderr.readableEnded || proc.stderr.destroyed) { report(); return; }
            const t = setTimeout(report, 300);
            t.unref?.();
            proc.stderr.once('close', () => { clearTimeout(t); report(); });
        });
        proc.on('error', (err) => {
            console.error(`${TAG} app-server spawn error:`, err.message);
            if (this.#proc !== proc) return;
            this.#failAll(err);
            this.#proc = null;
            this.#resetProcessState();
        });
        return proc;
    }

    /**
     * @param {string} configHome home whose config.toml the isolation flags are computed from
     * @param {number} attempt 0 = first launch, 1 = relaunch after the isolation check
     * @param {object} [opts]
     * @param {boolean} [opts.webSearchKey=true] pass web_search="disabled"
     * @param {boolean} [opts.useScan=true] switch off the MCP servers found by the config.toml scan
     */
    async #doStart(configHome, attempt, { webSearchKey = true, useScan = true } = {}) {
        const launch = codexLaunchSpec();
        if (!launch) {
            throw new Error('Codex CLI not found. Install it (`npm i -g @openai/codex`) and run `codex login`, or set ST_SUBSCRIPTIONS_CODEX_PATH.');
        }
        this.launch = launch;
        const config = readCodexConfig(configHome);
        const scan = useScan ? config : { mcpNames: [], pluginNames: config.pluginNames };
        const overrides = isolationOverrides(scan, { extraMcpNames: [...this.#learnedMcp], webSearchKey });
        this.#spawn(launch, [...launch.args, 'app-server', '--stdio', ...overrides]);

        let init;
        try {
            init = await this.request('initialize', { clientInfo: { name: 'sillytavern-subscriptions', version: pluginVersion() } }, { timeoutMs: INIT_TIMEOUT_MS });
        } catch (err) {
            const text = err?.message ?? '';
            this.stop();
            // CLIs that type `web_search` differently refuse the whole config — retry once without that key.
            if (webSearchKey && /web_search/i.test(text)) {
                console.warn(`${TAG} this Codex CLI rejects web_search="disabled" — relaunching without it`);
                return this.#doStart(configHome, attempt, { webSearchKey: false, useScan });
            }
            // `mcp_servers.X.enabled=false` for a server the real config does not
            // define (scan of the wrong home, or a server removed since) makes
            // Codex refuse to start ("invalid transport") — retry without guesses;
            // the config/read check below then names the servers exactly.
            if (/mcp_servers/i.test(text) && useScan) {
                console.warn(`${TAG} Codex rejected an MCP override (${text.slice(-160).trim()}) — relaunching without guessed server names`);
                return this.#doStart(configHome, attempt, { webSearchKey, useScan: false });
            }
            throw err;
        }
        this.notify('initialized', {});
        this.info = init;
        this.codexHome = init?.codexHome ?? configHome;

        // Read the effective configuration back: the scan above is a heuristic
        // (and may have looked at the wrong home), config/read is authoritative.
        // Plugins need no second look — features.plugins=false turns them all off.
        let effective;
        try {
            effective = await this.request('config/read', { includeLayers: false, cwd: runtimeDir('codex-cwd') }, { timeoutMs: REQUEST_TIMEOUT_MS });
        } catch (err) {
            this.stop();
            throw configError(`Could not verify that Codex's MCP servers are switched off for roleplay (config/read failed: ${err?.message ?? err}). ` +
                'Update the Codex CLI (`npm i -g @openai/codex@latest`) and try again.');
        }
        const stillEnabled = enabledMcpServers(effective?.config);
        if (stillEnabled.length) {
            const unsafe = stillEnabled.filter((n) => !SAFE_MCP_NAME.test(n));
            if (unsafe.length) {
                this.stop();
                throw configError(`Codex config ${join(this.codexHome, 'config.toml')} enables MCP server${unsafe.length > 1 ? 's' : ''} ${unsafe.map((n) => JSON.stringify(n)).join(', ')} ` +
                    'whose name cannot be switched off from the command line, so roleplay chats are refused. Rename it (letters, digits, _ and - only), ' +
                    'set `enabled = false` on it, or point ST_SUBSCRIPTIONS_CODEX_HOME at a dedicated Codex home (`CODEX_HOME=<dir> codex login`).');
            }
            if (attempt > 0) {
                this.stop();
                throw configError(`Codex MCP server${stillEnabled.length > 1 ? 's' : ''} ${stillEnabled.join(', ')} stayed enabled after being switched off, so roleplay chats are refused. ` +
                    'Disable them in config.toml or point ST_SUBSCRIPTIONS_CODEX_HOME at a dedicated Codex home.');
            }
            for (const n of stillEnabled) this.#learnedMcp.add(n);
            console.log(`${TAG} MCP server(s) ${stillEnabled.join(', ')} still enabled (home ${this.codexHome}, config scanned ${configHome}) — relaunching with them switched off`);
            this.stop();
            return this.#doStart(this.codexHome, attempt + 1, { webSearchKey, useScan });
        }
        this.isolation = {
            verified: true,
            mcpServersDisabled: Object.keys(effective?.config?.mcp_servers ?? {}).length,
            pluginsDisabled: readCodexConfig(this.codexHome).pluginNames.length,
        };
        console.log(`${TAG} app-server ready (home ${this.codexHome}, cli ${launch.source})`);
        return this;
    }

    /** Everything learned from one process: a new or stopped process starts from scratch. */
    #resetProcessState() {
        this.info = null;
        this.lastAccount = null;
        this.lastInstructionSources = null;
        this.isolation = null;
    }

    #failAll(err) {
        for (const p of this.#pending.values()) p.reject(err);
        this.#pending.clear();
        for (const [threadId, fns] of this.#threadListeners) for (const fn of fns) fn({ method: 'st/exit', params: { threadId, error: err } });
        this.#threadListeners.clear();
    }

    #onLine(line) {
        this.#lastLineAt = Date.now();
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id !== undefined && msg.method === undefined) {
            this.#timeouts = 0; // it answers — not hung
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

    /**
     * Server → client requests are always refused. With approvalPolicy
     * 'never' Codex does not ask before running a tool, so this is not what
     * keeps tools out of roleplay (the -c feature switches and the chat
     * runner's item/started guard are); it only answers anything that does
     * arrive so the turn never blocks on us.
     */
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
            case 'item/tool/call':
                result = { contentItems: [], success: false };
                break;
            case 'mcpServer/elicitation/request':
                result = { action: 'decline', content: null };
                break;
            default:
                this.#safeWrite({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } });
                return;
        }
        this.#safeWrite({ jsonrpc: '2.0', id: msg.id, result });
    }

    #write(obj) {
        if (!this.alive) throw new Error('Codex app-server is not running');
        this.#proc.stdin.write(JSON.stringify(obj) + '\n');
    }

    #safeWrite(obj) {
        try { this.#write(obj); } catch { /* process gone — the exit handler fails pending work */ }
    }

    request(method, params, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        const id = this.#nextId++;
        const sentAt = Date.now();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Codex app-server request ${method} timed out after ${timeoutMs}ms`));
                this.#onTimeout(sentAt);
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

    /**
     * A live process that went completely silent is recycled so the next
     * request gets a fresh one. A timeout while the process still talks (a
     * slow network-bound call such as model/list) is not a hang and must not
     * kill the turns other chats have in flight.
     */
    #onTimeout(sentAt) {
        if (this.#lastLineAt > sentAt) { this.#timeouts = 0; return; }
        this.#timeouts++;
        if (this.#timeouts < MAX_CONSECUTIVE_TIMEOUTS || !this.#proc) return;
        console.warn(`${TAG} app-server stopped answering (${this.#timeouts} requests timed out) — restarting it`);
        this.#failAll(new Error('Codex app-server stopped answering — it was restarted; try again'));
        this.stop();
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
        // Fail pending calls and turns first: once #proc is cleared the exit
        // handler treats the process as superseded and would not.
        this.#failAll(new Error('Codex app-server stopped'));
        this.#proc = null;
        this.#resetProcessState();
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
