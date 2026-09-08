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

let cachedVersion = null;
export function pluginVersion() {
    if (cachedVersion) return cachedVersion;
    try {
        cachedVersion = JSON.parse(readFileSync(join(pluginRoot(), 'package.json'), 'utf8')).version || '3.0.0';
    } catch {
        cachedVersion = '3.0.0';
    }
    return cachedVersion;
}

let listenerInfo = { host: null, port: null, running: false };
export function setListenerInfo(info) {
    listenerInfo = { ...listenerInfo, ...info };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.deep] include app-server account/rate-limit reads (may start the codex app-server)
 */
export async function aggregateStatus({ deep = false } = {}) {
    const start = Date.now();
    const [claude, codex, gemini] = await Promise.all([
        claudeStatus().catch((e) => ({ provider: 'claude', ok: false, available: false, message: String(e?.message ?? e) })),
        codexStatus({ deep }).catch((e) => ({ provider: 'codex', ok: false, available: false, message: String(e?.message ?? e) })),
        geminiStatus().catch((e) => ({ provider: 'gemini', ok: false, available: false, message: String(e?.message ?? e) })),
    ]);
    return {
        ok: claude.ok || codex.ok || gemini.ok,
        plugin: 'subscriptions',
        version: pluginVersion(),
        platform: platformLabel(),
        node: process.versions.node,
        listener: listenerInfo,
        providers: { claude, codex, gemini },
        latencyMs: Date.now() - start,
    };
}
