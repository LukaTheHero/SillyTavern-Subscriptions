// ──────────────────────────────────────────────
// System prompt assembly — roleplay-first
// ──────────────────────────────────────────────
//
// The SDK's behaviour matrix (verified against @anthropic-ai/claude-agent-sdk
// 0.2.141 and 0.3.263):
//
//   • systemPrompt OMITTED          → CLI default = the FULL coding system
//                                     prompt. Never acceptable for RP.
//   • systemPrompt: '<string>'      → REPLACES the coding preamble entirely.
//                                     Pure client prompt (character card,
//                                     persona, world info). The RP path.
//   • systemPrompt: ''              → explicitly empty system prompt.
//   • { type:'preset', preset:'claude_code', append } → coding preamble kept,
//                                     client text appended. Fixes model
//                                     self-identification at the cost of a
//                                     coding-assistant flavour. Opt-in
//                                     "identity mode".

/**
 * @param {string|undefined} clientSystemPrompt joined system-message text from the request
 * @param {boolean} identityMode
 */
export function buildSystemPrompt(clientSystemPrompt, identityMode) {
    if (identityMode) {
        return clientSystemPrompt
            ? { type: 'preset', preset: 'claude_code', append: clientSystemPrompt }
            : { type: 'preset', preset: 'claude_code' };
    }
    return clientSystemPrompt ?? '';
}
