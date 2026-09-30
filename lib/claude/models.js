// ──────────────────────────────────────────────
// Claude model catalog + request parsing
// ──────────────────────────────────────────────
//
// The catalog mirrors the model table baked into the Claude Code CLI that the
// Agent SDK bundles (2.1.285): context window, which thinking modes a model
// accepts and which effort levels it takes. The CLI does the final request
// shaping, but knowing the same facts here lets the plugin log what will
// really happen, clamp effort instead of risking a 400, and label the picker.
//
// Context windows:
//   • "native 1M" models (Fable, Opus 4.7+, Sonnet 5+) run with a 1M window by
//     default — no separate variant. A legacy `…[1m]` id (saved in an older
//     SillyTavern chat) resolves to the plain model.
//   • Older 200k models that support the 1M beta (Opus 4.6, Sonnet 4.6) keep
//     an explicit "(1M context)" picker entry suffixed `[1m]`. Such a request
//     passes the CLI's tier alias with the suffix (`opus[1m]`) and pins the
//     tier's concrete version via ANTHROPIC_DEFAULT_<TIER>_MODEL — the same
//     way the CLI's own "/model … [1m]" entries resolve. 1M on those needs
//     Extra Usage on some plans; failures fall back to the base model with a
//     one-hour probe cooldown (see chat.js).
//
// Thinking families (what the Messages API accepts for the model):
//   always   — thinking cannot be turned off; adaptive only (Fable, Opus 5.5,
//              Sonnet 5.5). "Off" is ignored there.
//   adaptive — adaptive on-mode, can be disabled; fixed budgets are rejected
//              (Opus 4.7/4.8/5, Sonnet 5).
//   hybrid   — adaptive or a fixed budget (Opus 4.6, Sonnet 4.6).
//   budget   — fixed budget only, >= 1024 tokens (Opus 4.5, Sonnet 4.5, Haiku 4.5).

const TIER_ENV = {
    fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

// Canonical tier defaults — pinned under the request-specific pin so the CLI's
// bundled (possibly stale) defaults never decide a tier we didn't pin, and the
// target of bare aliases ("opus", "sonnet[1m]") sent by hand-configured clients.
export const CANONICAL_TIER_MODELS = {
    fable: 'claude-fable-5-1',
    opus: 'claude-opus-5-5',
    sonnet: 'claude-sonnet-5-5',
    haiku: 'claude-haiku-4-5',
};

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALL_EFFORTS = EFFORT_LEVELS;
const NO_XHIGH = ['low', 'medium', 'high', 'max'];

const M = 1_000_000;
const K200 = 200_000;

export const CLAUDE_MODELS = [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tier: 'opus', context: M, native1m: true, thinking: 'always', efforts: ALL_EFFORTS, defaultEffort: 'medium' },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'fable', context: M, native1m: true, thinking: 'always', efforts: ALL_EFFORTS, defaultEffort: 'high' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tier: 'sonnet', context: M, native1m: true, thinking: 'always', efforts: ALL_EFFORTS, defaultEffort: 'medium' },
    { id: 'claude-opus-5', name: 'Claude Opus 5', tier: 'opus', context: M, native1m: true, thinking: 'adaptive', efforts: ALL_EFFORTS, defaultEffort: 'high' },
    { id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'fable', context: M, native1m: true, thinking: 'always', efforts: ALL_EFFORTS, defaultEffort: 'high' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', tier: 'sonnet', context: M, native1m: true, thinking: 'adaptive', efforts: ALL_EFFORTS, defaultEffort: 'high' },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'opus', context: M, native1m: true, thinking: 'adaptive', efforts: ALL_EFFORTS, defaultEffort: 'high' },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'opus', context: M, native1m: true, thinking: 'adaptive', efforts: ALL_EFFORTS, defaultEffort: 'xhigh' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'opus', context: K200, oneMVariant: true, thinking: 'hybrid', efforts: NO_XHIGH, defaultEffort: 'high' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'sonnet', context: K200, oneMVariant: true, thinking: 'hybrid', efforts: NO_XHIGH, defaultEffort: 'high' },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', tier: 'opus', context: K200, thinking: 'budget', efforts: [], defaultEffort: null },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tier: 'sonnet', context: K200, thinking: 'budget', efforts: [], defaultEffort: null },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'haiku', context: K200, thinking: 'budget', efforts: [], defaultEffort: null },
];

const ONE_M_SUFFIX = '[1m]';
const BARE_ALIAS_RE = /^(opus|sonnet|haiku|fable)$/;

function catalogEntry(baseId) {
    const raw = String(baseId).toLowerCase();
    const normalized = raw.replace(/\./g, '-');
    return CLAUDE_MODELS.find((m) => m.id === raw || m.id === normalized) || null;
}

/** Tier guess for model IDs not in the catalog (forward compatibility). */
function guessTier(id) {
    const s = String(id).toLowerCase();
    if (s.includes('fable') || s.includes('mythos')) return 'fable';
    if (s.includes('opus')) return 'opus';
    if (s.includes('haiku')) return 'haiku';
    return 'sonnet';
}

/**
 * Thinking family for ids outside the catalog: newer Fable/Mythos and every
 * Opus ≥ 4.7 / Sonnet ≥ 5 is adaptive-native; anything else is treated as a
 * budget model (the CLI converts adaptive → budget there anyway).
 */
function guessThinking(id) {
    const s = String(id).toLowerCase();
    if (s.includes('fable') || s.includes('mythos')) return 'always';
    if (/claude-opus-(?:4-(?:[7-9]|\d{2,})|[5-9]|\d{2,})/.test(s)) return 'adaptive';
    if (/claude-sonnet-(?:[5-9]|\d{2,})/.test(s)) return 'adaptive';
    return 'budget';
}

/** Always-thinking or adaptive-native family (no fixed thinking budgets). */
export function isAdaptiveOnlyModel(id) {
    const s = String(id).toLowerCase().replace(/\[1m\]$/, '');
    const entry = catalogEntry(s);
    const family = entry ? entry.thinking : guessThinking(s);
    return family === 'always' || family === 'adaptive';
}

/** Canonical form of a served/requested model id: no [1m], date stamp or -fast suffix. */
export function canonicalClaudeModelId(id) {
    return String(id ?? '')
        .trim()
        .toLowerCase()
        .replace(/\[1m\]$/, '')
        .replace(/\./g, '-')
        .replace(/-fast$/, '')
        .replace(/-\d{8}(?:-v\d+(?::\d+)?)?$/, '');
}

/**
 * Parse the model string from the request into everything the SDK call needs.
 * @param {string} requested e.g. 'claude-opus-5-5', 'claude-sonnet-4-6[1m]', 'opus'
 */
export function parseClaudeModel(requested) {
    const raw = String(requested).trim();
    const lower = raw.toLowerCase();
    const wants1m = lower.endsWith(ONE_M_SUFFIX);
    let rawBaseId = wants1m ? raw.slice(0, -ONE_M_SUFFIX.length) : raw;
    // Bare tier aliases resolve to the canonical model of the tier.
    const bare = rawBaseId.toLowerCase().match(BARE_ALIAS_RE);
    if (bare) rawBaseId = CANONICAL_TIER_MODELS[bare[1]];

    const entry = catalogEntry(rawBaseId);
    // Unknown ids keep their spelling, except the dotted form of a version
    // ("claude-opus-5.5") which the API only knows dashed.
    const baseId = entry ? entry.id : (/^claude-/i.test(rawBaseId) ? rawBaseId.toLowerCase().replace(/\./g, '-') : rawBaseId);
    const tier = entry ? entry.tier : guessTier(baseId);
    const thinking = entry ? entry.thinking : guessThinking(baseId);

    // Canonical pins for every tier first, then override the requested tier
    // with the exact version the user picked.
    const envPins = {};
    for (const [t, envVar] of Object.entries(TIER_ENV)) envPins[envVar] = CANONICAL_TIER_MODELS[t];
    envPins[TIER_ENV[tier]] = baseId;

    // [1m] only means something for 200k models with a 1M beta; native-1M
    // models already run with the full window, and unknown ids keep the
    // historical alias route.
    const oneM = wants1m && (entry ? !!entry.oneMVariant : true);
    const sdkModel = oneM ? `${tier}${ONE_M_SUFFIX}` : baseId;
    const context = entry ? (oneM ? M : entry.context) : (oneM ? M : K200);

    return {
        requested: raw,
        baseId,
        name: entry ? entry.name : null,
        tier,
        oneM,
        sdkModel,
        envPins,
        thinking,
        adaptiveOnly: thinking === 'always' || thinking === 'adaptive',
        efforts: entry ? entry.efforts : ALL_EFFORTS,
        known: !!entry,
        context,
    };
}

/**
 * Clamp a requested effort to what the model accepts: unsupported levels step
 * down to the nearest supported one; models without effort get none.
 */
export function clampClaudeEffort(modelInfo, effort) {
    if (!effort) return undefined;
    const allowed = modelInfo?.efforts ?? ALL_EFFORTS;
    if (!allowed.length) return undefined;
    if (allowed.includes(effort)) return effort;
    const want = EFFORT_LEVELS.indexOf(effort);
    for (let i = want; i >= 0; i--) if (allowed.includes(EFFORT_LEVELS[i])) return EFFORT_LEVELS[i];
    return allowed[0];
}

// ── Extra Usage / 1M cooldown (Meridian's probe pattern) ──

const EXTRA_USAGE_RETRY_MS = 60 * 60 * 1000;
let extraUsageUnavailableAt = 0;

export function recordExtendedContextUnavailable() {
    extraUsageUnavailableAt = Date.now();
}

export function isExtendedContextKnownUnavailable() {
    return extraUsageUnavailableAt > 0 && Date.now() - extraUsageUnavailableAt < EXTRA_USAGE_RETRY_MS;
}

export function resetExtendedContextUnavailable() {
    extraUsageUnavailableAt = 0;
}

/** OpenAI-style model list entries (plus explicit 1M variants for 200k models). */
export function listClaudeModels() {
    const data = [];
    for (const m of CLAUDE_MODELS) {
        const common = {
            object: 'model',
            created: 0,
            owned_by: 'anthropic',
            provider: 'claude',
            thinking: m.thinking,
            reasoning_efforts: m.efforts,
            default_effort: m.defaultEffort,
        };
        data.push({ id: m.id, display_name: m.name, context_window: m.context, ...common });
        if (m.oneMVariant) {
            data.push({ id: `${m.id}${ONE_M_SUFFIX}`, display_name: `${m.name} (1M context)`, context_window: M, ...common });
        }
    }
    return data;
}
