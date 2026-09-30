// ──────────────────────────────────────────────
// SDK subprocess environment builder
// ──────────────────────────────────────────────
//
// The Claude Code CLI resolves auth, model aliases and a long list of
// behaviours from its environment. Getting this env exactly right is what
// keeps subscription billing working and roleplay isolated:
//
//   • Scrubbed from the inherited env: every ANTHROPIC_* variable (a stray key
//     or base URL would silently flip billing off the subscription; model /
//     beta / header overrides would change the request), the CLI's own
//     CLAUDE_CODE_* / CLAUDE_AGENT_SDK_* variables and nested-session markers
//     (SillyTavern launched from a Claude Code terminal), OTEL_* (one of them
//     writes full request bodies to disk), and thinking / caching / compaction
//     overrides.
//   • ANTHROPIC_DEFAULT_<TIER>_MODEL pins resolve tier aliases (and the [1m]
//     alias forms) to exact versions.
//   • CLAUDE_CODE_MAX_OUTPUT_TOKENS carries SillyTavern's "Max response
//     length" to the CLI (the SDK has no per-query output cap option).
//   • No model substitution, ever: refusal fallback to another model, the
//     same-model refusal retry, model-access / usage-limit fallbacks and the
//     legacy-model remap are all switched off — a refusal reaches the user as
//     an error (see chat.js).
//   • Isolation: no @path attachments or per-turn reminders, no git status,
//     no token-count reminder, no terminal-title side call, no auto
//     compaction (SillyTavern manages context), no claude.ai MCP connectors.
//   • Subscription with account isolation: an empty plugin-owned
//     CLAUDE_CONFIG_DIR + the login as CLAUDE_CODE_OAUTH_TOKEN (see auth.js).
//   • API mode: base URL + token/key set explicitly and CLAUDE_CONFIG_DIR
//     pointed at an empty plugin-owned directory so the subprocess cannot see
//     the real OAuth login (which would outrank the key). The user's real
//     credentials file is never touched.

const SCRUB_EXACT = new Set([
    'CLAUDECODE',
    'CLAUDE_CONFIG_DIR_OVERRIDE',
    'MAX_THINKING_TOKENS',
    'DISABLE_INTERLEAVED_THINKING',
    'FALLBACK_FOR_ALL_PRIMARY_MODELS',
    'DISABLE_AUTO_COMPACT',
    'DISABLE_COMPACT',
]);
const SCRUB_PREFIX = ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'OTEL_', 'DISABLE_PROMPT_CACHING'];
// Scrubbed by prefix but meaningful to keep from the user's environment.
const KEEP = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH']);

/** Behaviour switches applied to every Claude subprocess. */
export const FIXED_ENV = Object.freeze({
    // no model substitution / refusal re-runs
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_REFUSAL_RETRY: '1',
    CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
    // isolation
    CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    // honest thinking display + no hidden extra calls
    CLAUDE_CODE_THINKING_DISPLAY_UPDATES: '0',
    DISABLE_AUTO_COMPACT: '1',
    // no auto-update checks from a proxy subprocess
    DISABLE_AUTOUPDATER: '1',
});

/**
 * @param {object} args
 * @param {Record<string,string>} args.envPins ANTHROPIC_DEFAULT_* pins from parseClaudeModel
 * @param {number|undefined} args.maxTokens
 * @param {{ mode: 'subscription', oauthToken?: string, configDir?: string }
 *        | { mode: 'api', baseUrl?: string, apiKey?: string, authToken?: string, configDir: string }} args.auth
 * @param {boolean} [args.fastMode] request opted into fast mode
 * @param {Record<string,string>} [args.base] base environment (defaults to process.env)
 */
export function buildSubprocessEnv({ envPins, maxTokens, auth, fastMode = false, base = process.env }) {
    const env = {};
    for (const [k, v] of Object.entries(base)) {
        if (v === undefined) continue;
        if (!KEEP.has(k) && (SCRUB_EXACT.has(k) || SCRUB_PREFIX.some((p) => k.startsWith(p)))) continue;
        env[k] = v;
    }

    // Request pins win over inherited shell env.
    Object.assign(env, envPins, FIXED_ENV);

    // Fast Mode in the headless SDK needs the interactive org check bypassed —
    // only when the request explicitly asked for it (it draws usage credits).
    if (fastMode) env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = '1';

    if (maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);

    if (auth?.mode === 'api') {
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        if (auth.baseUrl) env.ANTHROPIC_BASE_URL = auth.baseUrl;
        if (auth.apiKey) env.ANTHROPIC_API_KEY = auth.apiKey;
        if (auth.authToken) env.ANTHROPIC_AUTH_TOKEN = auth.authToken;
        if (auth.configDir) env.CLAUDE_CONFIG_DIR = auth.configDir;
    } else if (auth?.mode === 'subscription' && auth.oauthToken && auth.configDir) {
        env.CLAUDE_CODE_OAUTH_TOKEN = auth.oauthToken;
        env.CLAUDE_CONFIG_DIR = auth.configDir;
    }

    return env;
}

/** Bearer token from the request's Authorization header, minus ST's placeholders. */
export function bearerFromRequest(req) {
    const auth = req?.get?.('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const key = match[1].trim();
    if (!key || /^sk-no-key-needed$/i.test(key) || /^(none|null|undefined|placeholder|x|-)$/i.test(key)) return null;
    return key;
}

/** Genuine Anthropic API keys only (sk-ant-*). */
export function isAnthropicApiKey(key) {
    return /^sk-ant-/i.test(String(key ?? ''));
}
