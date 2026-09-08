// ──────────────────────────────────────────────
// Gemini / Antigravity model catalog
// ──────────────────────────────────────────────
//
// Live from `agy models` (the same list the CLI's own picker shows), cached
// for an hour, with a static snapshot as fallback. Antigravity encodes the
// reasoning effort in the model id (gemini-3.8-flash-high) — the panel's
// effort setting overrides that suffix when set.

import { agyLaunchSpec, agyListModels } from './agy.js';

const TAG = '[subscriptions/gemini]';
const CACHE_TTL_MS = 60 * 60 * 1000;

export const STATIC_GEMINI_MODELS = [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
    { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
    { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)' },
    { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)' },
    { id: 'gemini-3.6-flash-medium', name: 'Gemini 3.6 Flash (Medium)' },
    { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
    { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
];

let cache = { at: 0, source: 'static', models: STATIC_GEMINI_MODELS };

export async function listGeminiModels({ live = true, force = false } = {}) {
    if (!force && Date.now() - cache.at < CACHE_TTL_MS && cache.source !== 'static') return cache.models;
    if (live && agyLaunchSpec()) {
        try {
            const models = await agyListModels();
            if (models?.length) {
                cache = { at: Date.now(), source: 'agy', models };
                return models;
            }
        } catch (err) {
            console.warn(`${TAG} live model list unavailable: ${err instanceof Error ? err.message : err}`);
        }
    }
    cache = { at: Date.now(), source: 'static', models: STATIC_GEMINI_MODELS };
    return STATIC_GEMINI_MODELS;
}

export function geminiCatalogSource() {
    return cache.source;
}

/** Effort encoded in the id (gemini-3.8-flash-high → high). */
export function effortFromModelId(id) {
    const m = String(id ?? '').toLowerCase().match(/-(low|medium|high)$/);
    return m ? m[1] : null;
}

/** Strip the effort suffix (gemini-3.8-flash-high → gemini-3.8-flash). */
export function baseGeminiModel(id) {
    return String(id ?? '').replace(/-(low|medium|high)$/i, '');
}

/**
 * Resolve the agy model id + effort for a request: an explicit effort
 * replaces the id's suffix so `gemini-3.8-flash-high` + effort=low runs as
 * `gemini-3.8-flash-low`.
 */
export function resolveGeminiModel(requested, effortOverride) {
    const raw = String(requested ?? '').trim();
    const inherent = effortFromModelId(raw);
    const effort = effortOverride ?? inherent ?? undefined;
    const base = baseGeminiModel(raw);
    const agyId = effort && inherent ? `${base}-${effort}` : raw;
    return { requested: raw, agyModel: agyId, apiModel: base || raw, effort };
}

export async function geminiModelEntries(opts) {
    const models = await listGeminiModels(opts);
    return models.map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: 'google',
        display_name: m.name,
        context_window: /pro/i.test(m.id) ? 2000000 : 1000000,
        provider: 'gemini',
    }));
}
