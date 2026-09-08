// ──────────────────────────────────────────────
// Claude backend selection: subscription vs API key
// ──────────────────────────────────────────────
//
// backend = subscription  → OAuth login (claude login), bills the Pro/Max plan.
// backend = api           → an API key (or bearer token for an Anthropic-
//                           compatible relay) plus optional base URL. Sources,
//                           in order: the Custom API key field in SillyTavern,
//                           ST_SUBSCRIPTIONS_CLAUDE_API_KEY, the process env
//                           (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY), the env
//                           block of ~/.claude/settings.json. Base URL:
//                           ST_SUBSCRIPTIONS_CLAUDE_BASE_URL, ANTHROPIC_BASE_URL
//                           (env, then settings.json), else api.anthropic.com.
// backend = auto          → subscription; an sk-ant-* key in the API-key field
//                           switches to api (explicit intent), and a quota-
//                           exhausted subscription retries on api when a key
//                           is available.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { bearerFromRequest, isAnthropicApiKey } from './env.js';
import { apiModeConfigDir } from './session-store.js';
import { credentialSummary } from './oauth.js';

function settingsEnvBlock() {
    try {
        const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
        const s = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
        return s?.env && typeof s.env === 'object' ? s.env : {};
    } catch {
        return {};
    }
}

/** Find API credentials without spending them. Returns null when none exist. */
export function discoverApiCredentials(req) {
    const fromHeader = bearerFromRequest(req);
    const envBlock = settingsEnvBlock();
    const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim().length > 0)?.trim();

    const key = pick(fromHeader, process.env.ST_SUBSCRIPTIONS_CLAUDE_API_KEY,
        process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY,
        envBlock.ANTHROPIC_AUTH_TOKEN, envBlock.ANTHROPIC_API_KEY);
    if (!key) return null;

    let source = 'claude-settings.json';
    if (key === fromHeader) source = 'api-key-field';
    else if (key === process.env.ST_SUBSCRIPTIONS_CLAUDE_API_KEY) source = 'ST_SUBSCRIPTIONS_CLAUDE_API_KEY';
    else if (key === process.env.ANTHROPIC_AUTH_TOKEN || key === process.env.ANTHROPIC_API_KEY) source = 'process-env';

    // Explicit plugin base URL wins; otherwise the same place the key came from
    // decides (a settings.json key pairs with the settings.json base URL).
    let baseUrl = pick(process.env.ST_SUBSCRIPTIONS_CLAUDE_BASE_URL);
    if (!baseUrl) {
        baseUrl = source === 'claude-settings.json'
            ? pick(envBlock.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL)
            : pick(process.env.ANTHROPIC_BASE_URL, envBlock.ANTHROPIC_BASE_URL);
    }

    return {
        mode: 'api',
        baseUrl: baseUrl || undefined,
        // sk-ant-* → x-api-key auth; anything else → bearer token (relays).
        apiKey: isAnthropicApiKey(key) ? key : undefined,
        authToken: isAnthropicApiKey(key) ? undefined : key,
        configDir: apiModeConfigDir(),
        source,
    };
}

/**
 * @param {'auto'|'subscription'|'api'} backend
 * @returns {{ auth: object, fallback: object|null, chosen: string }}
 *   auth     — what to use now
 *   fallback — API auth to retry with when the subscription quota is exhausted (auto only)
 */
export function chooseClaudeAuth(backend, req) {
    const api = discoverApiCredentials(req);
    if (backend === 'api') {
        if (!api) {
            const err = new Error(
                'Claude backend "api" selected but no API key was found. Put the key in SillyTavern\'s Custom API key ' +
                'field, or set ST_SUBSCRIPTIONS_CLAUDE_API_KEY (+ ST_SUBSCRIPTIONS_CLAUDE_BASE_URL for an Anthropic-compatible ' +
                'relay) or ANTHROPIC_API_KEY in SillyTavern\'s environment.',
            );
            err.httpStatus = 400;
            throw err;
        }
        return { auth: api, fallback: null, chosen: `api (${api.source})` };
    }
    if (backend === 'subscription') {
        return { auth: { mode: 'subscription' }, fallback: null, chosen: 'subscription' };
    }
    // auto
    if (api && api.source === 'api-key-field' && api.apiKey) {
        return { auth: api, fallback: null, chosen: 'api (sk-ant key in API-key field)' };
    }
    // No subscription login on this host (never ran `claude login`, or it was
    // moved aside) but a key exists → the key is the only thing that can work.
    if (api && !credentialSummary().present) {
        return { auth: api, fallback: null, chosen: `api (${api.source}; no subscription login present)` };
    }
    return { auth: { mode: 'subscription' }, fallback: api, chosen: api ? 'subscription (api overflow armed)' : 'subscription' };
}

/** Non-secret description of the API credential situation for /status. */
export function apiCredentialSummary() {
    const api = discoverApiCredentials(null);
    if (!api) return { available: false };
    return { available: true, source: api.source, baseUrl: api.baseUrl ?? 'https://api.anthropic.com', kind: api.apiKey ? 'anthropic-key' : 'bearer-token' };
}
