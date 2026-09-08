// ──────────────────────────────────────────────
// Codex / ChatGPT model catalog
// ──────────────────────────────────────────────
//
// The set of models a ChatGPT account may use changes every few weeks, so the
// list is LIVE: `model/list` from the app-server (the same list `codex` shows
// in its own picker), falling back to the CLI's models_cache.json, and only
// then to a static snapshot. Effort levels and service tiers come from the
// same source so the panel never offers an effort the model rejects.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { peekAppServer, getAppServer, codexLaunchSpec } from './app-server.js';
import { resolveCodexHome } from './config.js';

const TAG = '[subscriptions/codex]';
const CACHE_TTL_MS = 10 * 60 * 1000;

export const STATIC_CODEX_MODELS = [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', tiers: ['priority'], context: 272000 },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', tiers: ['priority', 'ultrafast'], context: 272000 },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium', tiers: ['priority'], context: 272000 },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', tiers: ['priority'], context: 272000 },
    { id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', tiers: ['priority'], context: 272000 },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', tiers: [], context: 272000 },
    { id: 'gpt-5.2', name: 'GPT-5.2', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', tiers: [], context: 272000 },
];

let cache = { at: 0, source: 'static', models: STATIC_CODEX_MODELS };

function fromAppServerList(data) {
    const out = [];
    for (const m of data ?? []) {
        if (!m || m.hidden) continue;
        const id = m.model || m.id;
        if (!id) continue;
        out.push({
            id,
            name: m.displayName || id,
            efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter(Boolean),
            defaultEffort: m.defaultReasoningEffort || 'medium',
            tiers: (m.serviceTiers ?? []).map((t) => t.id).filter(Boolean),
            context: 272000,
            isDefault: !!m.isDefault,
        });
    }
    return out;
}

function fromModelsCache(home) {
    try {
        const raw = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'));
        const out = [];
        for (const m of raw.models ?? []) {
            if (!m?.slug || m.visibility === 'hide') continue;
            out.push({
                id: m.slug,
                name: m.display_name || m.slug,
                efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean),
                defaultEffort: m.default_reasoning_level || 'medium',
                tiers: (m.service_tiers ?? []).map((t) => t.id).filter(Boolean),
                context: m.context_window || 272000,
            });
        }
        return out.length ? out : null;
    } catch {
        return null;
    }
}

/**
 * Current catalog. `live` = try the app-server (starts it if the CLI exists).
 */
export async function listCodexModels({ live = true, force = false } = {}) {
    if (!force && Date.now() - cache.at < CACHE_TTL_MS && cache.source !== 'static') return cache.models;

    if (live && codexLaunchSpec()) {
        try {
            const server = peekAppServer()?.alive ? peekAppServer() : await getAppServer();
            const res = await server.request('model/list', { includeHidden: false }, { timeoutMs: 20000 });
            const models = fromAppServerList(res?.data ?? res?.models ?? []);
            if (models.length) {
                cache = { at: Date.now(), source: 'app-server', models };
                return models;
            }
        } catch (err) {
            console.warn(`${TAG} live model list unavailable: ${err instanceof Error ? err.message : err}`);
        }
    }

    const cached = fromModelsCache(peekAppServer()?.codexHome ?? resolveCodexHome());
    if (cached) {
        cache = { at: Date.now(), source: 'models_cache.json', models: cached };
        return cached;
    }
    cache = { at: Date.now(), source: 'static', models: STATIC_CODEX_MODELS };
    return STATIC_CODEX_MODELS;
}

export function codexCatalogSource() {
    return cache.source;
}

/** Catalog entry for a model id (synthesised for unknown ids). */
export function codexModelInfo(id) {
    const raw = String(id ?? '').trim();
    const found = cache.models.find((m) => m.id.toLowerCase() === raw.toLowerCase())
        ?? STATIC_CODEX_MODELS.find((m) => m.id.toLowerCase() === raw.toLowerCase());
    if (found) return found;
    return { id: raw, name: raw, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', tiers: [], context: 272000, unknown: true };
}

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Clamp a requested effort to what the model supports (nearest lower level). */
export function clampEffort(model, effort) {
    if (!effort) return undefined;
    const info = codexModelInfo(model);
    if (!info.efforts?.length || info.efforts.includes(effort)) return effort;
    const want = EFFORT_ORDER.indexOf(effort);
    let best = null;
    for (const e of info.efforts) {
        const i = EFFORT_ORDER.indexOf(e);
        if (i <= want && (best === null || i > EFFORT_ORDER.indexOf(best))) best = e;
    }
    return best ?? info.efforts[info.efforts.length - 1];
}

/** OpenAI-style list entries. */
export async function codexModelEntries(opts) {
    const models = await listCodexModels(opts);
    return models.map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: 'openai',
        display_name: m.name,
        context_window: m.context,
        provider: 'codex',
        reasoning_efforts: m.efforts,
        default_effort: m.defaultEffort,
        service_tiers: m.tiers,
    }));
}
