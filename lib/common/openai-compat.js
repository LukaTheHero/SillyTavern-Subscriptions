// ──────────────────────────────────────────────
// Generic OpenAI-compatible passthrough (direct API / compatible relays)
// ──────────────────────────────────────────────
//
// Used by the Codex and Gemini providers' "api" backend: the request is sent
// as a proper messages[] array (system + turns — no folding needed), the SSE
// reply is re-emitted through the CompletionWriter so stop sequences and the
// reasoning_content channel behave exactly like the CLI paths.
//
// Two timers guard the upstream call:
//   • FIRST_BYTE_MS — until the first streamed chunk (reasoning models can
//     think silently for minutes) or, without streaming, the whole reply.
//     Node's built-in fetch (undici) gives up on its own after 300 s without
//     response headers (and after 300 s between body chunks), so a budget
//     above that could never fire; 290 s keeps our readable message ahead of
//     undici's generic "fetch failed".
//   • IDLE_MS — the longest gap tolerated between two streamed chunks.
// Either one aborts the request with a message that says what happened.

import { onAbort, abortError } from './abort.js';

export const FIRST_BYTE_MS = 290 * 1000;
export const IDLE_MS = 180 * 1000;

const UNDICI_TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** Origin-only base URLs get "/v1"; anything with a path is used verbatim. */
export function normalizeBase(baseUrl) {
    const b = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    try {
        const u = new URL(b);
        if (u.pathname === '' || u.pathname === '/') return b + '/v1';
    } catch { /* not a full URL — leave as-is */ }
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

function hostOf(url) {
    try { return new URL(url).host; } catch { return String(url ?? ''); }
}

const seconds = (ms) => Math.round(ms / 1000);

/** The error message an upstream sent in its body (JSON error.message), else the raw text. */
function upstreamErrorText(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return '';
    try {
        const j = JSON.parse(raw);
        const m = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : null);
        if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 500);
    } catch { /* not JSON */ }
    return raw.slice(0, 500);
}

/** Every `code` along an error's cause chain (fetch wraps undici/system errors in `cause`). */
function causeCodes(err) {
    const codes = [];
    for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
        if (typeof e.code === 'string') codes.push(e.code);
    }
    return codes;
}

/**
 * Turn a fetch/stream failure into an Error a SillyTavern user can act on.
 * Exported for tests.
 * @param {unknown} err
 * @param {string} host upstream host (no credentials)
 */
export function explainFetchError(err, host) {
    if (!(err instanceof Error)) return new Error(String(err));
    if (err.httpStatus || err.upstream) return err; // already ours
    const codes = causeCodes(err);
    const timeout = codes.find((c) => UNDICI_TIMEOUT_CODES.has(c));
    if (timeout) {
        return Object.assign(new Error(`The API backend (${host}) did not respond within 300 s — the request was dropped. Try again, lower the reasoning effort, or turn streaming on.`), { cause: err, upstream: true });
    }
    const net = codes.find((c) => /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_)/.test(c));
    if (net) {
        return Object.assign(new Error(`Cannot reach the API backend (${host}): ${net}. Check the base URL and your connection.`), { cause: err, upstream: true });
    }
    if (err.message === 'fetch failed' || err.message === 'terminated') {
        const inner = err.cause instanceof Error ? err.cause.message : '';
        return Object.assign(new Error(`The API backend (${host}) connection failed${inner ? `: ${inner}` : ''}.`), { cause: err, upstream: true });
    }
    return err;
}

/** Push a complete (non-streamed) chat.completion object through the writer. */
function emitJsonReply(writer, data) {
    if (data?.error) {
        const m = typeof data.error === 'string' ? data.error : (data.error.message ?? JSON.stringify(data.error));
        throw Object.assign(new Error(`Upstream error: ${m}`), { upstream: true });
    }
    const choice = data?.choices?.[0];
    const content = choice?.message?.content ?? '';
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';
    if (typeof reasoning === 'string' && reasoning) writer.pushReasoning(reasoning, { isDelta: false });
    if (typeof content === 'string') writer.pushText(content);
    writer.flushTail();
    writer.finish({ usage: data?.usage ?? null, finishReason: writer.stopMatched ? 'stop' : (choice?.finish_reason ?? 'stop') });
}

/**
 * @param {object} args
 * @param {string} args.baseUrl e.g. https://api.openai.com/v1 or a compatible relay
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {object[]} args.messages
 * @param {object} [args.extraBody] provider-specific fields (reasoning_effort, max_tokens, temperature…)
 * @param {import('./completion.js').CompletionWriter} args.writer
 * @param {AbortSignal} [args.signal] the listener's request signal (client left / plugin stopping)
 * @param {string} [args.tag] log tag
 * @param {number} [args.firstByteMs] override FIRST_BYTE_MS (tests)
 * @param {number} [args.idleMs] override IDLE_MS (tests)
 */
export async function runOpenAiCompat({ baseUrl, apiKey, model, messages, extraBody = {}, writer, signal, tag = '[subscriptions]', firstByteMs = FIRST_BYTE_MS, idleMs = IDLE_MS }) {
    if (signal?.aborted) throw abortError();
    const endpoint = `${normalizeBase(baseUrl)}/chat/completions`;
    const host = hostOf(endpoint);
    const body = { model, messages: sanitizeMessages(messages), stream: writer.stream, ...extraBody };
    if (writer.stream) body.stream_options = { include_usage: true };

    const ac = new AbortController();
    const unsubscribe = onAbort(signal, () => ac.abort());
    let timer = null;
    let timeoutErr = null;
    const arm = (ms, message) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timeoutErr = Object.assign(new Error(message), { upstream: true, timeout: true });
            console.warn(`${tag} ${message}`);
            ac.abort();
        }, ms);
        timer.unref?.();
    };

    let reader = null;
    try {
        arm(firstByteMs, writer.stream
            ? `The API backend (${host}) sent nothing for ${seconds(firstByteMs)} s — request aborted.`
            : `The API backend (${host}) did not finish its reply within ${seconds(firstByteMs)} s — request aborted. Turn streaming on in SillyTavern for long replies.`);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, Accept: writer.stream ? 'text/event-stream' : 'application/json' },
            body: JSON.stringify(body),
            signal: ac.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            const detail = upstreamErrorText(text);
            const err = new Error(`Upstream HTTP ${response.status} from ${host}${detail ? ': ' + detail : ''}`);
            err.httpStatus = response.status;
            throw err;
        }

        if (!writer.stream) {
            const text = await response.text();
            let data;
            try { data = JSON.parse(text); } catch {
                throw Object.assign(new Error(`The API backend (${host}) returned a non-JSON reply: ${text.trim().slice(0, 200) || '(empty)'}`), { upstream: true });
            }
            clearTimeout(timer);
            emitJsonReply(writer, data);
            return;
        }

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let usage = null;
        let finishReason = null;
        let release = false; // [DONE] or a stop match: stop reading and free the socket
        outer:
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            arm(idleMs, `The API backend (${host}) went silent for ${seconds(idleMs)} s mid-reply — request aborted.`);
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const raw of lines) {
                const line = raw.trim();
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') { release = true; break outer; }
                let json;
                try { json = JSON.parse(payload); } catch { continue; }
                if (json.error) {
                    const m = typeof json.error === 'string' ? json.error : (json.error.message ?? JSON.stringify(json.error));
                    throw Object.assign(new Error(`Upstream error: ${m}`), { upstream: true });
                }
                if (json.usage) usage = json.usage;
                const choice = json.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta ?? {};
                const reasoning = delta.reasoning_content ?? delta.reasoning;
                if (typeof reasoning === 'string' && reasoning) writer.pushReasoning(reasoning);
                if (typeof delta.content === 'string' && delta.content) {
                    if (writer.pushText(delta.content)) { release = true; break outer; }
                }
                if (choice.finish_reason) finishReason = choice.finish_reason;
            }
        }
        clearTimeout(timer);
        if (release) reader.cancel().catch(() => {});
        if (signal?.aborted) throw abortError();
        writer.flushTail();
        writer.finish({ usage, finishReason: writer.stopMatched ? 'stop' : (finishReason ?? 'stop') });
    } catch (err) {
        if (reader) reader.cancel().catch(() => {});
        if (timeoutErr) throw timeoutErr;
        if (signal?.aborted) throw abortError();
        throw explainFetchError(err, host);
    } finally {
        if (timer) clearTimeout(timer);
        unsubscribe();
    }
}
