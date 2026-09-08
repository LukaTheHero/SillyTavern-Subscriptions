// ──────────────────────────────────────────────
// Claude provider status — SDK availability + credential health
// ──────────────────────────────────────────────

import { detectSdkVersion, claudeCliSummary } from './sdk-loader.js';
import { credentialSummary, latestRateLimit } from './oauth.js';
import { apiCredentialSummary } from './auth.js';

export async function claudeStatus() {
    const start = Date.now();
    const credential = credentialSummary();
    const api = apiCredentialSummary();
    let sdk = 'unavailable';
    let message;
    try {
        await import('@anthropic-ai/claude-agent-sdk');
        sdk = 'loaded';
    } catch (err) {
        message = err instanceof Error ? err.message : String(err);
    }
    const cli = claudeCliSummary();
    const ok = sdk === 'loaded' && (credential.present || api.available) && !!cli.path;
    return {
        provider: 'claude',
        ok,
        available: sdk === 'loaded' && !!cli.path,
        sdk,
        sdkVersion: detectSdkVersion(),
        cli,
        credential,
        api,
        rateLimit: latestRateLimit(),
        message: message ?? (!credential.present && !api.available
            ? 'No Claude login found — run `claude login` on the SillyTavern host (or provide an API key).'
            : (!cli.path ? 'No Claude Code CLI found — reinstall the plugin deps without --omit=optional, or set ST_SUBSCRIPTIONS_CLAUDE_PATH.' : undefined)),
        note: 'Credential expiry is advisory — the CLI can refresh a stale token on the next chat.',
        latencyMs: Date.now() - start,
    };
}
