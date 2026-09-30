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
// Account isolation (subscription): with a full login the CLI adds the
// account's email to every prompt — from its account record, and it fetches
// the profile itself when that record is missing (verified live: pointing only
// the config dir elsewhere is NOT enough). With a bare OAuth token in
// CLAUDE_CODE_OAUTH_TOKEN it has no profile and adds nothing. So the
// subprocess gets empty plugin-owned config + secure-storage dirs and the
// login's current access token (read from the credentials file or the macOS
// Keychain item, refreshed by the plugin — the CLI cannot refresh an env
// token). When no usable token exists the request fails with instructions;
// it never silently falls back to a mode that leaks the email.
// ST_SUBSCRIPTIONS_CLAUDE_ISOLATE_ACCOUNT=0 opts out (the CLI then uses its own
// login store and adds the email). Either way chat.js verifies, before the
// prompt is sent, that the CLI authenticated with the subscription login.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { bearerFromRequest, isAnthropicApiKey } from './env.js';
import { apiModeConfigDir, subscriptionConfigDir } from './session-store.js';
import { subscriptionAccessToken } from './oauth.js';
import { envFlag } from '../common/platform.js';
import { isForeignKey } from '../common/keys.js';

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
        // A key that is clearly another vendor's (the field is shared) is ignored.
        ['api-key-field', isForeignKey('claude', bearerFromRequest(req)) ? '' : bearerFromRequest(req)],
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

/**
 * Complete a subscription auth plan with the account-isolation hand-off.
 * @returns {Promise<{ mode: 'subscription', isolated: boolean, configDir?: string, secureStorageDir?: string }>}
 */
export async function prepareSubscriptionAuth() {
    if (!envFlag('ST_SUBSCRIPTIONS_CLAUDE_ISOLATE_ACCOUNT', true)) return { mode: 'subscription', isolated: false };
    let result;
    try {
        result = await subscriptionAccessToken();
    } catch (err) {
        result = { reason: err instanceof Error ? err.message : String(err) };
    }
    if (result?.login?.accessToken) {
        return { mode: 'subscription', isolated: true, oauthToken: result.login.accessToken, configDir: subscriptionConfigDir(), tokenSource: result.login.source };
    }
    throw isolationError(result?.reason);
}

function isolationError(reason) {
    const why = {
        'keychain-expired': 'the login token in the macOS Keychain has expired (the plugin does not write the Keychain)',
        expired: 'the login token has expired and could not be refreshed',
        unreadable: 'no Claude login could be read (not logged in, or stored where the plugin cannot read it)',
    }[reason] ?? `the login could not be read (${reason ?? 'unknown'})`;
    const err = new Error(
        `Claude login unavailable: ${why}. The plugin needs it to keep your account email out of prompts. ` +
        'Fix: run `claude` once on the SillyTavern host (refreshes the login) or `claude auth login`; on macOS or a ' +
        'headless host, `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for SillyTavern (a long-lived token). ' +
        'Or set ST_SUBSCRIPTIONS_CLAUDE_ISOLATE_ACCOUNT=0 to let the CLI use its own login (it then adds your account email to prompts).',
    );
    err.httpStatus = 401;
    err.noRetry = true;
    err.sdkErrorText = 'isolation-login-unavailable';
    return err;
}

/** Non-secret description of the API credential situation for /status. */
export function apiCredentialSummary() {
    const api = discoverApiCredentials(null);
    if (!api) return { available: false };
    return { available: true, source: api.source, baseUrl: api.baseUrl ?? 'https://api.anthropic.com', kind: api.apiKey ? 'anthropic-key' : 'bearer-token' };
}
