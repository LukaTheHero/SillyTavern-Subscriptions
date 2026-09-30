// ──────────────────────────────────────────────
// Lazy import wrapper for @anthropic-ai/claude-agent-sdk + CLI resolution
// ──────────────────────────────────────────────
//
// The SDK is heavy; keeping the import behind a cached promise avoids loading
// it until the first chat request. On failure the cache is cleared so the
// next request retries the import.
//
// CLI binary: the SDK ships the Claude Code CLI as per-platform optional
// packages (@anthropic-ai/claude-agent-sdk-linux-x64, -linux-x64-musl,
// -darwin-arm64, -win32-x64 …) and picks one by process.platform/arch. What
// decides which models work is the version of THAT CLI (e.g. Opus 5.5 needs
// Claude Code 2.1.280+), so status reports it next to the SDK version.
// Special cases:
//   • npm install --omit=optional (or omit=optional in ~/.npmrc): no platform
//     package → fall back to a globally installed Claude Code.
//   • Termux/Android: Claude Code publishes no Android build and npm skips the
//     linux packages there (process.platform is 'android'), so a binary is
//     accepted only after it actually runs. The supported route is running
//     SillyTavern inside proot-distro (Debian/Ubuntu), or pointing
//     ST_SUBSCRIPTIONS_CLAUDE_PATH at a binary known to work.
// An explicit ST_SUBSCRIPTIONS_CLAUDE_PATH always wins. Windows .cmd shims are
// never used — the SDK spawns the path without a shell.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { resolveExecutable, findInGlobalPackage, commonBinDirs, launchSpec } from '../common/exec.js';
import { IS_WINDOWS, IS_ANDROID, IS_TERMUX, home, termuxPrefix } from '../common/platform.js';

const TAG = '[subscriptions/claude]';
const require = createRequire(import.meta.url);
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
const NEGATIVE_CACHE_MS = 60_000;

let cachedSdk = null;

export function loadSdk() {
    if (!cachedSdk) {
        cachedSdk = import(SDK_PKG).catch((err) => {
            cachedSdk = null;
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Failed to load ${SDK_PKG}. Run \`npm install\` inside the plugin directory ` +
                '(plugins/SillyTavern-Subscriptions) WITHOUT --omit=optional, restart SillyTavern, and make ' +
                `sure \`claude auth login\` has been run once on this host. Underlying error: ${msg}`,
            );
        });
    }
    return cachedSdk;
}

/** Test seam — replace the cached SDK module with a fake or clear it. */
export function __setSdkForTesting(mod) {
    cachedSdk = mod ? Promise.resolve(mod) : null;
}

function sdkPackageJson() {
    try {
        // The SDK's `exports` map hides package.json — resolve the entry file and read beside it.
        const entry = require.resolve(SDK_PKG);
        return JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'));
    } catch {
        return null;
    }
}

/** Installed SDK version. */
export function detectSdkVersion() {
    const v = sdkPackageJson()?.version;
    return typeof v === 'string' && v ? v : 'unknown';
}

/** a < b for dotted numeric versions. */
function versionLess(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
    }
    return false;
}

/**
 * SillyTavern git-pulls plugin updates but never runs `npm install`, so the
 * installed Agent SDK (and the Claude CLI inside it) can lag behind what the
 * plugin's package.json requires. Returns { installed, required } when it
 * does, else null.
 */
export function sdkUpdateNeeded() {
    try {
        const pluginPkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));
        const range = String(pluginPkg.dependencies?.[SDK_PKG] ?? '');
        const required = range.match(/\d+\.\d+\.\d+/)?.[0];
        const installed = detectSdkVersion();
        if (!required || installed === 'unknown') return null;
        return versionLess(installed, required) ? { installed, required } : null;
    } catch {
        return null;
    }
}

/** Version of the Claude Code CLI bundled with the installed SDK. */
export function detectBundledCliVersion() {
    const v = sdkPackageJson()?.claudeCodeVersion;
    return typeof v === 'string' && v ? v : 'unknown';
}

/** musl libc? Cached — a process's libc never changes. */
let muslCache;
function isMusl() {
    if (muslCache !== undefined) return muslCache;
    muslCache = false;
    try {
        if (readdirSync('/lib').some((f) => f.startsWith('ld-musl-'))) return (muslCache = true);
        if (existsSync('/usr/bin/ldd') && readFileSync('/usr/bin/ldd', 'utf8').includes('musl')) return (muslCache = true);
    } catch { /* fall through to the process report */ }
    try {
        // glibc reports glibcVersionRuntime in the report header; skip the
        // (slow, DNS-resolving) network section.
        const report = process.report;
        const prev = report?.excludeNetwork;
        if (report && 'excludeNetwork' in report) report.excludeNetwork = true;
        muslCache = report?.getReport?.()?.header?.glibcVersionRuntime === undefined;
        if (report && prev !== undefined) report.excludeNetwork = prev;
    } catch { /* assume glibc */ }
    return muslCache;
}

const runnableCache = new Map();
/** Does `path --version` exit 0? (Android only — cached.) */
function runs(path) {
    if (runnableCache.has(path)) return runnableCache.get(path);
    let ok = false;
    try {
        ok = spawnSync(path, ['--version'], { timeout: 8000, stdio: 'ignore', windowsHide: true }).status === 0;
    } catch { /* not runnable */ }
    runnableCache.set(path, ok);
    return ok;
}

/** Path of the SDK's bundled CLI for this platform, or null when absent (cached once found). */
let bundledCache;
export function bundledCliPath() {
    if (bundledCache) return bundledCache;
    bundledCache = findBundledCli();
    return bundledCache;
}

function findBundledCli() {
    const ext = IS_WINDOWS ? '.exe' : '';
    const platform = IS_ANDROID ? 'linux' : process.platform;
    const arch = process.arch;
    const glibc = `${SDK_PKG}-${platform}-${arch}/claude${ext}`;
    const musl = `${SDK_PKG}-${platform}-${arch}-musl/claude${ext}`;
    const candidates = platform === 'linux' && (IS_ANDROID || isMusl()) ? [musl, glibc] : [glibc, musl];
    for (const c of candidates) {
        try {
            const p = require.resolve(c);
            if (!existsSync(p)) continue;
            if (IS_ANDROID && !runs(p)) continue;
            return p;
        } catch { /* not installed */ }
    }
    return null;
}

/**
 * Decide whether/what to pass as options.pathToClaudeCodeExecutable.
 * Returns { path, source } or null (= let the SDK use its bundled binary).
 */
let cachedResolution;
let cachedAt = 0;
const warned = new Set();
function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`${TAG} ${message}`);
}

export function resolveClaudeExecutable() {
    if (cachedResolution !== undefined && (cachedResolution !== false || Date.now() - cachedAt < NEGATIVE_CACHE_MS)) {
        return cachedResolution || null;
    }
    cachedResolution = computeResolution();
    cachedAt = Date.now();
    return cachedResolution || null;
}

/** @returns {{path:string, source:string} | null | false} null = bundled binary; false = nothing found */
function computeResolution() {
    // 1. explicit override
    for (const v of ['ST_SUBSCRIPTIONS_CLAUDE_PATH', 'CLAUDE_SUBSCRIPTION_CLAUDE_PATH']) {
        const val = process.env[v];
        if (!val) continue;
        if (!existsSync(val)) { warnOnce(`missing:${v}`, `${v}=${val} does not exist — ignored`); continue; }
        if (IS_WINDOWS && /\.(cmd|bat)$/i.test(val)) { warnOnce(`shim:${v}`, `${v} points at a .cmd/.bat shim, which the Agent SDK cannot spawn — point it at claude.exe instead`); continue; }
        return { path: val, source: `env:${v}` };
    }

    // 2. the SDK's own bundled binary works on native platforms — nothing to do.
    //    On Android the SDK will not find it by itself (platform key mismatch),
    //    so hand it over explicitly when one actually runs.
    const bundled = bundledCliPath();
    if (bundled) return IS_ANDROID ? { path: bundled, source: 'sdk-bundle (android → linux)' } : null;

    // 3. a globally installed Claude Code (native installer or npm)
    const extra = [...commonBinDirs()];
    if (IS_TERMUX) extra.unshift(join(termuxPrefix(), 'bin'));
    if (IS_WINDOWS) extra.unshift(join(home(), '.local', 'bin'));
    const spec = resolveExecutable({
        envVars: [],
        names: ['claude'],
        extraDirs: extra,
        npm: { pkg: '@anthropic-ai/claude-code', files: ['bin/claude.exe', 'bin/claude', 'cli.js'] },
    });
    if (spec && !(IS_ANDROID && !spec.isScript && !runs(spec.path))) return { path: spec.path, source: spec.source };

    const npmCli = findInGlobalPackage('@anthropic-ai/claude-code', ['bin/claude.exe', 'bin/claude', 'cli.js']);
    if (npmCli && !(IS_ANDROID && !/\.js$/.test(npmCli) && !runs(npmCli))) return { path: npmCli, source: 'npm:@anthropic-ai/claude-code' };

    return false;
}

/** Test seam. */
export function __resetClaudeExecutableCache() {
    cachedResolution = undefined;
    cachedAt = 0;
}

const versionCache = new Map();
/** `<path> --version` → '2.1.285' (cached per path), or null. */
function cliVersionOf(path) {
    if (versionCache.has(path)) return versionCache.get(path);
    let version = null;
    try {
        const isJs = /\.(m?js|cjs)$/i.test(path);
        const out = spawnSync(isJs ? process.execPath : path, isJs ? [path, '--version'] : ['--version'], { timeout: 8000, encoding: 'utf8', windowsHide: true });
        version = String(out.stdout ?? '').match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    } catch { /* unknown */ }
    versionCache.set(path, version);
    return version;
}

let lastSeenCliVersion = null;
/** Recorded from the init message of a real query (the ground truth). */
export function recordCliVersion(version) {
    if (typeof version === 'string' && version) lastSeenCliVersion = version;
}

/**
 * Human-readable summary for /status. `withVersion: false` skips the version
 * probe (which may spawn `<override> --version` once) for hot paths.
 */
export function claudeCliSummary({ withVersion = true } = {}) {
    const bundled = bundledCliPath();
    const override = resolveClaudeExecutable();
    const path = override?.path ?? bundled ?? null;
    let version = null;
    if (path && withVersion) version = override ? cliVersionOf(override.path) : detectBundledCliVersion();
    const summary = {
        bundled: !!bundled,
        path,
        source: override?.source ?? (bundled ? 'sdk-bundle' : 'none'),
        version: lastSeenCliVersion ?? (version === 'unknown' ? null : version),
        android: IS_ANDROID,
    };
    if (!path && IS_ANDROID) summary.reason = 'android-unsupported';
    return summary;
}

export { launchSpec };
