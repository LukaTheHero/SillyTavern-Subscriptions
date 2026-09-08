// ──────────────────────────────────────────────
// Lazy import wrapper for @anthropic-ai/claude-agent-sdk + CLI resolution
// ──────────────────────────────────────────────
//
// The SDK is heavy; keeping the import behind a cached promise avoids loading
// it until the first chat request. On failure the cache is cleared so the
// next request retries the import.
//
// CLI binary: the SDK ships the Claude Code CLI as per-platform optional
// packages (@anthropic-ai/claude-agent-sdk-linux-arm64-musl etc.) and picks
// one by process.platform/arch. Two cases need help:
//   • Termux: process.platform is 'android', which the SDK does not map. The
//     linux-arm64-musl build usually runs fine there, and so does a `claude`
//     installed globally, so we locate one and pass pathToClaudeCodeExecutable.
//   • npm install --omit=optional: no platform package at all → same fallback.
// An explicit ST_SUBSCRIPTIONS_CLAUDE_PATH always wins.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { resolveExecutable, findInGlobalPackage, commonBinDirs, launchSpec } from '../common/exec.js';
import { IS_WINDOWS, IS_ANDROID, IS_TERMUX, home, termuxPrefix } from '../common/platform.js';

const require = createRequire(import.meta.url);
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

let cachedSdk = null;

export function loadSdk() {
    if (!cachedSdk) {
        cachedSdk = import(SDK_PKG).catch((err) => {
            cachedSdk = null;
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Failed to load ${SDK_PKG}. Run \`npm install\` inside the plugin directory ` +
                '(plugins/SillyTavern-Subscriptions) WITHOUT --omit=optional, restart SillyTavern, and make ' +
                `sure \`claude login\` has been run once on this host. Underlying error: ${msg}`,
            );
        });
    }
    return cachedSdk;
}

/** Test seam — replace the cached SDK module with a fake or clear it. */
export function __setSdkForTesting(mod) {
    cachedSdk = mod ? Promise.resolve(mod) : null;
}

/** Detect the installed SDK version (telemetry only). */
export function detectSdkVersion() {
    try {
        // The SDK's `exports` map hides package.json — resolve the entry file and read beside it.
        const entry = require.resolve(SDK_PKG);
        const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'));
        if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch { /* fall through */ }
    return 'unknown';
}

/** Path of the SDK's bundled CLI for this platform, or null when absent. */
export function bundledCliPath() {
    const ext = IS_WINDOWS ? '.exe' : '';
    const platform = IS_ANDROID ? 'linux' : process.platform;
    const arch = process.arch;
    const candidates = [
        `${SDK_PKG}-${platform}-${arch}-musl/claude${ext}`,
        `${SDK_PKG}-${platform}-${arch}/claude${ext}`,
    ];
    for (const c of candidates) {
        try {
            const p = require.resolve(c);
            if (existsSync(p)) return p;
        } catch { /* not installed */ }
    }
    return null;
}

/**
 * Decide whether/what to pass as options.pathToClaudeCodeExecutable.
 * Returns { path, source } or null (= let the SDK use its bundled binary).
 */
let cachedResolution;
export function resolveClaudeExecutable() {
    if (cachedResolution !== undefined) return cachedResolution;

    // 1. explicit override
    for (const v of ['ST_SUBSCRIPTIONS_CLAUDE_PATH', 'CLAUDE_SUBSCRIPTION_CLAUDE_PATH']) {
        const val = process.env[v];
        if (val && existsSync(val)) { cachedResolution = { path: val, source: `env:${v}` }; return cachedResolution; }
    }

    // 2. the SDK's own bundled binary works on native platforms — nothing to do.
    //    On Android the SDK will not find it by itself (platform key mismatch),
    //    so hand it the musl build explicitly when present.
    const bundled = bundledCliPath();
    if (bundled && !IS_ANDROID) { cachedResolution = null; return null; }
    if (bundled && IS_ANDROID) { cachedResolution = { path: bundled, source: 'sdk-bundle (android → linux musl)' }; return cachedResolution; }

    // 3. a globally installed Claude Code
    const extra = [...commonBinDirs()];
    if (IS_TERMUX) extra.unshift(join(termuxPrefix(), 'bin'));
    if (IS_WINDOWS) extra.unshift(join(home(), '.local', 'bin'));
    const spec = resolveExecutable({
        envVars: [],
        names: ['claude'],
        extraDirs: extra,
        npm: { pkg: '@anthropic-ai/claude-code', files: [IS_WINDOWS ? 'bin/claude.exe' : 'bin/claude', 'cli.js'] },
    });
    if (spec) { cachedResolution = { path: spec.path, source: spec.source }; return cachedResolution; }

    const npmCli = findInGlobalPackage('@anthropic-ai/claude-code', ['cli.js']);
    if (npmCli) { cachedResolution = { path: npmCli, source: 'npm:@anthropic-ai/claude-code' }; return cachedResolution; }

    cachedResolution = null;
    return null;
}

/** Test seam. */
export function __resetClaudeExecutableCache() {
    cachedResolution = undefined;
}

/** Human-readable summary for /status. */
export function claudeCliSummary() {
    const bundled = bundledCliPath();
    const override = resolveClaudeExecutable();
    return {
        bundled: !!bundled,
        path: override?.path ?? bundled ?? null,
        source: override?.source ?? (bundled ? 'sdk-bundle' : 'none'),
        android: IS_ANDROID,
    };
}

export { launchSpec };
