// ──────────────────────────────────────────────
// Claude backend selection: subscription vs API key
// ──────────────────────────────────────────────
//
// backend = subscription  → the Claude login (claude auth login / setup-token),
//                           bills the Pro/Max plan. Never an API key.
// backend = api           → an API key (or bearer token for an Anthropic-
//                           compatible relay) plus optional base URL. Key
//                           sources, in order: the Custom API key field in
//                           SillyTavern, ST_SUBSCRIPTIONS_CLAUDE_API_KEY, the
//                           process env (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY),
//                           the env block of ~/.claude/settings.json.
//                           Base URL: ST_SUBSCRIPTIONS_CLAUDE_BASE_URL first;
//                           otherwise it pairs with where the key came from
//                           (a settings.json key uses the settings.json base
//                           URL). A genuine sk-ant-* key only ever goes to
//                           Anthropic or an explicitly configured
//                           ANTHROPIC_BASE_URL — never to a relay URL that
//                           merely sits in settings.json for another tool.
// backend = auto          → the subscription, always first. The key is used
//                           for a request only when the subscription window
//                           is exhausted, or rate limiting persists after the
//                           retries (see chat.js). Having a key, or a login
//                           the plugin cannot see, never switches billing.
//
// Account isolation (subscription): the CLI adds the logged-in account's
// email to every prompt from the account record in its config dir. The plugin
// therefore runs the subprocess with an empty plugin-owned CLAUDE_CONFIG_DIR
// and hands the login over as CLAUDE_CODE_OAUTH_TOKEN (refreshed by the
// plugin; the CLI cannot refresh an env token). When no token can be read
// (a Windows Credential Manager store, a locked Keychain) the CLI's own login
// store is used as before. ST_SUBSCRIPTIONS_CLAUDE_ISOLATE_ACCOUNT=0 disables it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { bearerFromRequest, isAnthropicApiKey } from './env.js';
import { apiModeConfigDir, subscriptionConfigDir } from './session-store.js';
import { subscriptionAccessToken } from './oauth.js';
import { envFlag } from '../common/platform.js';

const TAG = '[subscriptions/claude]';

function settingsEnvBlock() {
    try {
        const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
        const s = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
        return s?.env && typeof s.env === 'object' ? s.env : {};
    } catch {
        return {};
    }
}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/** Find API credentials without spending them. Returns null when none exist. */
export function discoverApiCredentials(req) {
    const envBlock = settingsEnvBlock();
    const candidates = [
        ['api-key-field', bearerFromRequest(req)],
        ['ST_SUBSCRIPTIONS_CLAUDE_API_KEY', process.env.ST_SUBSCRIPTIONS_CLAUDE_API_KEY],
        ['process-env', process.env.ANTHROPIC_AUTH_TOKEN],
        ['process-env', process.env.ANTHROPIC_API_KEY],
        ['claude-settings.json', envBlock.ANTHROPIC_AUTH_TOKEN],
        ['claude-settings.json', envBlock.ANTHROPIC_API_KEY],
    ].map(([source, value]) => [source, trimmed(value)]);
    const hit = candidates.find(([, value]) => value);
    if (!hit) return null;
    const [source, key] = hit;
    const anthropicKey = isAnthropicApiKey(key);

    let baseUrl = trimmed(process.env.ST_SUBSCRIPTIONS_CLAUDE_BASE_URL);
    if (!baseUrl) {
        if (source === 'claude-settings.json') {
            baseUrl = trimmed(envBlock.ANTHROPIC_BASE_URL) || trimmed(process.env.ANTHROPIC_BASE_URL);
        } else if (anthropicKey) {
            baseUrl = trimmed(process.env.ANTHROPIC_BASE_URL);
        } else {
            // A relay token pasted into the field / env pairs with the relay URL.
            baseUrl = trimmed(process.env.ANTHROPIC_BASE_URL) || trimmed(envBlock.ANTHROPIC_BASE_URL);
        }
    }

    return {
        mode: 'api',
        baseUrl: baseUrl || undefined,
        // sk-ant-* → x-api-key auth; anything else → bearer token (relays).
        apiKey: anthropicKey ? key : undefined,
        authToken: anthropicKey ? undefined : key,
        configDir: apiModeConfigDir(),
        source,
    };
}

/**
 * @param {'auto'|'subscription'|'api'} backend
 * @returns {{ auth: object, fallback: object|null, chosen: string }}
 *   auth     — what to use now ({ mode: 'subscription' } is completed by prepareSubscriptionAuth)
 *   fallback — API auth to retry with when the subscription quota is exhausted (auto only)
 */
export function chooseClaudeAuth(backend, req) {
    if (backend === 'api') {
        const api = discoverApiCredentials(req);
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
    if (backend === 'auto') {
        const api = discoverApiCredentials(req);
        return { auth: { mode: 'subscription' }, fallback: api, chosen: api ? `subscription (api overflow armed: ${api.source})` : 'subscription' };
    }
    return { auth: { mode: 'subscription' }, fallback: null, chosen: 'subscription' };
}

let warnedNoIsolation = false;

/**
 * Complete a subscription auth plan with the account-isolation handoff.
 * @returns {Promise<{ mode: 'subscription', oauthToken?: string, configDir?: string, isolated: boolean }>}
 */
export async function prepareSubscriptionAuth({ forceRefresh = false } = {}) {
    if (!envFlag('ST_SUBSCRIPTIONS_CLAUDE_ISOLATE_ACCOUNT', true)) return { mode: 'subscription', isolated: false };
    let login = null;
    try {
        login = await subscriptionAccessToken({ forceRefresh });
    } catch { /* fall through */ }
    if (!login?.accessToken) {
        if (!warnedNoIsolation) {
            warnedNoIsolation = true;
            console.warn(`${TAG} could not read the Claude login token directly — using the CLI's own login store (the CLI then adds the account email to prompts).`);
        }
        return { mode: 'subscription', isolated: false };
    }
    return { mode: 'subscription', oauthToken: login.accessToken, configDir: subscriptionConfigDir(), isolated: true, tokenSource: login.source };
}

/** Non-secret description of the API credential situation for /status. */
export function apiCredentialSummary() {
    const api = discoverApiCredentials(null);
    if (!api) return { available: false };
    return { available: true, source: api.source, baseUrl: api.baseUrl ?? 'https://api.anthropic.com', kind: api.apiKey ? 'anthropic-key' : 'bearer-token' };
}
