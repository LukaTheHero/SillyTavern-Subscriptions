// ──────────────────────────────────────────────
// SDK subprocess environment builder
// ──────────────────────────────────────────────
//
// The Claude Code CLI resolves auth and model aliases from its environment.
// Getting this env exactly right is what keeps subscription billing working:
//
//   • ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL are
//     SCRUBBED unless the request opted into API billing — any stray key in
//     SillyTavern's process env would silently flip billing off the
//     subscription.
//   • Nested-session markers (CLAUDECODE, CLAUDE_CODE_*) are scrubbed too:
//     when SillyTavern itself was launched from inside a Claude Code
//     terminal, the CLI would otherwise refuse to start or attach to the
//     parent session's sockets.
//   • ANTHROPIC_DEFAULT_<TIER>_MODEL pins resolve tier aliases (and the
//     [1m] alias forms) to exact versions.
//   • CLAUDE_CODE_MAX_OUTPUT_TOKENS carries SillyTavern's "Max response
//     length" to the CLI (the SDK has no per-query output cap option).
//   • ENABLE_CLAUDEAI_MCP_SERVERS=false kills claude.ai account connectors
//     (Notion/Gmail/etc.) that would otherwise reach the model.
//   • API mode: base URL + token/key set explicitly and CLAUDE_CONFIG_DIR
//     pointed at an empty plugin-owned directory so the subprocess cannot see
//     the real OAuth login (which would outrank the key). The user's real
//     credentials file is never touched.

const SCRUB_EXACT = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDECODE',
    'CLAUDE_CONFIG_DIR_OVERRIDE',
];
const SCRUB_PREFIX = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_'];
// Nested-session variables we scrub by prefix but must re-add ourselves.
const KEEP_CLAUDE_CODE = ['CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * @param {object} args
 * @param {Record<string,string>} args.envPins ANTHROPIC_DEFAULT_* pins from parseClaudeModel
 * @param {number|undefined} args.maxTokens
 * @param {{ mode: 'subscription' } | { mode: 'api', baseUrl?: string, apiKey?: string, authToken?: string, configDir: string }} args.auth
 * @param {Record<string,string>} [args.base] base environment (defaults to process.env)
 */
export function buildSubprocessEnv({ envPins, maxTokens, auth, base = process.env }) {
    const env = {};
    for (const [k, v] of Object.entries(base)) {
        if (v === undefined) continue;
        if (SCRUB_EXACT.includes(k)) continue;
        if (SCRUB_PREFIX.some((p) => k.startsWith(p)) && !KEEP_CLAUDE_CODE.includes(k)) continue;
        env[k] = v;
    }

    // Request pins win over inherited shell env.
    Object.assign(env, envPins);

    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    // Fast Mode in headless Agent SDK: bypass the interactive org check.
    env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = '1';
    // No auto-update checks / telemetry chatter from a proxy subprocess.
    env.DISABLE_AUTOUPDATER = '1';

    if (maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);

    if (auth?.mode === 'api') {
        if (auth.baseUrl) env.ANTHROPIC_BASE_URL = auth.baseUrl;
        if (auth.apiKey) env.ANTHROPIC_API_KEY = auth.apiKey;
        if (auth.authToken) env.ANTHROPIC_AUTH_TOKEN = auth.authToken;
        if (auth.configDir) env.CLAUDE_CONFIG_DIR = auth.configDir;
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
