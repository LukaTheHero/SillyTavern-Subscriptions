// ──────────────────────────────────────────────
// SillyTavern Server Plugin — Subscriptions (Claude Max · Codex · Gemini)
// ──────────────────────────────────────────────
//
// One OpenAI-compatible proxy for three subscriptions:
//   • Claude  — Anthropic Pro/Max via the Claude Agent SDK (claude auth login)
//   • Codex   — ChatGPT Plus/Pro via the Codex CLI app-server (codex login)
//   • Gemini  — Google Antigravity via the agy CLI (agy sign-in)
// Each also has an opt-in pay-per-token "api" backend (the vendor API or a
// compatible relay). The subscription is always the default backend.
//
// The chat endpoints run on a separate HTTP listener (default 127.0.0.1:8901)
// outside SillyTavern's CSRF middleware — see lib/listener.js. The companion
// "Subscriptions" UI extension is auto-installed into SillyTavern's third-party
// extensions on startup; it provides one-click connect, a provider scope
// selector, per-provider settings, and a status/quota panel.
//
// Env overrides (all optional):
//   ST_SUBSCRIPTIONS_PORT=8901                 listener port
//   ST_SUBSCRIPTIONS_HOST=127.0.0.1            listener host
//   ST_SUBSCRIPTIONS_TOKEN=…                   required for a non-loopback host (X-Subscriptions-Token header)
//   ST_SUBSCRIPTIONS_ALLOWED_HOSTS=a,b         extra Host header names accepted on a loopback listener
//   ST_SUBSCRIPTIONS_NO_UI_INSTALL=1           skip the UI-extension auto-install
//   ST_SUBSCRIPTIONS_LIST_ALL_MODELS=1         list every provider's models even when unusable here
//   ST_SUBSCRIPTIONS_CLAUDE_PATH=…             explicit claude executable (Termux etc.)
//   ST_SUBSCRIPTIONS_CLAUDE_USE_RESUME=0       force the transcript-fold path for Claude
//   ST_SUBSCRIPTIONS_CLAUDE_MAX_TURNS=N        SDK maxTurns override (default 1)
//   ST_SUBSCRIPTIONS_CLAUDE_ISOLATE_ACCOUNT=0  let the CLI use its own login store (adds the account email to prompts)
//   ST_SUBSCRIPTIONS_CLAUDE_API_KEY / _BASE_URL   Claude "api" backend credentials
//   ST_SUBSCRIPTIONS_CODEX_PATH=…              explicit codex executable
//   ST_SUBSCRIPTIONS_CODEX_HOME=…              CODEX_HOME to use (e.g. ~/.codex)
//   ST_SUBSCRIPTIONS_CODEX_API_KEY / _BASE_URL    Codex "api" backend credentials
//   ST_SUBSCRIPTIONS_AGY_PATH=…                explicit agy executable
//   ST_SUBSCRIPTIONS_AGY_SANDBOX=0             run agy turns without --sandbox (if the sandbox fails on this OS)
//   ST_SUBSCRIPTIONS_AGY_TIMEOUT_MS / _FIRST_OUTPUT_MS / _IDLE_MS   agy watchdogs (600000 / 240000 / 120000)
//   ST_SUBSCRIPTIONS_GEMINI_API_KEY / _BASE_URL   Gemini "api" backend credentials

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStandaloneListener, stopStandaloneListener, handleStatus, handleQuota, handleModels } from './lib/listener.js';
import { stopAppServer } from './lib/codex/app-server.js';
import { sdkUpdateNeeded } from './lib/claude/sdk-loader.js';
import { envInt, envString, envFlag } from './lib/common/platform.js';

const DEFAULT_PORT = 8901;
const DEFAULT_HOST = '127.0.0.1';
const UI_EXTENSION_DIR_NAME = 'SillyTavern-Subscriptions-UI';
const DIALOG_CLONE_DIR_NAME = 'SillyTavern-Subscriptions';
const UI_EXTENSION_FILES = ['manifest.json', 'index.js', 'style.css'];
/** Written into the copy this plugin installs — the only copy it will ever delete. */
const AUTO_INSTALL_MARKER = '.auto-installed';

const LEGACY_PLUGIN_DIRS = ['SillyTavern-ClaudeSubscription', 'SillyTavern-GeminiSubscription', 'SillyTavern-CodexSubscription'];
const LEGACY_UI_DIRS = ['SillyTavern-ClaudeMax', 'SillyTavern-GeminiAntigravity', 'SillyTavern-CodexMax', ...LEGACY_PLUGIN_DIRS];

export const info = {
    id: 'subscriptions',
    name: 'Subscriptions (Claude Max · Codex · Gemini)',
    description:
        'One OpenAI-compatible proxy that bills chat against your Claude Pro/Max, ChatGPT/Codex and Google Antigravity ' +
        'subscriptions (optional pay-per-token API backends, never on by default). Pick the provider and model from inside SillyTavern via the ' +
        'auto-installed "Subscriptions" panel.',
};

function isNewerVersion(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x > y;
    }
    return false;
}

function here() {
    return dirname(fileURLToPath(import.meta.url));
}

/**
 * Locate SillyTavern's server directory and data root.
 *  - root: ST chdirs to its server directory at startup, so process.cwd() is
 *    tried first. <plugin>/../.. is only the fallback: Node resolves module
 *    URLs to their real path, so a plugins/ entry that is a symlink or
 *    junction to a dev checkout would point somewhere else entirely.
 *  - dataRoot: config.yaml `dataRoot` / --dataRoot, which ST exposes as
 *    globalThis.DATA_ROOT (a relative path is relative to the server dir);
 *    else <root>/data.
 * @returns {{ root: string, thirdParty: string, dataRoot: string, pluginsDir: string } | null}
 */
export function locateSillyTavern({ pluginDir = here(), cwd = process.cwd(), dataRoot = globalThis.DATA_ROOT } = {}) {
    const thirdPartyOf = (d) => join(d, 'public', 'scripts', 'extensions', 'third-party');
    const root = [cwd, resolve(pluginDir, '..', '..')].find((d) => d && existsSync(thirdPartyOf(d)));
    if (!root) return null;
    return {
        root,
        thirdParty: thirdPartyOf(root),
        dataRoot: typeof dataRoot === 'string' && dataRoot.trim() ? resolve(root, dataRoot) : join(root, 'data'),
        pluginsDir: join(root, 'plugins'),
    };
}

/** Warn loudly about the three predecessor plugins/extensions still being installed. */
function warnAboutLegacyInstalls(st, pluginDir) {
    const legacyPlugins = new Set();
    for (const dir of new Set([st.pluginsDir, resolve(pluginDir, '..')])) {
        try {
            for (const d of readdirSync(dir)) if (LEGACY_PLUGIN_DIRS.includes(d)) legacyPlugins.add(d);
        } catch { /* ignore */ }
    }
    if (legacyPlugins.size) {
        console.warn(
            `[${info.id}] legacy server plugin(s) still installed next to this one: ${[...legacyPlugins].join(', ')}. ` +
            'They are replaced by SillyTavern-Subscriptions and will fight over ports/panels — move them out of plugins/ and restart.',
        );
    }
    try {
        const present = readdirSync(st.thirdParty).filter((d) => LEGACY_UI_DIRS.includes(d));
        if (present.length) {
            console.warn(
                `[${info.id}] legacy UI extension(s) still installed: ${present.join(', ')}. ` +
                'Their panels are superseded by the "Subscriptions" panel — delete those folders (or disable them in Extensions) to avoid duplicate settings injection.',
            );
        }
    } catch { /* ignore */ }
}

/**
 * Clones made by SillyTavern's "Install extension" dialog. A global install
 * lands in third-party/ and serves every user; a per-user one lands in
 * <dataRoot>/<user>/extensions/ and serves only that user.
 * @returns {{ global: string|null, perUser: string[], users: number }}
 *   `users` counts the user directories (those with an extensions/ folder).
 */
function findDialogClones(st) {
    const hasManifest = (d) => existsSync(join(d, 'manifest.json'));
    const globalClone = join(st.thirdParty, DIALOG_CLONE_DIR_NAME);
    const perUser = [];
    let users = 0;
    try {
        for (const user of readdirSync(st.dataRoot)) {
            if (user.startsWith('_')) continue; // _storage, _cache, _uploads … are not users
            const extDir = join(st.dataRoot, user, 'extensions');
            if (!existsSync(extDir)) continue;
            users++;
            const clone = join(extDir, DIALOG_CLONE_DIR_NAME);
            if (hasManifest(clone)) perUser.push(clone);
        }
    } catch { /* no data dir */ }
    return { global: hasManifest(globalClone) ? globalClone : null, perUser, users };
}

/**
 * A dialog clone exists, so the copy this plugin once auto-installed is now a
 * stale duplicate: both would load, and whichever SillyTavern happens to
 * activate first wins. Remove it when it carries our marker. Copies written
 * before the marker existed are disarmed instead (manifest.json renamed, so
 * ST stops loading it — reversible). Anything else is only reported.
 * @returns {'none'|'removed'|'disarmed'|'kept'|'error'}
 */
function retireAutoInstalledCopy(target, srcManifest) {
    try {
        if (!existsSync(target)) return 'none';
        if (lstatSync(target).isSymbolicLink()) {
            console.warn(`[${info.id}] third-party/${UI_EXTENSION_DIR_NAME} is a link — left alone; remove it yourself if the dialog-installed panel is the one you use.`);
            return 'kept';
        }
        if (existsSync(join(target, '.git'))) {
            console.warn(`[${info.id}] third-party/${UI_EXTENSION_DIR_NAME} is a git clone — left alone; remove it yourself if the dialog-installed panel is the one you use.`);
            return 'kept';
        }
        if (existsSync(join(target, AUTO_INSTALL_MARKER))) {
            rmSync(target, { recursive: true, force: true });
            console.log(`[${info.id}] removed the old auto-installed panel copy at third-party/${UI_EXTENSION_DIR_NAME} (the dialog-installed clone replaces it)`);
            return 'removed';
        }
        const manifestPath = join(target, 'manifest.json');
        if (!existsSync(manifestPath)) return 'none';
        let installed = null;
        try { installed = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* unreadable */ }
        if (installed && installed.display_name === srcManifest.display_name && installed.js === srcManifest.js) {
            renameSync(manifestPath, join(target, 'manifest.json.disabled'));
            console.warn(
                `[${info.id}] disabled the stale panel copy at third-party/${UI_EXTENSION_DIR_NAME} (manifest.json renamed to manifest.json.disabled) — ` +
                'the dialog-installed clone replaces it. Delete that folder when convenient.',
            );
            return 'disarmed';
        }
        console.warn(`[${info.id}] third-party/${UI_EXTENSION_DIR_NAME} exists next to the dialog-installed clone — remove it if it is an old copy of this panel.`);
        return 'kept';
    } catch (err) {
        console.warn(`[${info.id}] could not retire the old panel copy at third-party/${UI_EXTENSION_DIR_NAME}:`, err instanceof Error ? err.message : err);
        return 'error';
    }
}

/**
 * Install or update the companion UI extension into SillyTavern's third-party
 * extensions directory. Version-gated: only copies when missing or strictly
 * older. Stands down when the repo was installed through SillyTavern's
 * "Install extension" dialog (a git-managed clone ST updates itself), and
 * then retires the copy it installed earlier.
 * @returns {string} what happened (tests / logs)
 */
export function installUiExtension({ pluginDir = here(), st = locateSillyTavern() } = {}) {
    if (envFlag('ST_SUBSCRIPTIONS_NO_UI_INSTALL', false)) return 'disabled';
    try {
        if (!existsSync(join(pluginDir, 'manifest.json'))) return 'no-manifest';
        if (!st) {
            console.warn(
                `[${info.id}] SillyTavern third-party extension dir not found (looked under ${process.cwd()} and ${resolve(pluginDir, '..', '..')}) ` +
                '— install the UI extension manually (see README).',
            );
            return 'no-sillytavern';
        }
        warnAboutLegacyInstalls(st, pluginDir);

        const srcManifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
        const srcVersion = srcManifest.version ?? '0.0.0';
        const target = join(st.thirdParty, UI_EXTENSION_DIR_NAME);

        // Installed through SillyTavern's "Install extension" dialog? That clone
        // is git-managed by ST (update/remove buttons work) — leave it alone.
        // When it serves every user (a global clone, or a per-user clone for
        // each user) our copy is a pure duplicate and is retired. When only
        // some users of a multi-user install cloned it, the others still rely
        // on our copy, so it keeps being installed/updated (the panel's own
        // duplicate guard keeps a second copy dormant for the cloning users).
        const clones = findDialogClones(st);
        if (clones.global || (clones.perUser.length && clones.perUser.length >= clones.users)) {
            console.log(`[${info.id}] UI extension already installed via SillyTavern's extension installer — auto-install skipped`);
            retireAutoInstalledCopy(target, srcManifest);
            return 'dialog-clone';
        }
        if (clones.perUser.length) {
            console.log(`[${info.id}] ${clones.perUser.length} of ${clones.users} SillyTavern users installed the panel themselves — keeping the shared copy for the others`);
        }

        // A link here (e.g. to a dev checkout) is someone's own setup: never copy into it.
        if (existsSync(target) && lstatSync(target).isSymbolicLink()) return 'linked';

        let installedVersion = null;
        if (existsSync(join(target, 'manifest.json'))) {
            try { installedVersion = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).version ?? '0.0.0'; } catch { /* reinstall */ }
        }
        if (installedVersion !== null && !isNewerVersion(srcVersion, installedVersion)) return 'current';

        mkdirSync(target, { recursive: true });
        for (const file of UI_EXTENSION_FILES) cpSync(join(pluginDir, file), join(target, file));
        writeFileSync(
            join(target, AUTO_INSTALL_MARKER),
            JSON.stringify({ installedBy: 'sillytavern-subscriptions', version: srcVersion, at: new Date().toISOString() }, null, 2) + '\n',
        );
        console.log(
            `[${info.id}] ${installedVersion ? `updated UI extension ${installedVersion} → ${srcVersion}` : `installed UI extension v${srcVersion}`} ` +
            `at public/scripts/extensions/third-party/${UI_EXTENSION_DIR_NAME} (hard-refresh the browser to load it)`,
        );
        return installedVersion ? 'updated' : 'installed';
    } catch (err) {
        console.warn(`[${info.id}] UI extension auto-install failed:`, err instanceof Error ? err.message : err);
        return 'error';
    }
}

/**
 * Express 4 does not catch a rejected async handler, and inside SillyTavern
 * an unhandled rejection reaches its uncaughtException handler, which shuts
 * the whole server down. Every ST-mounted route goes through this.
 */
export function safeRoute(fn) {
    return (req, res, next) => {
        Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
            console.error(`[${info.id}] ${req.method} ${req.originalUrl ?? req.url} failed:`, err);
            try {
                if (res.headersSent) { res.end(); return; }
                res.status(500).json({ error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' } });
            } catch { /* socket gone */ }
        });
    };
}

/**
 * SillyTavern-mounted routes (GET is CSRF-exempt): same-origin health, quota
 * and model list for the UI extension — a direct browser fetch to
 * 127.0.0.1:8901 resolves to the CLIENT device and fails whenever SillyTavern
 * is browsed from a phone or another PC. GET only, so no body parser.
 */
export function mountStRoutes(router) {
    router.get('/status', safeRoute(handleStatus));
    router.get('/quota', safeRoute(handleQuota));
    router.get('/models', safeRoute((req, res) => handleModels(req, res, null)));
}

export async function init(router) {
    mountStRoutes(router);
    installUiExtension();
    const stale = sdkUpdateNeeded();
    if (stale) {
        console.warn(`[${info.id}] dependencies out of date: Agent SDK ${stale.installed} installed, ${stale.required} required. ` +
            'Run `npm install` in plugins/SillyTavern-Subscriptions and restart SillyTavern (SillyTavern updates plugin code but not its dependencies).');
    }

    const port = envInt('ST_SUBSCRIPTIONS_PORT', DEFAULT_PORT);
    const host = envString('ST_SUBSCRIPTIONS_HOST', DEFAULT_HOST);

    try {
        await startStandaloneListener({ port, host });
        console.log(`[${info.id}] initialised — endpoint http://${host}:${port}/v1 (open the "Subscriptions" panel in the Extensions drawer to connect)`);
    } catch (err) {
        console.error(`[${info.id}] failed to start standalone listener — chat completions will not work. Status endpoint on /api/plugins/${info.id}/status remains available.`, err);
    }
}

export async function exit() {
    stopAppServer();
    await stopStandaloneListener();
    console.log(`[${info.id}] shut down`);
}

export default { info, init, exit };
