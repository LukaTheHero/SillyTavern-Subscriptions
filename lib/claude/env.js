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
//   • Subscription with account isolation: empty plugin-owned config and
//     secure-storage dirs + the login's access token as CLAUDE_CODE_OAUTH_TOKEN
//     (see auth.js) — the CLI then has no account profile to put in prompts.
//   • API mode: base URL + token/key set explicitly and both config dirs
//     pointed at an empty plugin-owned directory so the subprocess cannot see
//     the real OAuth login (which would outrank the key). The user's real
//     credentials are never touched.
//   • Windows env names are case-insensitive, so scrubbing and every value
//     the plugin sets compare names upper-cased (`anthropic_api_key` must not
//     slip past the scrub, and must not shadow a value set here).

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

/** Set `name` after removing every case variant of it (Windows env names are case-insensitive). */
function setEnv(env, name, value) {
    const upper = name.toUpperCase();
    for (const k of Object.keys(env)) if (k.toUpperCase() === upper) delete env[k];
    if (value !== undefined) env[name] = value;
}

/**
 * @param {object} args
 * @param {Record<string,string>} args.envPins ANTHROPIC_DEFAULT_* pins from parseClaudeModel
 * @param {number|undefined} args.maxTokens
 * @param {{ mode: 'subscription', isolated?: boolean, oauthToken?: string, configDir?: string }
 *        | { mode: 'api', baseUrl?: string, apiKey?: string, authToken?: string, configDir: string }} args.auth
 * @param {boolean} [args.fastMode] request opted into fast mode
 * @param {boolean} [args.forceBudgetThinking] make the CLI send a fixed thinking budget instead of adaptive
 * @param {Record<string,string>} [args.base] base environment (defaults to process.env)
 */
export function buildSubprocessEnv({ envPins, maxTokens, auth, fastMode = false, forceBudgetThinking = false, base = process.env }) {
    const env = {};
    for (const [k, v] of Object.entries(base)) {
        if (v === undefined) continue;
        const name = k.toUpperCase();
        if (!KEEP.has(name) && (SCRUB_EXACT.has(name) || SCRUB_PREFIX.some((p) => name.startsWith(p)))) continue;
        env[k] = v;
    }

    // Request pins win over inherited shell env.
    for (const [k, v] of Object.entries({ ...envPins, ...FIXED_ENV })) setEnv(env, k, v);

    // Fast Mode in the headless SDK needs the interactive org check bypassed —
    // only when the request explicitly asked for it (it draws usage credits).
    if (fastMode) setEnv(env, 'CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK', '1');
    // "Thinking: On" on a hybrid model (Opus/Sonnet 4.6): the CLI otherwise
    // always prefers adaptive thinking there.
    if (forceBudgetThinking) setEnv(env, 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', '1');

    if (maxTokens) setEnv(env, 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', String(maxTokens));

    if (auth?.mode === 'api') {
        setEnv(env, 'CLAUDE_CODE_OAUTH_TOKEN', undefined);
        if (auth.baseUrl) setEnv(env, 'ANTHROPIC_BASE_URL', auth.baseUrl);
        if (auth.apiKey) setEnv(env, 'ANTHROPIC_API_KEY', auth.apiKey);
        if (auth.authToken) setEnv(env, 'ANTHROPIC_AUTH_TOKEN', auth.authToken);
        if (auth.configDir) {
            setEnv(env, 'CLAUDE_CONFIG_DIR', auth.configDir);
            setEnv(env, 'CLAUDE_SECURESTORAGE_CONFIG_DIR', auth.configDir);
        }
    } else if (auth?.mode === 'subscription' && auth.isolated && auth.oauthToken && auth.configDir) {
        setEnv(env, 'CLAUDE_CODE_OAUTH_TOKEN', auth.oauthToken);
        setEnv(env, 'CLAUDE_CONFIG_DIR', auth.configDir);
        // The real login store must stay invisible, or the CLI loads the full
        // profile (and the email) from it.
        setEnv(env, 'CLAUDE_SECURESTORAGE_CONFIG_DIR', auth.configDir);
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
