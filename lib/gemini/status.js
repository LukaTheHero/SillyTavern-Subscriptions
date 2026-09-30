// ──────────────────────────────────────────────
// Gemini provider status — agy CLI, billing mode, keys
// ──────────────────────────────────────────────
//
// `ok` means the default backend (subscription: agy on the Google sign-in)
// can run. Whether agy is actually signed in cannot be read without a turn
// (the login lives in the OS keyring), so a found, correctly configured agy
// reports subscription.ready = null ("cannot tell"), not true.

import { agyLaunchSpec, agyVersion, readAntigravitySettings, antigravitySettingsPath, agyBilling, isolationSupport, CHAT_AGENT_NAME, MIN_ISOLATION_VERSION } from './agy.js';
import { discoverGeminiApiCredentials } from './chat.js';
import { geminiCatalogSource } from './models.js';
import { existsSync } from 'node:fs';

const ROUTING_LABELS = {
    'google-sign-in': 'Google sign-in (subscription)',
    'gemini-api-key': 'Gemini API key (pay per token)',
    'api-key via custom base URL': 'API key via custom base URL (pay per token)',
};

export async function geminiStatus() {
    const start = Date.now();
    const launch = agyLaunchSpec();
    const version = await agyVersion(launch);
    const settings = readAntigravitySettings();
    const api = discoverGeminiApiCredentials(null, { settings });
    const billing = agyBilling(settings);
    const isolation = launch ? isolationSupport(version) : { ok: null };

    let subscription;
    if (!launch) subscription = { ready: false, message: 'Antigravity CLI (agy) not found: install it (https://antigravity.google/cli) and run `agy` once to sign in.' };
    else if (billing.subscriptionBlocked) subscription = { ready: false, message: billing.reason };
    else if (isolation.ok === false) subscription = { ready: false, message: isolation.message };
    else subscription = { ready: null, message: 'agy found on the Google sign-in; whether it is signed in shows on the first chat (run `agy` once to sign in).' };

    const apiBackend = api
        ? { ready: true, source: api.source, baseUrl: api.baseUrl }
        : { ready: null, message: 'No Gemini key in the environment or agy settings; one pasted into SillyTavern\'s Custom API key field is only seen per request.' };

    const available = !!launch || !!api;
    const ok = !!launch && subscription.ready !== false;
    let message;
    if (!available) message = 'Antigravity CLI (agy) not found and no Gemini API key set: install agy (https://antigravity.google/cli) and run it once to sign in, or set GEMINI_API_KEY.';
    else if (!ok) message = subscription.message;

    return {
        provider: 'gemini',
        ok,
        available,
        billing: billing.billing,
        backends: { subscription, api: apiBackend },
        cli: launch
            ? {
                found: true,
                path: launch.path,
                source: launch.source,
                version,
                isolation: { agent: CHAT_AGENT_NAME, minVersion: MIN_ISOLATION_VERSION, supported: isolation.ok },
            }
            : { found: false },
        settings: {
            present: !!settings,
            path: existsSync(antigravitySettingsPath()) ? 'present' : 'missing',
            model: settings?.model ?? null,
            modelProvider: billing.modelProvider,
            baseUrl: billing.baseUrl ?? billing.settingsBaseUrl,
            billing: billing.billing,
            overflowOn: billing.subscriptionBlocked,
            routing: ROUTING_LABELS[billing.billing] ?? billing.billing,
        },
        api: api ? { available: true, source: api.source, baseUrl: api.baseUrl } : { available: false },
        catalogSource: geminiCatalogSource(),
        reasoningDisplay: 'agy never streams thoughts; reasoning shows only on the api backend when the endpoint supports it',
        message,
        latencyMs: Date.now() - start,
    };
}
