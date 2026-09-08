// ──────────────────────────────────────────────
// Provider routing — which subscription serves this model?
// ──────────────────────────────────────────────
//
// One endpoint, one model list. Every model id is self-describing, so the
// provider is inferred from it: claude-* → Claude Max (Agent SDK),
// gpt-* / o* / codex-* → ChatGPT/Codex (app-server), gemini-* → Antigravity
// (agy). The listener also mounts per-provider prefixes (/claude/v1, /codex/v1,
// /gemini/v1) whose model lists are filtered to one provider — that is what the
// panel's "Connect: Claude only" scope uses — and a per-request
// `subscriptions.provider` override for unknown ids.

import { PROVIDERS } from './settings.js';

export { PROVIDERS };

export const PROVIDER_LABELS = {
    claude: 'Claude (Anthropic Pro/Max)',
    codex: 'Codex (ChatGPT Plus/Pro)',
    gemini: 'Gemini (Google Antigravity)',
};

/** Infer the provider from a model id, or null when it is not recognisable. */
export function providerForModel(modelId) {
    const id = String(modelId ?? '').trim().toLowerCase();
    if (!id) return null;
    if (id.startsWith('claude') || id.includes('fable') || id.includes('mythos') || /^(opus|sonnet|haiku|fable)(\[1m\])?$/.test(id)) return 'claude';
    if (id.startsWith('gemini') || id.startsWith('google/') || id.startsWith('models/gemini')) return 'gemini';
    if (/^(gpt-|o[1-9]|codex|chatgpt)/.test(id) || id.startsWith('openai/')) return 'codex';
    return null;
}

/**
 * Decide the provider for a request.
 * @param {object} args
 * @param {string} args.model
 * @param {string|null} [args.pathProvider] provider from the URL prefix (/claude/v1 …)
 * @param {string|undefined} [args.settingsProvider] `subscriptions.provider` from the body
 * @returns {{ provider: string|null, reason: string }}
 */
export function resolveProvider({ model, pathProvider = null, settingsProvider }) {
    const byModel = providerForModel(model);
    if (byModel) return { provider: byModel, reason: 'model' };
    if (settingsProvider && PROVIDERS.includes(settingsProvider)) return { provider: settingsProvider, reason: 'settings' };
    if (pathProvider && PROVIDERS.includes(pathProvider)) return { provider: pathProvider, reason: 'path' };
    return { provider: null, reason: 'unknown' };
}

export function isProvider(value) {
    return PROVIDERS.includes(String(value ?? '').toLowerCase());
}
