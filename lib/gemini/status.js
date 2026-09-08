// ──────────────────────────────────────────────
// Gemini provider status — agy CLI, account routing, keys
// ──────────────────────────────────────────────

import { agyLaunchSpec, agyVersion, readAntigravitySettings, antigravitySettingsPath } from './agy.js';
import { discoverGeminiApiCredentials } from './chat.js';
import { geminiCatalogSource } from './models.js';
import { existsSync } from 'node:fs';

export async function geminiStatus() {
    const start = Date.now();
    const launch = agyLaunchSpec();
    const version = await agyVersion(launch);
    const settings = readAntigravitySettings();
    const api = discoverGeminiApiCredentials(null);
    const provider = settings?.modelProvider ?? null;
    const baseUrl = settings?.env?.GOOGLE_GEMINI_BASE_URL ?? null;
    const overflowOn = !!(provider && provider !== 'google') || !!baseUrl;
    const available = !!launch || !!api;
    let message;
    if (!launch && !api) message = 'Antigravity CLI (agy) not found and no Gemini API key set — install agy (https://antigravity.google/cli) and run it once to sign in, or set GEMINI_API_KEY.';
    return {
        provider: 'gemini',
        ok: available,
        available,
        cli: launch ? { found: true, path: launch.path, source: launch.source, version } : { found: false },
        settings: {
            present: !!settings,
            path: existsSync(antigravitySettingsPath()) ? 'present' : 'missing',
            model: settings?.model ?? null,
            modelProvider: provider,
            baseUrl,
            overflowOn,
            routing: overflowOn ? `relay (${baseUrl ?? provider})` : 'google-subscription',
        },
        api: api ? { available: true, source: api.source, baseUrl: api.baseUrl } : { available: false },
        catalogSource: geminiCatalogSource(),
        reasoningDisplay: 'agy never streams thoughts; reasoning shows only on the api backend when the relay supports it',
        message,
        latencyMs: Date.now() - start,
    };
}
