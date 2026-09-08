// ──────────────────────────────────────────────
// Codex CLI home + config.toml reader
// ──────────────────────────────────────────────
//
// Codex keeps its state in CODEX_HOME. Newer CLIs default to ~/.codex-cli when
// the Codex desktop app owns ~/.codex, older ones (and Linux boxes without the
// app) use ~/.codex. We use a heuristic for the pre-launch config scan and let
// the app-server's `initialize` response (which reports the real codexHome)
// correct us afterwards.
//
// Only a tiny TOML subset is read on purpose: top-level scalars, the
// [model_providers.X] tables and the *names* of [mcp_servers.X] and
// [plugins."X"] sections — enough to know which provider the user's overflow
// toggle selected and which servers/plugins to switch off for roleplay.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function codexHomeCandidates() {
    const h = homedir();
    const out = [];
    if (process.env.ST_SUBSCRIPTIONS_CODEX_HOME) out.push(process.env.ST_SUBSCRIPTIONS_CODEX_HOME);
    if (process.env.CODEX_HOME) out.push(process.env.CODEX_HOME);
    out.push(join(h, '.codex-cli'), join(h, '.codex'));
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

function unquote(v) {
    v = v.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
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

    let section = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^\s*#.*$/, '').trim();
        if (!line) continue;
        const header = line.match(/^\[\[?([^\]]+)\]?\]$/);
        if (header) {
            section = header[1].trim();
            const mcp = section.match(/^mcp_servers\.("?)([^."\]]+)\1$/);
            if (mcp && !result.mcpNames.includes(mcp[2])) result.mcpNames.push(mcp[2]);
            const plugin = section.match(/^plugins\."([^"]+)"$/);
            if (plugin && !result.pluginNames.includes(plugin[1])) result.pluginNames.push(plugin[1]);
            continue;
        }
        const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
        if (!kv) continue;
        const key = kv[1];
        const value = unquote(kv[2].replace(/\s+#.*$/, ''));
        if (section === null) {
            result.top[key] = value;
        } else {
            const prov = section.match(/^model_providers\.("?)([^"\]]+)\1$/);
            if (prov) (result.providers[prov[2]] ??= {})[key] = value;
        }
    }
    result.modelProvider = result.top.model_provider ?? null;
    result.model = result.top.model ?? null;
    return result;
}

/** Non-secret auth.json summary. */
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

/** `-c` overrides that keep roleplay threads free of the user's agent tooling. */
export function isolationOverrides(config) {
    const args = ['-c', 'notify=[]', '-c', 'project_doc_max_bytes=0'];
    for (const n of config.mcpNames) args.push('-c', `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(n) ? n : `"${n}"`}.enabled=false`);
    for (const n of config.pluginNames) args.push('-c', `plugins."${n}".enabled=false`);
    return args;
}
