// ──────────────────────────────────────────────
// Request cancellation helpers
// ──────────────────────────────────────────────
//
// The listener owns ONE AbortController per chat request and aborts it when
// the client disconnects (SillyTavern's Stop button, a swipe, a closed tab)
// or the plugin shuts down. Runners receive its signal and must stop their
// upstream work — CLI turn, subprocess or HTTP stream — as soon as it fires.
//
// Note: never use `req.on('close')` for this. Since Node 16 an
// IncomingMessage emits 'close' as soon as its body has been consumed (which
// express.json() does before any handler runs), not when the client leaves.
// The response's 'close' event is the one that tracks the connection.

/**
 * Run `fn` once when `signal` aborts — immediately (next microtask) when it
 * already has. Returns an unsubscribe function.
 * @param {AbortSignal|undefined|null} signal
 * @param {() => void} fn
 */
export function onAbort(signal, fn) {
    if (!signal) return () => {};
    if (signal.aborted) {
        let cancelled = false;
        queueMicrotask(() => { if (!cancelled) fn(); });
        return () => { cancelled = true; };
    }
    signal.addEventListener('abort', fn, { once: true });
    return () => signal.removeEventListener('abort', fn);
}

/** An Error recognisable as a cancellation (name 'AbortError'). */
export function abortError(message = 'Request cancelled: the client disconnected') {
    const err = new Error(message);
    err.name = 'AbortError';
    err.aborted = true;
    return err;
}

export function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.aborted === true);
}
