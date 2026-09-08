// ──────────────────────────────────────────────
// Platform helpers — Windows / Linux / macOS / Termux (Android)
// ──────────────────────────────────────────────
//
// Termux notes: Node on Termux reports process.platform === 'android'. Its
// shell prefix ($PREFIX, normally /data/data/com.termux/files/usr) holds
// npm's global bin dir, and $HOME is /data/data/com.termux/files/home.
// Native CLIs installed from npm (Codex, Claude Code) are linux-arm64 musl
// binaries which usually run fine on Termux; the Claude Agent SDK's own
// platform lookup, however, keys on process.platform and finds nothing for
// 'android' — see lib/claude/sdk-loader.js for the fallback.

import { homedir } from 'node:os';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_ANDROID = process.platform === 'android';
export const IS_TERMUX = IS_ANDROID
    || !!process.env.TERMUX_VERSION
    || String(process.env.PREFIX ?? '').includes('com.termux');
export const IS_LINUX_LIKE = process.platform === 'linux' || IS_ANDROID;

/** Termux's usr prefix (where npm -g installs binaries). */
export function termuxPrefix() {
    return process.env.PREFIX || '/data/data/com.termux/files/usr';
}

export function home() {
    return homedir();
}

/** "1/true/yes/on" → true, "0/false/no/off" → false, unset → fallback. */
export function envFlag(name, fallback = false) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return !/^(0|false|no|off)$/i.test(v);
}

export function envString(name, fallback = undefined) {
    const v = process.env[name];
    return v === undefined || v === '' ? fallback : v;
}

export function envInt(name, fallback) {
    const v = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(v) ? v : fallback;
}

/** Human-readable platform label for status output. */
export function platformLabel() {
    if (IS_TERMUX) return `termux (${process.platform}-${process.arch})`;
    return `${process.platform}-${process.arch}`;
}
