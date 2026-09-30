// ──────────────────────────────────────────────
// Claude provider status — SDK/CLI availability + credential health
// ──────────────────────────────────────────────
//
// `ok` = the default backend (the subscription) can be used: the SDK loads,
// a Claude Code CLI exists, and a login is present or may exist in a store the
// plugin cannot read (macOS Keychain, Windows Credential Manager). An API key
// alone never makes Claude "ready" — the default backend never bills it.

import { detectSdkVersion, claudeCliSummary, sdkUpdateNeeded } from './sdk-loader.js';
import { credentialSummary, latestRateLimit } from './oauth.js';
import { apiCredentialSummary } from './auth.js';

export async function claudeStatus() {
    const start = Date.now();
    const [credential, api] = [await credentialSummary(), apiCredentialSummary()];
    let sdk = 'unavailable';
    let message;
    try {
        await import('@anthropic-ai/claude-agent-sdk');
        sdk = 'loaded';
    } catch (err) {
        message = err instanceof Error ? err.message : String(err);
    }
    const cli = claudeCliSummary();
    const available = sdk === 'loaded' && !!cli.path;

    const subscriptionReady = !available ? false : (credential.present === true ? true : (credential.present === 'unknown' ? null : false));
    const backends = {
        subscription: {
            ready: subscriptionReady,
            message: credential.present === true
                ? `${credential.subscriptionType ?? 'unknown'} login${credential.expired ? ' (token expired — refreshed on the next chat)' : ''}`
                : (credential.present === 'unknown'
                    ? 'login not readable by the plugin (Keychain / Credential Manager) — chat will tell'
                    : 'no login — run `claude auth login` (or `claude setup-token` on a headless host)'),
        },
        api: api.available
            ? { ready: true, source: api.source, baseUrl: api.baseUrl }
            : { ready: null, message: 'no key found in the environment (a key in SillyTavern\'s Custom API key field is used per request)' },
    };

    const stale = sdkUpdateNeeded();
    if (!message && stale) {
        message = `Plugin dependencies are out of date (Agent SDK ${stale.installed}, this version needs ${stale.required}): run \`npm install\` in plugins/SillyTavern-Subscriptions and restart SillyTavern — newer Claude models need it.`;
    }
    if (!message) {
        if (!cli.path) {
            message = cli.reason === 'android-unsupported'
                ? 'Claude Code has no native Android build — run SillyTavern inside proot-distro (Debian/Ubuntu), or set ST_SUBSCRIPTIONS_CLAUDE_PATH to a working binary.'
                : 'No Claude Code CLI found — reinstall the plugin deps without --omit=optional (npm install --include=optional), or set ST_SUBSCRIPTIONS_CLAUDE_PATH.';
        } else if (credential.present === false) {
            message = 'No Claude login found — run `claude auth login` on the SillyTavern host (or `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN).';
        }
    }

    return {
        provider: 'claude',
        ok: available && subscriptionReady !== false,
        available,
        sdk,
        sdkVersion: detectSdkVersion(),
        cli,
        credential,
        api,
        backends,
        rateLimit: latestRateLimit(),
        message,
        note: 'Credential expiry is advisory — the plugin refreshes a stale token before the next chat.',
        latencyMs: Date.now() - start,
    };
}
