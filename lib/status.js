// ──────────────────────────────────────────────
// Aggregate /status
// ──────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { claudeStatus } from './claude/status.js';
import { codexStatus } from './codex/status.js';
import { geminiStatus } from './gemini/status.js';
import { platformLabel } from './common/platform.js';
import { pluginRoot } from './common/runtime.js';

// '0.0.0' when package.json cannot be read — a visible "unknown" rather than a
// hard-coded release number that silently goes stale on the next bump.
let cachedVersion = null;
export function pluginVersion() {
    if (cachedVersion) return cachedVersion;
    try {
        cachedVersion = JSON.parse(readFileSync(join(pluginRoot(), 'package.json'), 'utf8')).version || '0.0.0';
    } catch {
        cachedVersion = '0.0.0';
    }
    return cachedVersion;
}

let listenerInfo = { host: null, port: null, running: false };
export function setListenerInfo(info) {
    listenerInfo = { ...listenerInfo, ...info };
}

/**
 * Stand-in for a provider whose status probe threw, shaped like the real
 * provider status objects: `ok` false, and both backends reported as
 * unknown (ready: null) rather than falsely "not ready".
 */
export function failedProviderStatus(provider, err) {
    const message = String(err?.message ?? err);
    return {
        provider,
        ok: false,
        available: false,
        message,
        backends: {
            subscription: { ready: null, message: `Status check failed: ${message}` },
            api: { ready: null },
        },
    };
}

/**
 * Provider objects are passed through untouched (including their `backends`
 * block); `ok` is true when at least one provider's default (subscription)
 * backend is usable.
 * @param {object} [opts]
 * @param {boolean} [opts.deep] include app-server account/rate-limit reads (may start the codex app-server)
 */
export async function aggregateStatus({ deep = false } = {}) {
    const start = Date.now();
    const [claude, codex, gemini] = await Promise.all([
        claudeStatus().catch((e) => failedProviderStatus('claude', e)),
        codexStatus({ deep }).catch((e) => failedProviderStatus('codex', e)),
        geminiStatus().catch((e) => failedProviderStatus('gemini', e)),
    ]);
    return {
        ok: !!(claude.ok || codex.ok || gemini.ok),
        plugin: 'subscriptions',
        version: pluginVersion(),
        platform: platformLabel(),
        node: process.versions.node,
        listener: listenerInfo,
        providers: { claude, codex, gemini },
        latencyMs: Date.now() - start,
    };
}
