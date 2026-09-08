// ──────────────────────────────────────────────
// OpenAI chat-completions wire helpers (SSE + JSON)
// ──────────────────────────────────────────────
//
// Thinking deltas are emitted as `delta.reasoning_content` — the DeepSeek
// convention SillyTavern parses natively for Custom sources (its streaming
// reader lifts choices[0].delta.reasoning_content into the collapsible
// reasoning block, gated by the user's "Show model thoughts" setting). The
// non-streaming shape mirrors it via message.reasoning_content.

export function makeCompletionId(prefix = 'chatcmpl') {
    return `${prefix}-` + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeDone(res) {
    res.write('data: [DONE]\n\n');
}

export function chunkShell(id, created, model) {
    return { id, object: 'chat.completion.chunk', created, model };
}

export function roleChunk(shell) {
    return { ...shell, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
}

export function contentChunk(shell, text) {
    return { ...shell, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

export function reasoningChunk(shell, text) {
    return { ...shell, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] };
}

export function finishChunk(shell, finishReason, usage) {
    const chunk = { ...shell, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
    if (usage) chunk.usage = usage;
    return chunk;
}

export function errorEvent(message, type = 'server_error') {
    return { error: { message, type } };
}

/**
 * Normalise provider usage into OpenAI usage, keeping cache accounting visible.
 * Accepts { input, output, cacheRead, cacheCreate, reasoning } (all optional).
 */
export function toOpenAiUsage({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0, reasoning = 0 } = {}) {
    const prompt = input + cacheRead + cacheCreate;
    const usage = {
        prompt_tokens: prompt,
        completion_tokens: output,
        total_tokens: prompt + output,
    };
    if (cacheRead || cacheCreate) {
        usage.prompt_tokens_details = { cached_tokens: cacheRead, cache_creation_tokens: cacheCreate };
    }
    if (reasoning) {
        usage.completion_tokens_details = { reasoning_tokens: reasoning };
    }
    return usage;
}
