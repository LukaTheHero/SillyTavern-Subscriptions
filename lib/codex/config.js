// ──────────────────────────────────────────────
// Codex CLI home + config.toml reader
// ──────────────────────────────────────────────
//
// Codex keeps its state in CODEX_HOME. Stock Codex uses $CODEX_HOME when it is
// set and ~/.codex otherwise (probed first); some wrapper launchers point
// CODEX_HOME at ~/.codex-cli so a CLI login can live next to a desktop-app
// install, so that folder is probed second. This is only a heuristic for the pre-launch config
// scan: the app-server's `initialize` response reports the home it really
// uses, and everything after launch (login check, config, status) follows it.
//
// Only a small TOML subset is read on purpose: top-level scalars, the
// [model_providers.X] tables and the *names* of MCP servers and plugins —
// enough to know which provider the user's overflow toggle selected and which
// servers/plugins to switch off for roleplay. The scan is a hint, not a
// safety net: the app-server's own `config/read` is checked after launch
// (see app-server.js) and a server that is still enabled fails closed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function codexHomeCandidates() {
    const h = homedir();
    const out = [];
    if (process.env.ST_SUBSCRIPTIONS_CODEX_HOME) out.push(process.env.ST_SUBSCRIPTIONS_CODEX_HOME);
    if (process.env.CODEX_HOME) out.push(process.env.CODEX_HOME);
    // Stock Codex's default first; ~/.codex-cli is a wrapper-launcher convention.
    out.push(join(h, '.codex'), join(h, '.codex-cli'));
    return [...new Set(out)];
}

/** Heuristic CODEX_HOME (explicit env wins, then the first existing candidate). */
export function resolveCodexHome() {
    const cands = codexHomeCandidates();
    if (process.env.ST_SUBSCRIPTIONS_CODEX_HOME) return cands[0];
    if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
    for (const c of cands) if (existsSync(join(c, 'config.toml')) || existsSync(join(c, 'auth.json'))) return c;
    return join(homedir(), '.codex');
}

// ── Minimal TOML pieces ──

const BARE_KEY = /[A-Za-z0-9_-]/;

/**
 * Parse a TOML key path (`a.b."c.d".'e'`) starting at `s[i]`.
 * @returns {{ keys: string[], end: number } | null}
 */
function parseKeyPath(s, i = 0) {
    const keys = [];
    for (;;) {
        while (s[i] === ' ' || s[i] === '\t') i++;
        let key = '';
        if (s[i] === '"') {
            i++;
            while (i < s.length && s[i] !== '"') {
                if (s[i] === '\\' && i + 1 < s.length) {
                    const n = s[i + 1];
                    key += n === 'n' ? '\n' : n === 't' ? '\t' : n;
                    i += 2;
                    continue;
                }
                key += s[i++];
            }
            if (s[i] !== '"') return null;
            i++;
        } else if (s[i] === "'") {
            const close = s.indexOf("'", i + 1);
            if (close < 0) return null;
            key = s.slice(i + 1, close);
            i = close + 1;
        } else {
            const start = i;
            while (i < s.length && BARE_KEY.test(s[i])) i++;
            if (i === start) return null;
            key = s.slice(start, i);
        }
        keys.push(key);
        while (s[i] === ' ' || s[i] === '\t') i++;
        if (s[i] !== '.') return { keys, end: i };
        i++;
    }
}

/** Index just past a TOML scalar/array/inline-table value starting at `s[i]` (strings and nesting respected). */
function valueEnd(s, i) {
    let depth = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '"' || c === "'") {
            const close = c === '"' ? findBasicStringEnd(s, i + 1) : s.indexOf("'", i + 1);
            if (close < 0) return s.length;
            i = close + 1;
            continue;
        }
        if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
        else if (c === '#' && depth <= 0) return i;
        else if (c === ',' && depth === 0) return i;
        i++;
        if (depth < 0) return i - 1;
    }
    return i;
}

function findBasicStringEnd(s, i) {
    while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '"') return i;
        i++;
    }
    return -1;
}

/** TOML scalar text → JS string (quotes removed, basic escapes resolved). */
function unquote(v) {
    v = v.trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
        return v.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
    }
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
    return v;
}

/** Flat `{ a = "x", b.c = 1 }` inline table → [[keys, rawValue], …] (nested tables are kept raw). */
function inlineTableEntries(text) {
    const s = text.trim();
    if (!s.startsWith('{') || !s.endsWith('}')) return [];
    const body = s.slice(1, -1);
    const out = [];
    let i = 0;
    while (i < body.length) {
        while (i < body.length && /[\s,]/.test(body[i])) i++;
        if (i >= body.length) break;
        const kp = parseKeyPath(body, i);
        if (!kp || body[kp.end] !== '=') break;
        let j = kp.end + 1;
        while (body[j] === ' ' || body[j] === '\t') j++;
        const end = valueEnd(body, j);
        out.push([kp.keys, body.slice(j, end).trim()]);
        i = end;
    }
    return out;
}

/**
 * @param {string} [home]
 * @returns {{ home: string, path: string, exists: boolean, top: Record<string,string>, providers: Record<string, Record<string,string>>, mcpNames: string[], pluginNames: string[], modelProvider: string|null, model: string|null }}
 */
export function readCodexConfig(home = resolveCodexHome()) {
    const path = join(home, 'config.toml');
    const result = { home, path, exists: false, top: {}, providers: {}, mcpNames: [], pluginNames: [], modelProvider: null, model: null };
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { return result; }
    result.exists = true;

    const addName = (list, name) => { if (typeof name === 'string' && name && !list.includes(name)) list.push(name); };
    const record = (full, rawValue) => {
        if (full[0] === 'mcp_servers' && full.length >= 2) addName(result.mcpNames, full[1]);
        else if (full[0] === 'plugins' && full.length >= 2) addName(result.pluginNames, full[1]);
        if (rawValue === undefined) return;
        if (full.length === 1) {
            result.top[full[0]] = unquote(rawValue);
        } else if (full[0] === 'model_providers' && full.length === 3) {
            (result.providers[full[1]] ??= {})[full[2]] = unquote(rawValue);
        } else if (full[0] === 'model_providers' && full.length === 2) {
            const prov = (result.providers[full[1]] ??= {});
            for (const [k, v] of inlineTableEntries(rawValue)) if (k.length === 1) prov[k[0]] = unquote(v);
        }
    };

    let section = [];
    let multiline = null; // closing delimiter of a multi-line string being skipped
    let arrayDepth = 0; // open brackets of a multi-line array being skipped
    for (const raw of text.split(/\r?\n/)) {
        if (multiline) {
            if (raw.includes(multiline)) multiline = null;
            continue;
        }
        if (arrayDepth > 0) {
            for (const c of raw.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '')) {
                if (c === '#') break;
                if (c === '[') arrayDepth++;
                else if (c === ']') arrayDepth--;
            }
            if (arrayDepth < 0) arrayDepth = 0;
            continue;
        }
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        if (line.startsWith('[')) {
            const isArray = line.startsWith('[[');
            const kp = parseKeyPath(line, isArray ? 2 : 1);
            if (!kp) continue;
            const close = isArray ? ']]' : ']';
            if (!line.slice(kp.end).startsWith(close)) continue;
            section = kp.keys;
            record(section, undefined);
            continue;
        }

        const kp = parseKeyPath(line, 0);
        if (!kp || line[kp.end] !== '=') continue;
        let j = kp.end + 1;
        while (line[j] === ' ' || line[j] === '\t') j++;
        const rest = line.slice(j);
        const delim = rest.startsWith('"""') ? '"""' : rest.startsWith("'''") ? "'''" : null;
        if (delim) {
            if (!rest.slice(3).includes(delim)) multiline = delim;
            record([...section, ...kp.keys], undefined);
            continue;
        }
        const end = valueEnd(line, j);
        const rawValue = line.slice(j, end).trim();
        if (rawValue.startsWith('[')) {
            let depth = 0;
            for (const c of rawValue.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '')) {
                if (c === '[') depth++;
                else if (c === ']') depth--;
            }
            if (depth > 0) arrayDepth = depth;
        }
        record([...section, ...kp.keys], rawValue);
    }
    result.modelProvider = result.top.model_provider ?? null;
    result.model = result.top.model ?? null;
    return result;
}

/** Non-secret auth.json summary. `mode` is Codex's auth_mode ('chatgpt' | 'apikey' | …). */
export function readCodexAuthSummary(home = resolveCodexHome()) {
    const path = join(home, 'auth.json');
    if (!existsSync(path)) return { present: false, path };
    try {
        const a = JSON.parse(readFileSync(path, 'utf8'));
        const mode = a.auth_mode ?? (a.tokens ? 'chatgpt' : (a.OPENAI_API_KEY ? 'apikey' : 'unknown'));
        return { present: true, path, mode, lastRefresh: a.last_refresh ?? null, hasTokens: !!a.tokens, hasApiKey: !!a.OPENAI_API_KEY };
    } catch {
        return { present: true, path, mode: 'unreadable' };
    }
}

/** The first non-OpenAI provider configured (what an overflow toggle points at). */
export function overflowProviderOf(config) {
    if (config.modelProvider && config.modelProvider !== 'openai' && config.providers[config.modelProvider]) return config.modelProvider;
    const names = Object.keys(config.providers).filter((n) => n !== 'openai');
    return names[0] ?? null;
}

// ── Isolation overrides ──

/**
 * Codex features that give the model tools or agent behaviour. They are
 * switched off with `-c features.<name>=false` rather than `--disable <name>`:
 * a CLI that does not know one of these names ignores the -c key, while
 * `--disable` would refuse to start.
 */
export const DISABLED_FEATURES = [
    'shell_tool', 'unified_exec', 'view_image', 'sleep_tool', 'multi_agent', 'apps', 'plugins', 'hooks',
    'goals', 'image_generation', 'browser_use', 'computer_use', 'skill_search', 'tool_suggest', 'memories',
];

/** Context blocks Codex would otherwise add to every prompt (host paths, shell, timezone, skills list…). */
const CONTEXT_OVERRIDES = [
    'include_environment_context=false',
    'include_permissions_instructions=false',
    'include_apps_instructions=false',
    'include_collaboration_mode_instructions=false',
    'skills.include_instructions=false',
    'skills.bundled.enabled=false',
];

/** Names that can be written as a bare `-c` path segment (Codex keeps quote characters literally). */
export const SAFE_MCP_NAME = /^[A-Za-z0-9_-]+$/;
const SAFE_PLUGIN_NAME = /^[A-Za-z0-9_@-]+$/;

/**
 * `-c` overrides that keep roleplay threads free of the user's agent tooling
 * and of host context.
 * @param {{ mcpNames?: string[], pluginNames?: string[] }} config scan of config.toml
 * @param {object} [opts]
 * @param {string[]} [opts.extraMcpNames] servers the app-server reported as still enabled
 * @param {boolean} [opts.webSearchKey=true] emit web_search="disabled" (older CLIs typed it differently)
 */
export function isolationOverrides(config, { extraMcpNames = [], webSearchKey = true } = {}) {
    const args = ['-c', 'notify=[]', '-c', 'project_doc_max_bytes=0', '-c', 'thread_unload_delay_secs=1'];
    for (const f of DISABLED_FEATURES) args.push('-c', `features.${f}=false`);
    if (webSearchKey) args.push('-c', 'web_search="disabled"');
    for (const o of CONTEXT_OVERRIDES) args.push('-c', o);
    const mcp = [...new Set([...(config?.mcpNames ?? []), ...extraMcpNames])];
    for (const n of mcp) if (SAFE_MCP_NAME.test(n)) args.push('-c', `mcp_servers.${n}.enabled=false`);
    // Plugins are already off via features.plugins=false; per-plugin switches
    // are belt and braces, emitted unquoted (a quoted segment creates a new,
    // literally-quoted key and leaves the real plugin enabled).
    for (const n of config?.pluginNames ?? []) if (SAFE_PLUGIN_NAME.test(n)) args.push('-c', `plugins.${n}.enabled=false`);
    return args;
}

/**
 * Names of MCP servers still enabled in an app-server `config/read` result.
 * @param {object} effective `config` object from config/read
 */
export function enabledMcpServers(effective) {
    const servers = effective?.mcp_servers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.entries(servers).filter(([, v]) => v && typeof v === 'object' && v.enabled !== false).map(([k]) => k);
}

/** Global instruction files Codex loads from its home (AGENTS.override.md wins over AGENTS.md). Non-empty files only. */
export function globalInstructionFiles(home) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
        const p = join(home, name);
        try {
            if (readFileSync(p, 'utf8').trim()) return [p];
        } catch { /* absent */ }
    }
    return [];
}
