// ──────────────────────────────────────────────
// Server-side stop-sequence enforcement
// ──────────────────────────────────────────────
//
// None of the three CLIs expose stop sequences, yet "\n{{user}}:" style stops
// are the standard roleplay guard against the model impersonating the user.
// The scanner watches the visible-text stream, holds back a tail shorter than
// the longest stop string (so a match straddling two chunks is still caught),
// truncates at the first match and tells the caller to abort generation.

export class StopScanner {
    #stops;
    #holdback;
    #buffer = '';
    #done = false;

    /** @param {string[]} stops */
    constructor(stops) {
        this.#stops = (stops ?? []).filter((s) => typeof s === 'string' && s.length > 0);
        this.#holdback = this.#stops.length
            ? Math.max(...this.#stops.map((s) => s.length)) - 1
            : 0;
    }

    get active() {
        return this.#stops.length > 0;
    }

    /**
     * Feed a text delta. Returns { emit, matched }:
     *  - emit: text safe to forward downstream now
     *  - matched: true when a stop sequence fired (emit holds the final text up
     *    to — excluding — the stop string; feed nothing more after this)
     */
    feed(text) {
        if (this.#done) return { emit: '', matched: true };
        if (!this.active) return { emit: text, matched: false };

        this.#buffer += text;

        let earliest = -1;
        for (const stop of this.#stops) {
            const idx = this.#buffer.indexOf(stop);
            if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
        }

        if (earliest !== -1) {
            this.#done = true;
            const emit = this.#buffer.slice(0, earliest);
            this.#buffer = '';
            return { emit, matched: true };
        }

        if (this.#buffer.length > this.#holdback) {
            const emit = this.#buffer.slice(0, this.#buffer.length - this.#holdback);
            this.#buffer = this.#buffer.slice(this.#buffer.length - this.#holdback);
            return { emit, matched: false };
        }

        return { emit: '', matched: false };
    }

    /** Flush the held-back tail at end of stream (no stop ever matched). */
    flush() {
        if (this.#done) return '';
        const rest = this.#buffer;
        this.#buffer = '';
        return rest;
    }
}

/** Normalise the OpenAI `stop` field (string | string[]) into a bounded list. */
export function extractStops(body) {
    let stops = [];
    if (Array.isArray(body?.stop)) stops = body.stop.filter((s) => typeof s === 'string' && s.length > 0);
    else if (typeof body?.stop === 'string' && body.stop.length > 0) stops = [body.stop];
    return stops.slice(0, 16);
}
