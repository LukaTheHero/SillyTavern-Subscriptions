// ──────────────────────────────────────────────
// Codex provider status — CLI, home, login, provider, rate limits
// ──────────────────────────────────────────────
//
// `backends` follows the shared status contract:
//   subscription.ready — true only for a ChatGPT login (an API-key login is
//                        never used by the subscription backend); null when
//                        the login cannot be seen without a deep check
//                        (credentials kept in the OS keyring).
//   api.ready          — true when a key (or a non-OpenAI provider in
//                        config.toml) is visible; null otherwise, because a
//                        key pasted into SillyTavern's Custom API key field
//                        only arrives with each request.
// `ok` = the default (subscription) backend is usable.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { codexLaunchSpec, peekAppServer, getAppServer } from './app-server.js';
import { readCodexConfig, readCodexAuthSummary, resolveCodexHome, overflowProviderOf, globalInstructionFiles } from './config.js';
import { discoverCodexApiCredentials } from './chat.js';
import { codexCatalogSource } from './models.js';

const execFileAsync = promisify(execFile);
let versionCache = { at: 0, value: null };

export async function codexVersion(launch) {
    if (!launch) return null;
    if (Date.now() - versionCache.at < 5 * 60 * 1000) return versionCache.value;
    try {
        const { stdout } = await execFileAsync(launch.command, [...launch.args, '--version'], { timeout: 8000, windowsHide: true, shell: false });
        versionCache = { at: Date.now(), value: stdout.trim().replace(/^codex-cli\s*/i, '') };
    } catch {
        versionCache = { at: Date.now(), value: null };
    }
    return versionCache.value;
}

/** Rate-limit snapshot: live read when logged in, else the last notification. */
export async function codexRateLimits({ startServer = false } = {}) {
    let server = peekAppServer();
    if (!server?.ready && startServer && codexLaunchSpec()) {
        try { server = await getAppServer(); } catch { server = null; }
    }
    if (!server?.ready) return null;
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

/**
 * Subscription readiness from what is known without a model call.
 * @returns {{ ready: boolean|null, message?: string }}
 */
export function subscriptionReadiness({ launch, account, auth, config, instructionSources, startError }) {
    if (!launch) return { ready: false, message: 'Codex CLI not found — `npm i -g @openai/codex`, then `codex login`.' };
    if (startError) return { ready: false, message: startError };
    if (instructionSources?.length) {
        return {
            ready: false,
            message: `Codex would inject ${instructionSources.join(', ')} into every roleplay prompt, so chats are refused. ` +
                'Set ST_SUBSCRIPTIONS_CODEX_HOME to a dedicated folder and run `CODEX_HOME=<that folder> codex login` once, or empty/rename the file.',
        };
    }
    if (account) {
        if (account.type === 'chatgpt') return { ready: true };
        if (account.type === 'apiKey' || account.type === 'apikey') return { ready: false, message: 'Codex is signed in with an API key — the subscription backend never bills a key. Run `codex login` with your ChatGPT account.' };
        if (account.type) return { ready: false, message: `Codex is signed in with a ${account.type} account, not ChatGPT. Run \`codex login\` with your ChatGPT account.` };
        return { ready: false, message: 'Codex is not signed in. Run `codex login` (ChatGPT account) as the SillyTavern user.' };
    }
    if (auth.present) {
        if (auth.mode === 'chatgpt') return { ready: true };
        if (auth.mode === 'apikey') return { ready: false, message: 'Codex is signed in with an API key — the subscription backend never bills a key. Run `codex login` with your ChatGPT account.' };
        return { ready: null, message: `Codex login file has auth mode "${auth.mode}"; a deep status check (account read) tells for sure.` };
    }
    const store = String(config?.top?.cli_auth_credentials_store ?? '').toLowerCase();
    if (store === 'keyring' || store === 'auto') {
        return { ready: null, message: 'Codex keeps its login in the OS keyring; a deep status check (account read) tells whether it is a ChatGPT login.' };
    }
    return { ready: false, message: `Codex CLI is installed but not logged in (no auth.json in ${auth.path ? auth.path.replace(/[\\/]auth\.json$/, '') : 'its home'}). Run \`codex login\` as the SillyTavern user.` };
}

export async function codexStatus({ deep = false } = {}) {
    const start = Date.now();
    const launch = codexLaunchSpec();
    const version = await codexVersion(launch);
    let server = peekAppServer();
    if (deep && launch) {
        try { server = server?.ready ? server : await getAppServer(); } catch { /* reported via lastStartError */ }
    }
    const home = (server?.alive && server.codexHome) || resolveCodexHome();
    const config = readCodexConfig(home);
    const auth = readCodexAuthSummary(home);
    const api = discoverCodexApiCredentials(null);
    const overflow = overflowProviderOf(config);

    let account = null;
    if (deep && server?.ready) {
        try {
            const res = await server.request('account/read', { refreshToken: false }, { timeoutMs: 15000 });
            const a = res?.account ?? null;
            server.lastAccount = { type: a?.type ?? null, planType: a?.planType ?? null, email: a?.email ?? null, at: Date.now() };
        } catch { /* ignore */ }
    }
    const known = server?.lastAccount ?? null;
    if (known) account = { type: known.type, planType: known.planType ?? null, email: known.email ?? null };
    const rateLimits = deep ? await codexRateLimits({ startServer: false }) : (server?.lastRateLimits ? normaliseRateLimits(server.lastRateLimits) : null);

    // Global AGENTS.md: what the last thread/start reported (still on disk —
    // a file removed since no longer blocks), plus a file check in the home.
    const verifiedSources = Array.isArray(server?.lastInstructionSources) ? server.lastInstructionSources : null;
    const instructionSources = [...new Set([
        ...(verifiedSources ?? []).filter((p) => { try { return existsSync(p); } catch { return false; } }),
        ...globalInstructionFiles(home),
    ])];

    const subscription = subscriptionReadiness({
        launch, account, auth, config, instructionSources, startError: server && !server.alive ? server.lastStartError : null,
    });
    let apiBackend;
    if (api) apiBackend = { ready: true, source: api.source, baseUrl: api.baseUrl };
    else if (launch && overflow) apiBackend = { ready: true, source: `config.toml provider "${overflow}"`, baseUrl: config.providers[overflow]?.base_url ?? null };
    else apiBackend = { ready: null, message: 'No API key in the environment. A key in SillyTavern\'s Custom API key field is only visible per request.' };

    const loggedIn = account ? account.type === 'chatgpt' : (auth.present && auth.mode === 'chatgpt');
    const apiKeyLogin = account ? (account.type === 'apiKey' || account.type === 'apikey') : (auth.present && auth.mode === 'apikey');
    const available = !!launch || !!api;
    const ok = !!launch && subscription.ready !== false;
    let message;
    if (!launch && !api) message = 'Codex CLI not found and no API key set — `npm i -g @openai/codex` then `codex login`, or set OPENAI_API_KEY.';
    else if (subscription.ready === false) message = subscription.message;

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
            mcpServersDisabled: server?.isolation?.mcpServersDisabled ?? config.mcpNames.length,
            pluginsDisabled: server?.isolation?.pluginsDisabled ?? config.pluginNames.length,
            isolationVerified: !!server?.isolation?.verified && !!server?.alive,
            defaultModel: config.model,
        },
        login: { present: auth.present, mode: account?.type ?? auth.mode ?? null, loggedIn, apiKeyLogin, lastRefresh: auth.lastRefresh ?? null },
        account,
        instructionSources,
        instructionSourcesVerified: verifiedSources !== null,
        api: api ? { available: true, source: api.source, baseUrl: api.baseUrl } : { available: false },
        backends: { subscription, api: apiBackend },
        appServer: { running: !!server?.alive, home: server?.codexHome ?? null, lastError: server?.lastStartError ?? null },
        catalogSource: codexCatalogSource(),
        rateLimits,
        message,
        latencyMs: Date.now() - start,
    };
}
