// ──────────────────────────────────────────────
// CompletionWriter — one output path for every provider
// ──────────────────────────────────────────────
//
// Providers push text / reasoning deltas into a writer; the writer decides
// whether that becomes SSE chunks (stream=true) or an accumulated JSON reply,
// applies server-side stop sequences, and renders errors in whichever mode
// the client is in (an SSE stream that has already started must end with an
// error event + [DONE], never a 500).

import { StopScanner } from './stops.js';
import { makeCompletionId, writeSse, writeDone, chunkShell, roleChunk, contentChunk, reasoningChunk, finishChunk, errorEvent } from './sse.js';

export class CompletionWriter {
    #res;
    #stream;
    #shell;
    #scanner;
    #showReasoning;
    #sseStarted = false;
    #ended = false;
    #sawReasoningDeltas = false;

    #prefill = null;
    #prefillBuf = '';
    #prefillPending = false;

    text = '';
    reasoning = '';
    finishReason = 'stop';
    usage = null;
    stopMatched = false;
    /** true once anything visible reached the client (no retries after this) */
    didYieldContent = false;
    /** set when a prefill echo was stripped from the reply */
    strippedPrefill = false;

    /**
     * @param {object} args
     * @param {import('express').Response} args.res
     * @param {boolean} args.stream
     * @param {string} args.model model id echoed back to the client
     * @param {string[]} [args.stops]
     * @param {boolean} [args.showReasoning=true]
     * @param {string} [args.idPrefix]
     */
    constructor({ res, stream, model, stops = [], showReasoning = true, idPrefix = 'chatcmpl' }) {
        this.#res = res;
        this.#stream = stream;
        this.#showReasoning = showReasoning;
        this.id = makeCompletionId(idPrefix);
        this.created = Math.floor(Date.now() / 1000);
        this.model = model;
        this.#shell = chunkShell(this.id, this.created, model);
        this.#scanner = new StopScanner(stops);
    }

    get stream() { return this.#stream; }
    get sseStarted() { return this.#sseStarted; }
    get ended() { return this.#ended; }
    get showReasoning() { return this.#showReasoning; }

    /** Fresh stop scanner for a retry attempt (held-back text must not leak). */
    resetScanner(stops) {
        this.#scanner = new StopScanner(stops ?? []);
        this.stopMatched = false;
        if (this.#prefill) { this.#prefillBuf = ''; this.#prefillPending = true; }
    }

    /**
     * Assistant prefill ("Start reply with" / continue) that SillyTavern keeps
     * client-side. CLI backends can only be *asked* not to repeat it; when a
     * model echoes it anyway the echo is stripped so the message is not
     * duplicated. The first few chunks are held back until the comparison can
     * be made (prefills are short).
     */
    setPrefill(prefill) {
        const p = String(prefill ?? '').trim();
        if (!p) return;
        this.#prefill = p;
        this.#prefillBuf = '';
        this.#prefillPending = true;
    }

    /** Route a delta through the prefill-echo filter; returns text to scan for stops. */
    #filterPrefill(delta) {
        if (!this.#prefillPending) return delta;
        this.#prefillBuf += delta;
        const lead = this.#prefillBuf.replace(/^[\s"'“”‘’*_]+/, '');
        const want = this.#prefill.toLowerCase();
        const have = lead.toLowerCase();
        if (have.length < want.length) {
            if (want.startsWith(have)) return ''; // still could be an echo — keep holding
            this.#prefillPending = false;
            const out = this.#prefillBuf; this.#prefillBuf = ''; return out;
        }
        this.#prefillPending = false;
        if (have.startsWith(want)) {
            // Echo confirmed: emit only what follows it (whitespace included —
            // SillyTavern appends the reply straight after the prefill text).
            this.strippedPrefill = true;
            const rest = lead.slice(this.#prefill.length);
            this.#prefillBuf = '';
            return rest;
        }
        const out = this.#prefillBuf; this.#prefillBuf = ''; return out;
    }

    #startSse() {
        if (this.#sseStarted || !this.#stream) return;
        this.#sseStarted = true;
        this.#res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        this.#res.setHeader('Cache-Control', 'no-cache, no-transform');
        this.#res.setHeader('Connection', 'keep-alive');
        this.#res.setHeader('X-Accel-Buffering', 'no');
        if (typeof this.#res.flushHeaders === 'function') this.#res.flushHeaders();
        writeSse(this.#res, roleChunk(this.#shell));
    }

    /** Push a visible-text delta through the stop scanner. Returns true when a stop matched. */
    pushText(delta) {
        if (this.#ended || this.stopMatched || !delta) return this.stopMatched;
        delta = this.#filterPrefill(delta);
        if (!delta) return false;
        const { emit, matched } = this.#scanner.feed(delta);
        if (emit) this.#emitText(emit);
        if (matched) {
            this.stopMatched = true;
            this.finishReason = 'stop';
        }
        return matched;
    }

    #emitText(text) {
        this.didYieldContent = true;
        this.text += text;
        if (this.#stream) {
            this.#startSse();
            writeSse(this.#res, contentChunk(this.#shell, text));
        }
    }

    /** Push a reasoning/thinking delta (dropped when reasoning display is off). */
    pushReasoning(delta, { isDelta = true } = {}) {
        if (this.#ended || !delta || !this.#showReasoning) return;
        if (isDelta) this.#sawReasoningDeltas = true;
        // A complete thinking block arriving after deltas already streamed it is a duplicate.
        else if (this.#sawReasoningDeltas) return;
        this.didYieldContent = true;
        this.reasoning += delta;
        if (this.#stream) {
            this.#startSse();
            writeSse(this.#res, reasoningChunk(this.#shell, delta));
        }
    }

    /** Flush held-back text (call once generation ended without a stop match). */
    flushTail() {
        if (this.stopMatched) return;
        if (this.#prefillPending) {
            // Stream ended while still deciding — the model wrote a prefix of the
            // prefill (or nothing). Emit it verbatim unless it IS the prefill.
            this.#prefillPending = false;
            const held = this.#prefillBuf;
            this.#prefillBuf = '';
            const lead = held.replace(/^[\s"'“”‘’*_]+/, '').toLowerCase();
            if (held && lead !== this.#prefill.toLowerCase()) {
                const { emit } = this.#scanner.feed(held);
                if (emit) this.#emitText(emit);
            } else if (held) {
                this.strippedPrefill = true;
            }
        }
        const tail = this.#scanner.flush();
        if (tail) this.#emitText(tail);
    }

    /** Finish successfully. */
    finish({ usage = null, finishReason } = {}) {
        if (this.#ended) return;
        this.#ended = true;
        if (usage) this.usage = usage;
        if (finishReason) this.finishReason = finishReason;
        if (this.#stream) {
            this.#startSse(); // headers even for instant empty results
            writeSse(this.#res, finishChunk(this.#shell, this.finishReason, this.usage ?? undefined));
            writeDone(this.#res);
            this.#res.end();
            return;
        }
        const message = { role: 'assistant', content: this.text };
        if (this.reasoning) message.reasoning_content = this.reasoning;
        const response = {
            id: this.id,
            object: 'chat.completion',
            created: this.created,
            model: this.model,
            choices: [{ index: 0, message, finish_reason: this.finishReason }],
        };
        if (this.usage) response.usage = this.usage;
        this.#res.json(response);
    }

    /** Fail. Streams that already started get an SSE error event; otherwise a JSON error. */
    fail(err, { status = 500, type = 'server_error' } = {}) {
        if (this.#ended) return;
        this.#ended = true;
        const message = err instanceof Error ? err.message : String(err);
        if (this.#stream && this.#sseStarted) {
            writeSse(this.#res, errorEvent(message, type));
            writeDone(this.#res);
            this.#res.end();
            return;
        }
        this.#res.status(status).json({ error: { message, type } });
    }
}
