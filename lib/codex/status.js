// ──────────────────────────────────────────────
// Codex provider status — CLI, home, login, provider, rate limits
// ──────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { codexLaunchSpec, peekAppServer, getAppServer } from './app-server.js';
import { readCodexConfig, readCodexAuthSummary, resolveCodexHome, overflowProviderOf } from './config.js';
import { discoverCodexApiCredentials } from './chat.js';
import { codexCatalogSource } from './models.js';

const execFileAsync = promisify(execFile);
let versionCache = { at: 0, value: null };

export async function codexVersion(launch) {
    if (!launch) return null;
    if (Date.now() - versionCache.at < 5 * 60 * 1000) return versionCache.value;
    try {
        const { stdout } = await execFileAsync(launch.command, [...launch.args, '--version'], { timeout: 8000, windowsHide: true, shell: !!launch.shell });
        versionCache = { at: Date.now(), value: stdout.trim().replace(/^codex-cli\s*/i, '') };
    } catch {
        versionCache = { at: Date.now(), value: null };
    }
    return versionCache.value;
}

/** Rate-limit snapshot: live read when logged in, else the last notification. */
export async function codexRateLimits({ startServer = false } = {}) {
    let server = peekAppServer();
    if (!server?.alive && startServer && codexLaunchSpec()) {
        try { server = await getAppServer(); } catch { server = null; }
    }
    if (!server?.alive) return null;
    try {
        const res = await server.request('account/rateLimits/read', null, { timeoutMs: 15000 });
        return normaliseRateLimits(res?.rateLimits ?? res, res);
    } catch {
        return server.lastRateLimits ? normaliseRateLimits(server.lastRateLimits) : null;
    }
}

function normaliseRateLimits(rl, full = null) {
    if (!rl) return null;
    const windows = [];
    const push = (type, w) => {
        if (!w || typeof w.usedPercent !== 'number') return;
        windows.push({ type, utilization: w.usedPercent / 100, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null, windowMinutes: w.windowDurationMins ?? null });
    };
    push('primary', rl.primary);
    push('secondary', rl.secondary);
    return {
        planType: rl.planType ?? null,
        limitReached: rl.rateLimitReachedType ?? null,
        credits: rl.credits ?? null,
        windows,
        resetCredits: full?.rateLimitResetCredits?.availableCount ?? null,
        observedAt: rl.observedAt ?? Date.now(),
    };
}

export async function codexStatus({ deep = false } = {}) {
    const start = Date.now();
    const launch = codexLaunchSpec();
    const version = await codexVersion(launch);
    const home = peekAppServer()?.codexHome ?? resolveCodexHome();
    const config = readCodexConfig(home);
    const auth = readCodexAuthSummary(home);
    const api = discoverCodexApiCredentials(null);
    const overflow = overflowProviderOf(config);

    let account = null;
    const server = peekAppServer();
    if (deep && launch) {
        try {
            const s = server?.alive ? server : await getAppServer();
            const res = await s.request('account/read', { refreshToken: false }, { timeoutMs: 15000 });
            account = res?.account ? { type: res.account.type ?? null, planType: res.account.planType ?? null, email: res.account.email ?? null } : null;
        } catch { /* ignore */ }
    }
    const rateLimits = deep ? await codexRateLimits({ startServer: false }) : (server?.lastRateLimits ? normaliseRateLimits(server.lastRateLimits) : null);

    const loggedIn = auth.present && (auth.mode === 'chatgpt' || auth.hasTokens || auth.hasApiKey);
    const available = !!launch || !!api;
    const ok = (!!launch && (loggedIn || !!overflow)) || !!api;
    let message;
    if (!launch && !api) message = 'Codex CLI not found and no API key set — `npm i -g @openai/codex` then `codex login`, or set LINKAPI_CODEX_API_KEY.';
    else if (launch && !loggedIn && !overflow) message = `Codex CLI is installed but not logged in (no auth.json in ${home}). Run \`codex login\` as the SillyTavern user, or use the "api" backend with a key.`;

    return {
        provider: 'codex',
        ok,
        available,
        cli: launch ? { found: true, path: launch.path, source: launch.source, version } : { found: false },
        home,
        config: {
            present: config.exists,
            modelProvider: config.modelProvider ?? 'openai',
            overflowProvider: overflow,
            providers: Object.keys(config.providers),
            mcpServersDisabled: config.mcpNames.length,
            pluginsDisabled: config.pluginNames.length,
            defaultModel: config.model,
        },
        login: { present: auth.present, mode: auth.mode ?? null, loggedIn, lastRefresh: auth.lastRefresh ?? null },
        account,
        api: api ? { available: true, source: api.source, baseUrl: api.baseUrl } : { available: false },
        appServer: { running: !!server?.alive, home: server?.codexHome ?? null },
        catalogSource: codexCatalogSource(),
        rateLimits,
        message,
        latencyMs: Date.now() - start,
    };
}
