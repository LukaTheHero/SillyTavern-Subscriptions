// ──────────────────────────────────────────────
// SessionStore adapter + scratch cwd + transcript privacy sweep
// ──────────────────────────────────────────────
//
// The SDK's `resume` + `sessionStore` combo lets us inject prior turns
// without touching the filesystem: the SDK calls `load()` once before
// spawning the subprocess, materialises the entries to its own temp JSONL,
// and resumes from there. `load()` matches on sessionId alone — we mint a
// fresh UUID per request, so no cwd→projectKey path math is needed.
//
// PRIVACY: the subprocess still writes each live turn's transcript to a real
// session file under ~/.claude/projects/<scratch-key>/. After each request
// the plugin best-effort deletes it via the SDK's own deleteSession() —
// roleplay content should not persist in plaintext outside SillyTavern.

import { runtimeDir } from '../common/runtime.js';

const TAG = '[subscriptions/claude]';

/** One-shot in-process SessionStore holding the synthetic history for a single query(). */
export class ResumeSessionStore {
    #sessionId;
    #entries;

    constructor(sessionId, entries) {
        this.#sessionId = sessionId;
        this.#entries = entries;
    }

    load(key) {
        return Promise.resolve(key.sessionId === this.#sessionId ? this.#entries : null);
    }

    append(_key, _entries) {
        return Promise.resolve();
    }

    // 0.3.x SessionStore contract — optional, but declare them so listSessions()/
    // delete paths never hit "undefined is not a function".
    listSubkeys() {
        return Promise.resolve([]);
    }

    delete() {
        return Promise.resolve();
    }
}

export { runtimeDir };

/** Scratch working directory for SDK subprocess cwd (own project bucket). */
export function resumeScratchCwd() {
    return runtimeDir('claude-cwd');
}

/** Empty CLAUDE_CONFIG_DIR for API-key/LinkAPI mode (no OAuth login visible). */
export function apiModeConfigDir() {
    return runtimeDir('claude-api-config');
}

/** Best-effort removal of the live-turn transcript the subprocess wrote. */
export function sweepSessionTranscript(loadSdk, sessionId) {
    if (!sessionId) return;
    const t = setTimeout(async () => {
        try {
            const sdk = await loadSdk();
            if (typeof sdk.deleteSession === 'function') await sdk.deleteSession(sessionId);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/not found|ENOENT/i.test(msg)) console.warn(`${TAG} transcript sweep for ${sessionId} skipped: ${msg}`);
        }
    }, 2000);
    t.unref?.();
}
