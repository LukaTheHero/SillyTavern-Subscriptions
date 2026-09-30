// ──────────────────────────────────────────────
// System prompt assembly — roleplay-first
// ──────────────────────────────────────────────
//
// The SDK's behaviour matrix (verified against @anthropic-ai/claude-agent-sdk
// 0.2.141 → 0.3.285):
//
//   • systemPrompt OMITTED          → CLI default = the FULL coding system
//                                     prompt. Never acceptable for RP.
//   • a custom prompt               → REPLACES the coding preamble. The CLI
//                                     still puts its one-line agent identity
//                                     block first (required for subscription
//                                     billing) and adds a short environment
//                                     note (working dir, platform, shell, OS,
//                                     model name, date) that
//                                     no subscription-compatible switch
//                                     removes. The RP path.
//   • { type:'preset', preset:'claude_code' } → the coding preamble plus
//                                     per-user dynamic sections (working dir,
//                                     git status…). Never used.
//
// The prompt is passed as { type:'custom', snapshot:false } so the CLI never
// records it into a session and reuses a stale copy: SillyTavern rebuilds the
// system prompt every request (World Info, Author's Note…).
//
// "Identity mode" prepends one sentence naming the exact model, for cards
// that ask the model who it is — no preamble, no host details.

/**
 * @param {string|undefined} clientSystemPrompt leading system text from the request
 * @param {boolean} identityMode
 * @param {{ baseId?: string, name?: string }} [model]
 */
export function buildSystemPrompt(clientSystemPrompt, identityMode, model = {}) {
    let text = clientSystemPrompt ?? '';
    if (identityMode) {
        const who = model.name ? `${model.name} (model id ${model.baseId})` : `Claude (model id ${model.baseId ?? 'unknown'})`;
        const line = `You are ${who}, a model made by Anthropic.`;
        text = text ? `${line}\n\n${text}` : line;
    }
    return { type: 'custom', prompt: text, snapshot: false };
}
