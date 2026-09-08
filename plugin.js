// ──────────────────────────────────────────────
// SillyTavern Server Plugin — Subscriptions (Claude Max · Codex · Gemini)
// ──────────────────────────────────────────────
//
// One OpenAI-compatible proxy for three subscriptions:
//   • Claude  — Anthropic Pro/Max via the Claude Agent SDK (claude login)
//   • Codex   — ChatGPT Plus/Pro via the Codex CLI app-server (codex login)
//   • Gemini  — Google Antigravity via the agy CLI (agy sign-in)
// Each also has a pay-per-token "api" backend (the vendor API or a compatible relay)
// for overflow when a subscription window is exhausted.
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
//   ST_SUBSCRIPTIONS_NO_UI_INSTALL=1           skip the UI-extension auto-install
//   ST_SUBSCRIPTIONS_LIST_ALL_MODELS=1         list every provider's models even when unusable here
//   ST_SUBSCRIPTIONS_CLAUDE_PATH=…             explicit claude executable (Termux etc.)
//   ST_SUBSCRIPTIONS_CLAUDE_USE_RESUME=0       force the transcript-fold path for Claude
//   ST_SUBSCRIPTIONS_CLAUDE_MAX_TURNS=N        SDK maxTurns override (default 1)
//   ST_SUBSCRIPTIONS_CLAUDE_API_KEY / _BASE_URL   Claude "api" backend credentials
//   ST_SUBSCRIPTIONS_CODEX_PATH=…              explicit codex executable
//   ST_SUBSCRIPTIONS_CODEX_HOME=…              CODEX_HOME to use (e.g. ~/.codex)
//   ST_SUBSCRIPTIONS_CODEX_API_KEY / _BASE_URL    Codex "api" backend credentials
//   ST_SUBSCRIPTIONS_AGY_PATH=…                explicit agy executable
//   ST_SUBSCRIPTIONS_GEMINI_API_KEY / _BASE_URL   Gemini "api" backend credentials

import express from 'express';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStandaloneListener, stopStandaloneListener, handleStatus, handleQuota, handleModels } from './lib/listener.js';
import { stopAppServer } from './lib/codex/app-server.js';
import { envInt, envString, envFlag } from './lib/common/platform.js';

const DEFAULT_PORT = 8901;
const DEFAULT_HOST = '127.0.0.1';
const UI_EXTENSION_DIR_NAME = 'SillyTavern-Subscriptions-UI';
const DIALOG_CLONE_DIR_NAME = 'SillyTavern-Subscriptions';
const UI_EXTENSION_FILES = ['manifest.json', 'index.js', 'style.css'];

const LEGACY_PLUGIN_DIRS = ['SillyTavern-ClaudeSubscription', 'SillyTavern-GeminiSubscription', 'SillyTavern-CodexSubscription'];
const LEGACY_UI_DIRS = ['SillyTavern-ClaudeMax', 'SillyTavern-GeminiAntigravity', 'SillyTavern-CodexMax', ...LEGACY_PLUGIN_DIRS];

export const info = {
    id: 'subscriptions',
    name: 'Subscriptions (Claude Max · Codex · Gemini)',
    description:
        'One OpenAI-compatible proxy that bills chat against your Claude Pro/Max, ChatGPT/Codex and Google Antigravity ' +
        'subscriptions (with pay-per-token overflow). Pick the provider and model from inside SillyTavern via the ' +
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

/** Warn loudly about the three predecessor plugins/extensions still being installed. */
function warnAboutLegacyInstalls(stRoot) {
    try {
        const pluginsDir = resolve(here(), '..');
        const present = readdirSync(pluginsDir).filter((d) => LEGACY_PLUGIN_DIRS.includes(d));
        if (present.length) {
            console.warn(
                `[${info.id}] legacy server plugin(s) still installed next to this one: ${present.join(', ')}. ` +
                'They are replaced by SillyTavern-Subscriptions and will fight over ports/panels — move them out of plugins/ and restart.',
            );
        }
    } catch { /* ignore */ }
    try {
        const thirdParty = join(stRoot, 'public', 'scripts', 'extensions', 'third-party');
        const present = readdirSync(thirdParty).filter((d) => LEGACY_UI_DIRS.includes(d));
        if (present.length) {
            console.warn(
                `[${info.id}] legacy UI extension(s) still installed: ${present.join(', ')}. ` +
                'Their panels are superseded by the "Subscriptions" panel — delete those folders (or disable them in Extensions) to avoid duplicate settings injection.',
            );
        }
    } catch { /* ignore */ }
}

/**
 * Install or update the companion UI extension into SillyTavern's third-party
 * extensions directory. Version-gated: only copies when missing or strictly
 * older. Stands down when the repo was installed through SillyTavern's
 * "Install extension" dialog (a git-managed clone ST updates itself).
 */
function installUiExtension() {
    if (envFlag('ST_SUBSCRIPTIONS_NO_UI_INSTALL', false)) return;
    try {
        const root = here();
        if (!existsSync(join(root, 'manifest.json'))) return;
        const stRoot = resolve(root, '..', '..');
        const thirdParty = join(stRoot, 'public', 'scripts', 'extensions', 'third-party');
        if (!existsSync(thirdParty)) {
            console.warn(`[${info.id}] SillyTavern third-party extension dir not found at ${thirdParty} — install the UI extension manually (see README).`);
            return;
        }
        warnAboutLegacyInstalls(stRoot);

        // Installed through SillyTavern's "Install extension" dialog? That clone
        // is git-managed by ST (update/remove buttons work) — leave it alone.
        // Global installs land in third-party/, per-user ones in data/<user>/extensions/.
        const dialogClones = [join(thirdParty, DIALOG_CLONE_DIR_NAME)];
        try {
            for (const user of readdirSync(join(stRoot, 'data'))) {
                dialogClones.push(join(stRoot, 'data', user, 'extensions', DIALOG_CLONE_DIR_NAME));
            }
        } catch { /* no data dir */ }
        if (dialogClones.some((d) => existsSync(join(d, 'manifest.json')))) {
            console.log(`[${info.id}] UI extension already installed via SillyTavern's extension installer — auto-install skipped`);
            return;
        }

        const target = join(thirdParty, UI_EXTENSION_DIR_NAME);
        const srcVersion = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version ?? '0.0.0';
        let installedVersion = null;
        if (existsSync(join(target, 'manifest.json'))) {
            try { installedVersion = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).version ?? '0.0.0'; } catch { /* reinstall */ }
        }
        if (installedVersion !== null && !isNewerVersion(srcVersion, installedVersion)) return;

        mkdirSync(target, { recursive: true });
        for (const file of UI_EXTENSION_FILES) cpSync(join(root, file), join(target, file));
        console.log(
            `[${info.id}] ${installedVersion ? `updated UI extension ${installedVersion} → ${srcVersion}` : `installed UI extension v${srcVersion}`} ` +
            `at public/scripts/extensions/third-party/${UI_EXTENSION_DIR_NAME} (hard-refresh the browser to load it)`,
        );
    } catch (err) {
        console.warn(`[${info.id}] UI extension auto-install failed:`, err instanceof Error ? err.message : err);
    }
}

export async function init(router) {
    // SillyTavern-mounted routes (GET is CSRF-exempt): same-origin health,
    // quota and model list for the UI extension — a direct browser fetch to
    // 127.0.0.1:8901 resolves to the CLIENT device and fails whenever
    // SillyTavern is browsed from a phone or another PC.
    router.use(express.json({ limit: '1mb' }));
    router.get('/status', handleStatus);
    router.get('/quota', handleQuota);
    router.get('/models', (req, res) => handleModels(req, res, null));

    installUiExtension();

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
