// ──────────────────────────────────────────────
// SessionStore adapter + plugin-owned config dirs + transcript cleanup
// ──────────────────────────────────────────────
//
// The SDK's `resume` + `sessionStore` combo lets us inject prior turns
// without touching the filesystem: the SDK calls `load()` once before
// spawning the subprocess, materialises the entries into its own temporary
// config dir (claude-resume-<uuid> under the OS temp dir), resumes from there
// and deletes that dir when the subprocess exits. `load()` matches on
// sessionId alone — we mint a fresh UUID per request.
//
// PRIVACY: roleplay content should not persist in plaintext outside
// SillyTavern. The fold / stream-input paths run with persistSession:false
// (nothing is written); the resume path's transcript lives in the SDK's temp
// dir. As a safety net, projects/ inside the plugin-owned config dirs (used
// for account isolation and API-key mode) is emptied after each request.

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runtimeDir } from '../common/runtime.js';

/** One-shot in-process SessionStore holding the synthetic history for a single query(). */
export class ResumeSessionStore {
    #sessionId;
    #entries;

    constructor(sessionId, entries) {
        this.#sessionId = sessionId;
        this.#entries = entries;
    }

    load(key) {
        return Promise.resolve(key?.sessionId === this.#sessionId ? this.#entries : null);
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

/** Empty CLAUDE_CONFIG_DIR for API-key mode (no OAuth login visible). */
export function apiModeConfigDir() {
    return runtimeDir('claude-api-config');
}

/** Empty CLAUDE_CONFIG_DIR for subscription mode with an env-supplied token (no account record → no email). */
export function subscriptionConfigDir() {
    return runtimeDir('claude-sub-config');
}

/**
 * The SDK's resume temp dirs (claude-resume-<uuid> in the OS temp dir) are
 * deleted when the subprocess exits — but not when SillyTavern stops or
 * crashes first, and they hold the roleplay transcript. Remove stale ones that
 * are provably this plugin's: the only project inside is the plugin's working
 * directory. Runs once per process, in the background.
 */
let resumeSweepDone = false;
export function sweepStaleResumeDirs(cwd, { olderThanMs = 10 * 60 * 1000 } = {}) {
    if (resumeSweepDone || !cwd) return;
    resumeSweepDone = true;
    const key = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
    const t = setTimeout(() => {
        let base;
        try { base = tmpdir(); } catch { return; }
        let names = [];
        try { names = readdirSync(base).filter((n) => n.startsWith('claude-resume-')); } catch { return; }
        for (const name of names) {
            const dir = join(base, name);
            try {
                if (Date.now() - statSync(dir).mtimeMs < olderThanMs) continue;
                const projects = readdirSync(join(dir, 'projects'));
                if (projects.length !== 1 || projects[0] !== key) continue;
                rmSync(dir, { recursive: true, force: true });
            } catch { /* not ours, in use, or already gone */ }
        }
    }, 5000);
    t.unref?.();
}

/** Test seam. */
export function __resetResumeSweep() {
    resumeSweepDone = false;
}

/** Best-effort removal of any transcripts left in the plugin-owned config dirs. */
export function sweepPluginTranscripts() {
    for (const dir of [subscriptionConfigDir, apiModeConfigDir]) {
        try {
            rmSync(join(dir(), 'projects'), { recursive: true, force: true });
        } catch { /* in use or already gone */ }
    }
}
