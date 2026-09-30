// ──────────────────────────────────────────────
// OAuth credentials, refresh, quota, rate-limit capture, error classification
// ──────────────────────────────────────────────
//
// Credentials: the Claude Code CLI keeps its subscription login in its
// "secure storage" — <dir>/.credentials.json (Linux, Windows, and macOS as a
// fallback) or the macOS login Keychain — where <dir> is
// CLAUDE_SECURESTORAGE_CONFIG_DIR when set, else CLAUDE_CONFIG_DIR, else
// ~/.claude, and the Keychain item is "Claude Code-credentials" plus a hash
// suffix for a non-default dir (both computed here exactly as the CLI does).
// Or the user supplies a long-lived CLAUDE_CODE_OAUTH_TOKEN (`claude
// setup-token`). readSubscriptionLogin() reads whichever exists;
// subscriptionAccessToken() turns it into the token the account-isolated
// subprocess gets (see auth.js); credentialSummary() reports present:
// true | false | 'unknown' (a store we cannot read, never "logged out").
//
// Refresh: the CLI refreshes its own token, but when a login elsewhere rotates
// the refresh token or the access token expires mid-idle, queries fail with
// auth errors. The fix is an out-of-band refresh against the
// platform token endpoint followed by ONE retry. The file write mirrors the
// CLI's: under its `.storage-write` lock, mode 0600, atomic rename with
// retries (Windows holds the file open briefly), and the on-disk refresh token
// re-checked inside the lock so a concurrent CLI rotation always wins.
//
// Quota: two sources, cheapest first.
//   1. Every SDK query streams `rate_limit_event` messages carrying the
//      five-hour / seven-day utilisation — captured here for free.
//   2. GET https://api.anthropic.com/api/oauth/usage for OAuth tokens —
//      polled on demand by the panel's refresh button.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmdirSync, statSync, chmodSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

const TAG = '[subscriptions/claude]';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_BETA_HEADER = 'oauth-2025-04-20';
const USAGE_CACHE_TTL_MS = 30000;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_CACHE_MS = 60000;
const LOCK_STALE_MS = 15000;

/** The directory holding the CLI's login (its "secure storage" dir). */
export function secureStorageDir() {
    const ss = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    if (ss !== undefined) return (ss || join(homedir(), '.claude')).normalize('NFC');
    return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function credentialsPath() {
    return join(secureStorageDir(), '.credentials.json');
}

/** Keychain service name, as the CLI derives it. */
export function keychainServiceName() {
    const ss = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const unsuffixed = ss !== undefined ? !ss : !process.env.CLAUDE_CONFIG_DIR;
    if (unsuffixed) return KEYCHAIN_SERVICE;
    const dir = (ss !== undefined ? ss : process.env.CLAUDE_CONFIG_DIR).normalize('NFC');
    return `${KEYCHAIN_SERVICE}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
}

export function readCredentials() {
    try {
        return JSON.parse(readFileSync(credentialsPath(), 'utf8'));
    } catch {
        return null;
    }
}

// ── macOS Keychain (read-only; the CLI owns writes) ──

let keychainCache = { at: 0, service: null, value: undefined };

async function readKeychainCredentials() {
    if (process.platform !== 'darwin') return null;
    const service = keychainServiceName();
    if (keychainCache.service === service && Date.now() - keychainCache.at < KEYCHAIN_CACHE_MS) return keychainCache.value;
    let value = null;
    try {
        const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 });
        const parsed = JSON.parse(String(stdout).trim());
        if (parsed?.claudeAiOauth?.accessToken) value = parsed;
    } catch { /* no item, locked keychain, or access denied */ }
    keychainCache = { at: Date.now(), service, value };
    return value;
}

/**
 * The subscription login the CLI would use, without spending it.
 * @returns {Promise<{ source: 'env'|'file'|'keychain', accessToken: string, refreshToken?: string,
 *   expiresAt?: number, subscriptionType?: string, rateLimitTier?: string } | null>}
 */
export async function readSubscriptionLogin() {
    const envToken = String(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
    if (envToken) return { source: 'env', accessToken: envToken };
    const file = readCredentials()?.claudeAiOauth;
    if (file?.accessToken) {
        return { source: 'file', accessToken: file.accessToken, refreshToken: file.refreshToken, expiresAt: Number(file.expiresAt) || 0, subscriptionType: file.subscriptionType, rateLimitTier: file.rateLimitTier };
    }
    const kc = (await readKeychainCredentials())?.claudeAiOauth;
    if (kc?.accessToken) {
        return { source: 'keychain', accessToken: kc.accessToken, refreshToken: kc.refreshToken, expiresAt: Number(kc.expiresAt) || 0, subscriptionType: kc.subscriptionType, rateLimitTier: kc.rateLimitTier };
    }
    return null;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * A usable access token for the account-isolated subprocess (see auth.js).
 * A file login that is about to expire is refreshed first (under the CLI's
 * lock); a Keychain login is used while still valid — the plugin never writes
 * the Keychain. Returns { login } or { reason } when no token can be supplied.
 */
export async function subscriptionAccessToken() {
    let login = await readSubscriptionLogin();
    if (!login) return { reason: 'unreadable' };
    if (login.source === 'env') return { login };
    const expiring = !login.expiresAt || login.expiresAt - Date.now() < REFRESH_MARGIN_MS;
    if (expiring && login.source === 'file' && login.refreshToken) {
        await refreshOAuthToken();
        login = await readSubscriptionLogin();
        if (!login) return { reason: 'unreadable' };
    }
    if (login.expiresAt && login.expiresAt <= Date.now()) return { reason: login.source === 'keychain' ? 'keychain-expired' : 'expired' };
    return { login };
}

// ── Error classifiers ──
// They run over CLI error text. Numbers must only match as HTTP status codes
// ("API Error: 429", "(429)", "status 401") — a bare "429" also appears in
// token counts, message indexes ("messages.429.content") and request ids.

const hasStatus = (s, code) => new RegExp(`(?:^|api error:?\\s*|\\(|status(?: code)?:?\\s*|http\\s*)${code}(?![\\d.])`).test(s);

export function isExpiredTokenError(text) {
    const s = String(text ?? '').toLowerCase();
    return (
        s.includes('oauth token has expired') ||
        s.includes('token_expired') ||
        s.includes('invalid_token') ||
        s.includes('not logged in') ||
        s.includes('please run /login') ||
        s.includes('authentication expired') ||
        s.includes('authentication_failed') ||
        s.includes('invalid api key') ||
        (hasStatus(s, '401') && /authentication|unauthorized/.test(s))
    );
}

export function isRateLimitError(text) {
    const s = String(text ?? '').toLowerCase();
    return hasStatus(s, '429') || /rate[ _]limit|too many requests|hit your limit|usage limit/.test(s);
}

/** Subscription window exhausted (not a transient 429) — the API-overflow trigger. */
export function isQuotaExhaustedError(text) {
    const s = String(text ?? '').toLowerCase();
    return s.includes("you've hit your limit") || s.includes('hit your limit') || s.includes('usage limit reached')
        || s.includes('limit will reset') || s.includes('resets at') || s.includes('out of extra usage')
        || /reached your \w+ limit/.test(s);
}

/** 1M context not available on this plan without usage credits / Extra Usage. */
export function isExtraUsageRequiredError(text) {
    const s = String(text ?? '').toLowerCase();
    return /usage credits required for 1m context|long_context_credits_required/.test(s)
        || (s.includes('extra usage') && s.includes('1m')) || s.includes('out of extra usage');
}

export function isStaleSessionError(text) {
    const s = String(text ?? '').toLowerCase();
    return s.includes('no conversation found');
}

/** A safety classifier declined the request (every wording CLI 2.1.285 uses). */
export function isSafeguardError(text) {
    const s = String(text ?? '').toLowerCase();
    return s.includes('safeguards flagged')
        || /can't help with this\. start a new session/.test(s)
        || s.includes('output blocked by content filtering')
        || (s.includes("can't respond to") && s.includes('safeguard'));
}

/** "Claude Code X does not support this model; version Y or newer is required." */
export function isCliTooOldError(text) {
    const s = String(text ?? '').toLowerCase();
    return s.includes('does not support this model') && s.includes('newer is required');
}

// ── Out-of-band token refresh (in-flight dedup) ──

let inflightRefresh = null;

export function refreshOAuthToken() {
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = doRefresh().finally(() => { inflightRefresh = null; });
    return inflightRefresh;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** mkdir-based lock compatible with the CLI's proper-lockfile use on `<configDir>/.storage-write`. */
async function withStorageLock(dir, fn) {
    const lockDir = join(dir, '.storage-write.lock');
    let locked = false;
    for (let attempt = 0; attempt < 30 && !locked; attempt++) {
        try {
            mkdirSync(lockDir);
            locked = true;
        } catch (err) {
            if (err?.code !== 'EEXIST') break; // unwritable dir — proceed unlocked
            try {
                if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) { rmdirSync(lockDir); continue; }
            } catch { continue; }
            await sleep(100 + attempt * 50);
        }
    }
    try {
        return await fn();
    } finally {
        if (locked) { try { rmdirSync(lockDir); } catch { /* ignore */ } }
    }
}

async function writeCredentialsAtomic(path, data) {
    const json = JSON.stringify(data, null, 2);
    const tmpPath = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(tmpPath, json, { mode: 0o600 });
        let renamed = false;
        for (let i = 0; i < 10 && !renamed; i++) {
            try { renameSync(tmpPath, path); renamed = true; } catch (err) {
                if (!['EPERM', 'EACCES', 'EBUSY'].includes(err?.code)) throw err;
                await sleep(50 * (i + 1)); // another process holds the file open briefly
            }
        }
        if (!renamed) writeFileSync(path, json, { mode: 0o600 });
        try { chmodSync(path, 0o600); } catch { /* no-op on Windows */ }
    } finally {
        try { unlinkSync(tmpPath); } catch { /* already renamed */ }
    }
}

async function doRefresh() {
    const path = credentialsPath();
    const creds = readCredentials();
    const refreshToken = creds?.claudeAiOauth?.refreshToken;
    if (!refreshToken) {
        if (existsSync(path)) console.warn(`${TAG} token refresh skipped: no refresh token in the credentials file`);
        return false;
    }
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grant_type: 'refresh_token', client_id: OAUTH_CLIENT_ID, refresh_token: refreshToken }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            // Another process may have rotated the token first — that is a success.
            if (readCredentials()?.claudeAiOauth?.refreshToken !== refreshToken) {
                console.log(`${TAG} credentials were rotated by Claude Code — using its copy`);
                return true;
            }
            console.warn(`${TAG} token refresh failed: HTTP ${res.status}. Run \`claude auth login\` on this host.`);
            return false;
        }
        const data = await res.json();
        return await withStorageLock(dirname(path), async () => {
            // Refresh tokens ROTATE and the CLI manages the same file — re-read
            // inside the lock; if another process already rotated, keep its copy.
            const latest = readCredentials() ?? creds;
            const onDiskToken = latest?.claudeAiOauth?.refreshToken;
            if (onDiskToken && onDiskToken !== refreshToken) {
                console.log(`${TAG} credentials rotated by another process — keeping the on-disk copy`);
                return true;
            }
            const now = Date.now();
            latest.claudeAiOauth = {
                ...latest.claudeAiOauth,
                accessToken: data.access_token ?? latest.claudeAiOauth?.accessToken,
                refreshToken: data.refresh_token ?? refreshToken,
                expiresAt: data.expires_in ? now + data.expires_in * 1000 : now + 8 * 3600 * 1000,
                ...(typeof data.scope === 'string' ? { scopes: data.scope.split(/\s+/).filter(Boolean) } : {}),
            };
            await writeCredentialsAtomic(path, latest);
            console.log(`${TAG} OAuth token refreshed`);
            return true;
        });
    } catch (err) {
        console.warn(`${TAG} token refresh error:`, err instanceof Error ? err.message : err);
        return false;
    }
}

// ── Rate-limit capture from the query stream (free, live) ──

let lastRateLimit = null;

const msTime = (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : null);

/** Called with `message.rate_limit_info` from SDK `rate_limit_event` messages. */
export function recordRateLimitEvent(info) {
    if (!info || typeof info !== 'object') return;
    const windows = [];
    for (const [key, w] of Object.entries(info.unifiedWindows ?? {})) {
        if (!w) continue;
        const utilization = typeof w.utilization === 'number' ? Math.max(0, w.utilization) : null;
        const resetsAt = msTime(w.resetsAt);
        if (utilization === null && resetsAt === null) continue;
        windows.push({ type: key, utilization, resetsAt });
    }
    // Older / simpler events carry one window at the top level.
    if (!windows.length && info.rateLimitType) {
        const utilization = typeof info.utilization === 'number' ? Math.max(0, info.utilization) : null;
        const resetsAt = msTime(info.resetsAt);
        if (utilization !== null || resetsAt !== null) windows.push({ type: info.rateLimitType, utilization, resetsAt });
    }
    lastRateLimit = {
        status: info.status ?? null,
        rateLimitType: info.rateLimitType ?? null,
        overageStatus: info.overageStatus ?? null,
        isUsingOverage: !!info.isUsingOverage,
        windows,
        observedAt: Date.now(),
    };
}

export function latestRateLimit() {
    return lastRateLimit;
}

// ── Quota polling (OAuth usage endpoint) ──

const WINDOW_TYPES = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps', 'cinder_cove'];

let quotaCache = null;
let inflightQuota = null;

export async function fetchQuota({ force = false, authRetried = false } = {}) {
    if (!force && quotaCache && Date.now() - quotaCache.fetchedAt < USAGE_CACHE_TTL_MS) return quotaCache;

    const token = (await readSubscriptionLogin())?.accessToken;
    if (!token) return null;

    let res;
    try {
        res = await fetch(USAGE_URL, {
            headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': USAGE_BETA_HEADER, Accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
    } catch (err) {
        console.warn(`${TAG} quota fetch failed:`, err instanceof Error ? err.message : err);
        return null;
    }

    if (res.status === 401) {
        if (authRetried || !(await refreshOAuthToken())) return null;
        return fetchQuota({ force: true, authRetried: true });
    }
    if (!res.ok) {
        console.warn(`${TAG} quota endpoint returned HTTP ${res.status} (429 = transient rate limit; retry later)`);
        return null;
    }

    let raw;
    try { raw = await res.json(); } catch { return null; }

    const windows = [];
    for (const key of WINDOW_TYPES) {
        const w = raw?.[key];
        if (!w) continue;
        const utilization = typeof w.utilization === 'number' && Number.isFinite(w.utilization) ? Math.max(0, w.utilization / 100) : null;
        const resetsAt = w.resets_at ? Date.parse(w.resets_at) || null : null;
        if (utilization === null && resetsAt === null) continue;
        windows.push({ type: key, utilization, resetsAt });
    }
    // Per-model weekly caps (Fable etc.) arrive only as limits[] rows.
    for (const row of Array.isArray(raw?.limits) ? raw.limits : []) {
        const name = row?.scope?.model?.display_name;
        if (row?.kind !== 'weekly_scoped' || !name || !Number.isFinite(row.percent)) continue;
        const type = `seven_day_${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
        if (windows.some((w) => w.type === type)) continue;
        windows.push({ type, utilization: Math.max(0, row.percent / 100), resetsAt: Date.parse(row.resets_at) || null, label: `7-day (${name})` });
    }

    const extra = raw?.extra_usage;
    // monthly_limit / used_credits are minor units (cents for USD).
    const extraUsage = extra
        ? { isEnabled: !!extra.is_enabled, monthlyLimit: (extra.monthly_limit ?? 0) / 100, usedCredits: (extra.used_credits ?? 0) / 100, currency: extra.currency ?? 'USD' }
        : null;

    quotaCache = { windows, extraUsage, fetchedAt: Date.now() };
    return quotaCache;
}

/** Quota snapshot for the panel: OAuth usage endpoint, else the last streamed rate-limit event. */
export async function claudeQuota() {
    inflightQuota ??= fetchQuota().finally(() => { inflightQuota = null; });
    const polled = await inflightQuota;
    if (polled) return { ok: true, source: 'oauth-usage', ...polled, live: lastRateLimit };
    if (lastRateLimit) return { ok: true, source: 'rate-limit-event', windows: lastRateLimit.windows, extraUsage: null, fetchedAt: lastRateLimit.observedAt, live: lastRateLimit };
    return { ok: false, message: 'Quota unavailable (no readable OAuth login, or the usage endpoint did not answer).' };
}

/**
 * Lightweight credential summary for /status. No secrets, no absolute path.
 * present: true | false | 'unknown' — 'unknown' when the login may live in a
 * store the plugin cannot read (Windows Credential Manager, a locked Keychain).
 */
export async function credentialSummary() {
    const login = await readSubscriptionLogin();
    const source = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined ? 'CLAUDE_SECURESTORAGE_CONFIG_DIR' : (process.env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR' : 'home');
    if (login?.source === 'env') {
        return { present: true, source: 'env:CLAUDE_CODE_OAUTH_TOKEN', subscriptionType: 'unknown', rateLimitTier: null, expiresAt: 0, expired: false, hasRefreshToken: false };
    }
    if (login) {
        const expiresAt = login.expiresAt || 0;
        return {
            present: true,
            source: login.source === 'keychain' ? 'macos-keychain' : source,
            subscriptionType: login.subscriptionType ?? 'unknown',
            rateLimitTier: login.rateLimitTier ?? null,
            expiresAt,
            expired: expiresAt > 0 && expiresAt < Date.now(),
            hasRefreshToken: !!login.refreshToken,
        };
    }
    const unreadableStore = process.platform === 'darwin' || process.platform === 'win32';
    return { present: unreadableStore ? 'unknown' : false, source };
}

/** Synchronous best-effort variant (file / env only) for hot paths. */
export function credentialSummarySync() {
    if (String(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim()) return { present: true, source: 'env:CLAUDE_CODE_OAUTH_TOKEN' };
    if (readCredentials()?.claudeAiOauth?.accessToken) return { present: true, source: 'file' };
    return { present: process.platform === 'darwin' || process.platform === 'win32' ? 'unknown' : false };
}
