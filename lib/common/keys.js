// ──────────────────────────────────────────────
// Shared API-key field hygiene
// ──────────────────────────────────────────────
//
// SillyTavern sends its ONE Custom API key as the Bearer header of every
// request to this listener, whichever provider serves the model. A key that
// clearly belongs to another vendor must never be sent to this provider's
// endpoint (or a relay configured for it) — it would leak the credential and
// shadow the key the user meant to bill. Generic relay tokens (plain sk-…)
// stay accepted everywhere.

const FOREIGN = {
    claude: /^(sk-proj-|sk-svcacct-|AIza)/i,
    codex: /^(sk-ant-|AIza)/i,
    gemini: /^sk-(ant|proj|svcacct)-/i,
};

/** True when `key` is recognisably another vendor's key for `provider`. */
export function isForeignKey(provider, key) {
    const k = String(key ?? '').trim();
    return !!k && !!FOREIGN[provider]?.test(k);
}
