// ──────────────────────────────────────────────
// Generic OpenAI-compatible passthrough (direct API / LinkAPI overflow)
// ──────────────────────────────────────────────
//
// Used by the Codex and Gemini providers' "api" backend: the request is sent
// as a proper messages[] array (system + turns — no folding needed), the SSE
// reply is re-emitted through the CompletionWriter so stop sequences and the
// reasoning_content channel behave exactly like the CLI paths.

const IDLE_MS = 120000;

function normalizeBase(baseUrl) {
    let b = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!/\/v\d+$/i.test(b)) b += '/v1';
    return b;
}

function sanitizeMessages(messages) {
    // Keep OpenAI shapes as-is; drop empty assistant/user messages that some relays reject.
    return (messages ?? []).filter((m) => {
        if (!m || !m.role) return false;
        if (typeof m.content === 'string') return m.content.length > 0 || m.role === 'assistant';
        if (Array.isArray(m.content)) return m.content.length > 0;
        return m.tool_calls || m.role === 'assistant';
    });
}

/**
 * @param {object} args
 * @param {string} args.baseUrl e.g. https://api.linkapi.ai or https://api.openai.com/v1
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {object[]} args.messages
 * @param {object} [args.extraBody] provider-specific fields (reasoning_effort, max_tokens, temperature…)
 * @param {import('./completion.js').CompletionWriter} args.writer
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.tag] log tag
 */
export async function runOpenAiCompat({ baseUrl, apiKey, model, messages, extraBody = {}, writer, signal, tag = '[subscriptions]' }) {
    const endpoint = `${normalizeBase(baseUrl)}/chat/completions`;
    const body = { model, messages: sanitizeMessages(messages), stream: writer.stream, ...extraBody };
    if (writer.stream) body.stream_options = { include_usage: true };

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let idleTimer = null;
    const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { console.warn(`${tag} upstream idle for ${IDLE_MS}ms — aborting`); ac.abort(); }, IDLE_MS);
        idleTimer.unref?.();
    };

    try {
        armIdle();
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, Accept: writer.stream ? 'text/event-stream' : 'application/json' },
            body: JSON.stringify(body),
            signal: ac.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            const err = new Error(`Upstream HTTP ${response.status}${text ? ': ' + text.slice(0, 500) : ''}`);
            err.httpStatus = response.status;
            throw err;
        }

        if (!writer.stream) {
            const data = await response.json();
            const choice = data?.choices?.[0];
            const content = choice?.message?.content ?? '';
            const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';
            if (reasoning) writer.pushReasoning(reasoning, { isDelta: false });
            if (typeof content === 'string') writer.pushText(content);
            writer.flushTail();
            writer.finish({ usage: data?.usage ?? null, finishReason: choice?.finish_reason ?? 'stop' });
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let usage = null;
        let finishReason = null;
        outer:
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const raw of lines) {
                const line = raw.trim();
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') break outer;
                let json;
                try { json = JSON.parse(payload); } catch { continue; }
                if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
                if (json.usage) usage = json.usage;
                const choice = json.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta ?? {};
                const reasoning = delta.reasoning_content ?? delta.reasoning;
                if (typeof reasoning === 'string' && reasoning) writer.pushReasoning(reasoning);
                if (typeof delta.content === 'string' && delta.content) {
                    if (writer.pushText(delta.content)) { ac.abort(); break outer; }
                }
                if (choice.finish_reason) finishReason = choice.finish_reason;
            }
        }
        writer.flushTail();
        writer.finish({ usage, finishReason: writer.stopMatched ? 'stop' : (finishReason ?? 'stop') });
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        signal?.removeEventListener('abort', onAbort);
    }
}
