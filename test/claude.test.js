import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    parseClaudeModel, isAdaptiveOnlyModel, listClaudeModels, CANONICAL_TIER_MODELS, CLAUDE_MODELS,
    clampClaudeEffort, canonicalClaudeModelId,
} from '../lib/claude/models.js';
import { buildSubprocessEnv, bearerFromRequest, isAnthropicApiKey, FIXED_ENV } from '../lib/claude/env.js';
import {
    isCliTooOldError, isQuotaExhaustedError, isRateLimitError, isExpiredTokenError, isExtraUsageRequiredError,
    isSafeguardError, recordRateLimitEvent, latestRateLimit,
} from '../lib/claude/oauth.js';
import { buildSystemPrompt } from '../lib/claude/system-prompt.js';
import { splitHistoryForResume, assembleEntries } from '../lib/claude/jsonl-entries.js';
import { partitionConversation, splitConversation, foldConversation } from '../lib/common/messages.js';

// Keep the runner tests away from the real login store and executable lookup.
process.env.ST_SUBSCRIPTIONS_CLAUDE_ISOLATE_ACCOUNT = '0';

function withEnv(patch, fn) {
    const saved = { ...process.env };
    return (async () => {
        try {
            for (const k of Object.keys(process.env)) if (/^(ST_SUBSCRIPTIONS_CLAUDE_(API_KEY|BASE_URL)|ANTHROPIC_|CLAUDE_CONFIG_DIR)/.test(k)) delete process.env[k];
            Object.assign(process.env, patch);
            return await fn();
        } finally {
            for (const k of Object.keys(process.env)) delete process.env[k];
            Object.assign(process.env, saved);
        }
    })();
}

// ── catalog / model parsing ──

test('catalog leads with Opus 5.5 and knows Sonnet 5 / 5.5', () => {
    assert.equal(CLAUDE_MODELS[0].id, 'claude-opus-5-5');
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-fable-5-1']) {
        assert.ok(CLAUDE_MODELS.some((m) => m.id === id), id);
    }
    assert.equal(CANONICAL_TIER_MODELS.opus, 'claude-opus-5-5');
    assert.equal(CANONICAL_TIER_MODELS.sonnet, 'claude-sonnet-5-5');
});

test('native-1M models have one list entry; [1m] variants only for 4.6', () => {
    const ids = listClaudeModels().map((m) => m.id);
    assert.ok(!ids.includes('claude-fable-5-1[1m]'));
    assert.ok(!ids.includes('claude-opus-5-5[1m]'));
    assert.ok(ids.includes('claude-opus-4-6[1m]'));
    assert.ok(ids.includes('claude-sonnet-4-6[1m]'));
    const opus55 = listClaudeModels().find((m) => m.id === 'claude-opus-5-5');
    assert.equal(opus55.context_window, 1000000);
    assert.equal(opus55.default_effort, 'medium');
    assert.equal(opus55.thinking, 'always');
});

test('parseClaudeModel: Opus 5.5, dotted ids, legacy [1m] on native models, aliases', () => {
    const o = parseClaudeModel('claude-opus-5-5');
    assert.equal(o.baseId, 'claude-opus-5-5');
    assert.equal(o.sdkModel, 'claude-opus-5-5');
    assert.equal(o.tier, 'opus');
    assert.equal(o.thinking, 'always');
    assert.equal(o.envPins.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5');

    assert.equal(parseClaudeModel('claude-opus-5.5').baseId, 'claude-opus-5-5');
    assert.equal(parseClaudeModel('claude-opus-6.1').baseId, 'claude-opus-6-1'); // unknown id: dots → dashes

    const legacy = parseClaudeModel('claude-fable-5-1[1m]');
    assert.equal(legacy.oneM, false);
    assert.equal(legacy.sdkModel, 'claude-fable-5-1');
    assert.equal(legacy.context, 1000000);

    const s46 = parseClaudeModel('claude-sonnet-4-6[1m]');
    assert.equal(s46.oneM, true);
    assert.equal(s46.sdkModel, 'sonnet[1m]');
    assert.equal(s46.envPins.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6');

    const alias = parseClaudeModel('opus');
    assert.equal(alias.baseId, 'claude-opus-5-5');
    assert.equal(alias.envPins.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5');
    assert.equal(parseClaudeModel('sonnet[1m]').baseId, 'claude-sonnet-5-5');
});

test('thinking families and adaptive-only detection', () => {
    assert.equal(parseClaudeModel('claude-sonnet-5-5').thinking, 'always');
    assert.equal(parseClaudeModel('claude-opus-5').thinking, 'adaptive');
    assert.equal(parseClaudeModel('claude-opus-4-8').thinking, 'adaptive');
    assert.equal(parseClaudeModel('claude-sonnet-4-6').thinking, 'hybrid');
    assert.equal(parseClaudeModel('claude-haiku-4-5').thinking, 'budget');
    assert.equal(isAdaptiveOnlyModel('claude-opus-4-6'), false);
    assert.equal(isAdaptiveOnlyModel('claude-opus-4-7'), true);
    assert.equal(isAdaptiveOnlyModel('claude-opus-9'), true);
});

test('clampClaudeEffort steps down or drops unsupported levels', () => {
    assert.equal(clampClaudeEffort(parseClaudeModel('claude-sonnet-4-6'), 'xhigh'), 'high');
    assert.equal(clampClaudeEffort(parseClaudeModel('claude-sonnet-4-6'), 'max'), 'max');
    assert.equal(clampClaudeEffort(parseClaudeModel('claude-haiku-4-5'), 'high'), undefined);
    assert.equal(clampClaudeEffort(parseClaudeModel('claude-opus-5-5'), 'xhigh'), 'xhigh');
    assert.equal(clampClaudeEffort(parseClaudeModel('claude-opus-5-5'), undefined), undefined);
});

test('canonicalClaudeModelId strips [1m], dates, -fast and dots', () => {
    assert.equal(canonicalClaudeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.equal(canonicalClaudeModelId('claude-opus-5-5[1m]'), 'claude-opus-5-5');
    assert.equal(canonicalClaudeModelId('claude-opus-5-5-fast'), 'claude-opus-5-5');
    assert.equal(canonicalClaudeModelId('Claude-Opus-5.5'), 'claude-opus-5-5');
});

// ── subprocess env ──

test('buildSubprocessEnv scrubs, pins, isolates and never enables substitution', () => {
    const base = {
        PATH: 'x', KEEP_ME: '1',
        ANTHROPIC_API_KEY: 'leak', ANTHROPIC_BASE_URL: 'https://leak', ANTHROPIC_BETAS: 'x', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'x',
        CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_OAUTH_TOKEN: 'keep',
        OTEL_LOG_RAW_API_BODIES: 'file:/tmp', MAX_THINKING_TOKENS: '9999', DISABLE_PROMPT_CACHING: '1',
    };
    const sub = buildSubprocessEnv({ envPins: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5' }, maxTokens: 512, auth: { mode: 'subscription' }, base });
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BETAS', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'OTEL_LOG_RAW_API_BODIES', 'MAX_THINKING_TOKENS', 'DISABLE_PROMPT_CACHING']) {
        assert.equal(sub[k], undefined, k);
    }
    assert.equal(sub.CLAUDE_CODE_OAUTH_TOKEN, 'keep');
    assert.equal(sub.KEEP_ME, '1');
    assert.equal(sub.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5');
    assert.equal(sub.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '512');
    for (const [k, v] of Object.entries(FIXED_ENV)) assert.equal(sub[k], v, k);
    assert.equal(sub.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, '1');
    assert.equal(sub.CLAUDE_CODE_DISABLE_REFUSAL_RETRY, '1');
    assert.equal(sub.CLAUDE_CODE_NO_MODEL_FALLBACK, '1');
    assert.equal(sub.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, undefined);
    assert.equal(sub.CLAUDE_CONFIG_DIR, undefined);

    const fast = buildSubprocessEnv({ envPins: {}, auth: { mode: 'subscription' }, fastMode: true, base });
    assert.equal(fast.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, '1');

    const iso = buildSubprocessEnv({ envPins: {}, auth: { mode: 'subscription', oauthToken: 'tok-iso', configDir: '/scratch' }, base });
    assert.equal(iso.CLAUDE_CODE_OAUTH_TOKEN, 'tok-iso');
    assert.equal(iso.CLAUDE_CONFIG_DIR, '/scratch');

    const api = buildSubprocessEnv({ envPins: {}, auth: { mode: 'api', baseUrl: 'https://relay.example', authToken: 'tok', configDir: '/iso' }, base });
    assert.equal(api.ANTHROPIC_BASE_URL, 'https://relay.example');
    assert.equal(api.ANTHROPIC_AUTH_TOKEN, 'tok');
    assert.equal(api.CLAUDE_CONFIG_DIR, '/iso');
    assert.equal(api.ANTHROPIC_API_KEY, undefined);
    assert.equal(api.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('bearerFromRequest ignores SillyTavern placeholders', () => {
    const req = (v) => ({ get: () => v });
    assert.equal(bearerFromRequest(req('Bearer sk-no-key-needed')), null);
    assert.equal(bearerFromRequest(req('Bearer sk-ant-abc')), 'sk-ant-abc');
    assert.equal(bearerFromRequest(req('')), null);
    assert.equal(isAnthropicApiKey('sk-ant-x'), true);
    assert.equal(isAnthropicApiKey('sk-abc'), false);
});

// ── classifiers ──

test('error classifiers match status codes, not stray digits', () => {
    assert.equal(isCliTooOldError('API Error: 400 Claude Code 2.1.141 does not support this model; version 2.1.251 or newer is required.'), true);
    assert.equal(isQuotaExhaustedError("You've hit your limit · resets 3pm"), true);
    assert.equal(isQuotaExhaustedError("You've reached your Fable limit"), true);
    assert.equal(isRateLimitError('API Error: 429 too many requests'), true);
    assert.equal(isRateLimitError('rate_limit_error'), true);
    assert.equal(isQuotaExhaustedError('API Error: 429 too many requests'), false);
    // digits inside token counts, message indexes and request ids are not status codes
    assert.equal(isRateLimitError('invalid_request messages.429.content.0.text: text content blocks must be non-empty'), false);
    assert.equal(isRateLimitError('prompt is too long: 214290 tokens > 200000 maximum'), false);
    assert.equal(isRateLimitError("Claude's response exceeded the 4290 output token maximum"), false);
    assert.equal(isExpiredTokenError('invalid_request messages.401.content.0.text: invalid'), false);
    assert.equal(isExpiredTokenError('API Error: 401 authentication_error: invalid x-api-key'), true);
    assert.equal(isExpiredTokenError('Not logged in · Please run /login'), true);
});

test('1M usage-credit and refusal wordings of CLI 2.1.285', () => {
    assert.equal(isExtraUsageRequiredError('API Error: Usage credits required for 1M context · run /usage-credits to turn them on'), true);
    assert.equal(isExtraUsageRequiredError('long_context_credits_required'), true);
    assert.equal(isSafeguardError("API Error: Fable 5.1's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations."), true);
    assert.equal(isSafeguardError("API Error: Claude Sonnet 4.6 can't help with this. Start a new session to continue."), true);
    assert.equal(isSafeguardError('Output blocked by content filtering policy'), true);
    assert.equal(isSafeguardError('429 rate limit'), false);
});

test('recordRateLimitEvent normalises unified windows and top-level events', () => {
    recordRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1788853800 }, seven_day: { utilization: 0.08, resetsAt: 1789430400 } } });
    let rl = latestRateLimit();
    assert.equal(rl.windows.length, 2);
    assert.equal(rl.windows[0].type, 'five_hour');
    assert.equal(rl.windows[0].resetsAt, 1788853800000);
    recordRateLimitEvent({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 1789430400 });
    rl = latestRateLimit();
    assert.equal(rl.windows.length, 1);
    assert.equal(rl.windows[0].type, 'seven_day');
    assert.equal(rl.windows[0].utilization, 0.9);
});

// ── API credential discovery + backend choice ──

test('discoverApiCredentials: exact source attribution and key/base-URL pairing', async () => {
    const { discoverApiCredentials } = await import('../lib/claude/auth.js');
    const cfg = mkdtempSync(join(tmpdir(), 'st-subs-claude-'));
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://settings-relay.example' } }));
    await withEnv({ CLAUDE_CONFIG_DIR: cfg }, async () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-real\n';
        let c = discoverApiCredentials(null);
        assert.equal(c.source, 'process-env');
        assert.equal(c.apiKey, 'sk-ant-real');
        // a genuine Anthropic key never follows a relay URL that only sits in settings.json
        assert.equal(c.baseUrl, undefined);
        // a relay token pasted in the field pairs with the relay URL
        c = discoverApiCredentials({ get: () => 'Bearer relay-token' });
        assert.equal(c.source, 'api-key-field');
        assert.equal(c.authToken, 'relay-token');
        assert.equal(c.baseUrl, 'https://settings-relay.example');
        process.env.ST_SUBSCRIPTIONS_CLAUDE_BASE_URL = 'https://explicit.example/v1';
        assert.equal(discoverApiCredentials(null).baseUrl, 'https://explicit.example/v1');
    });
});

test('chooseClaudeAuth: subscription never bills a key; auto keeps the subscription first', async () => {
    const { chooseClaudeAuth } = await import('../lib/claude/auth.js');
    await withEnv({ CLAUDE_CONFIG_DIR: 'Z:/definitely/not/here' }, async () => {
        assert.equal(chooseClaudeAuth('auto', null).auth.mode, 'subscription');
        assert.equal(chooseClaudeAuth('auto', null).fallback, null);
        process.env.ANTHROPIC_AUTH_TOKEN = 'tok-relay';
        const auto = chooseClaudeAuth('auto', null);
        assert.equal(auto.auth.mode, 'subscription'); // even with no login file
        assert.equal(auto.fallback.authToken, 'tok-relay');
        const field = chooseClaudeAuth('auto', { get: () => 'Bearer sk-ant-field' });
        assert.equal(field.auth.mode, 'subscription'); // a key in the field is overflow only
        assert.equal(chooseClaudeAuth('subscription', { get: () => 'Bearer sk-ant-field' }).fallback, null);
        assert.equal(chooseClaudeAuth('api', null).auth.mode, 'api');
    });
    await withEnv({ CLAUDE_CONFIG_DIR: 'Z:/definitely/not/here' }, async () => {
        assert.throws(() => chooseClaudeAuth('api', null), /no API key was found/);
    });
});

// ── served-model guard ──

test('served-model guard covers every model, tolerates aliases and synthetic replies', async () => {
    const { assertServedModel } = await import('../lib/claude/chat.js');
    assert.doesNotThrow(() => assertServedModel('claude-fable-5-1', 'claude-fable-5-1'));
    assert.doesNotThrow(() => assertServedModel('claude-fable-5-1', '<synthetic>'));
    assert.doesNotThrow(() => assertServedModel('claude-fable-5-1', undefined));
    assert.doesNotThrow(() => assertServedModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001'));
    assert.doesNotThrow(() => assertServedModel('claude-sonnet-4-6', 'claude-sonnet-4-6[1m]'));
    assert.doesNotThrow(() => assertServedModel('claude-opus-5-5', 'opus[1m]'));
    assert.throws(() => assertServedModel('claude-fable-5-1', 'claude-opus-4-6'), /Model substitution refused/);
    assert.throws(() => assertServedModel('claude-opus-5-5', 'claude-opus-4-8'), /Model substitution refused/);
    assert.throws(() => assertServedModel('claude-opus-5-5', 'claude-opus-5'), /Model substitution refused/);
});

// ── system prompt ──

test('buildSystemPrompt: custom, never recorded, optional identity line', () => {
    assert.deepEqual(buildSystemPrompt('card', false, { baseId: 'claude-opus-5-5', name: 'Claude Opus 5.5' }), { type: 'custom', prompt: 'card', snapshot: false });
    assert.deepEqual(buildSystemPrompt(undefined, false), { type: 'custom', prompt: '', snapshot: false });
    const id = buildSystemPrompt('card', true, { baseId: 'claude-opus-5-5', name: 'Claude Opus 5.5' });
    assert.match(id.prompt, /^You are Claude Opus 5\.5 \(model id claude-opus-5-5\), a model made by Anthropic\.\n\ncard$/);
});

// ── conversation shapes (SillyTavern) ──

const BASE = [
    { role: 'system', content: 'MAIN' },
    { role: 'system', content: 'CARD' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'system', content: 'DEPTH NOTE' },
    { role: 'user', content: 'menu?' },
    { role: 'assistant', content: 'stew' },
];

test('partitionConversation: only the leading system run is the system prompt', () => {
    const p = partitionConversation(BASE);
    assert.equal(p.system, 'MAIN\n\nCARD');
    assert.equal(p.prefill, 'stew');
    assert.deepEqual(p.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(p.turns[2].content, 'DEPTH NOTE\n\nmenu?'); // depth injection stays in place, merged
});

test('Impersonate / quiet prompts are the current instruction, not a continuation', () => {
    const msgs = [...BASE, { role: 'system', content: 'Write the next message as the user.' }];
    const p = partitionConversation(msgs);
    assert.equal(p.prefill, null);
    const split = splitHistoryForResume(msgs);
    assert.equal(split.shape, 'trailing-instruction');
    assert.equal(split.current.content, 'Write the next message as the user.');
    assert.equal(split.history.at(-1).content, 'stew');
    const fold = foldConversation(msgs, { includeSystem: false });
    assert.ok(fold.endsWith('Write the next message as the user.'));
    assert.ok(!fold.includes('Reply as Assistant only'));
    assert.equal(splitConversation(msgs).prefill, null);
});

test('Continue keeps the continued message as the model turn, then asks to continue', () => {
    const split = splitHistoryForResume(BASE);
    assert.equal(split.shape, 'trailing-assistant-continue');
    assert.equal(split.history.at(-1).role, 'assistant');
    assert.equal(split.history.at(-1).content, 'stew');
    assert.match(split.current.content, /^\[Continue your last message\. It currently ends with:\n"stew"/);
    const conv = splitConversation(BASE);
    assert.equal(conv.prefill, 'stew');
    assert.equal(conv.history.at(-1).content, 'stew');
});

test('post-history system text merges into the user turn it follows', () => {
    const msgs = [...BASE, { role: 'user', content: 'I take the stew' }, { role: 'system', content: 'POST-HISTORY' }];
    const split = splitHistoryForResume(msgs);
    assert.equal(split.shape, 'trailing-user');
    assert.equal(split.current.content, 'I take the stew\n\nPOST-HISTORY');
});

test('assembleEntries: image-only assistant turns get a placeholder, not an empty block', () => {
    const meta = { sessionId: 's', cwd: '/x', version: 'v', gitBranch: '', permissionMode: 'dontAsk' };
    const entries = assembleEntries([
        { role: 'user', content: 'draw' },
        { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ], meta, 'claude-opus-5-5');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[1].message.content, [{ type: 'text', text: '[image]' }]);
    assert.equal(entries[1].parentUuid, entries[0].uuid);
});

// ── runner with a scripted fake SDK ──

function fakeRes() {
    const out = { status: 200, headers: {}, chunks: [], json: null, ended: false };
    const res = {
        headersSent: false, writableEnded: false, destroyed: false,
        setHeader(k, v) { out.headers[k] = v; },
        flushHeaders() { this.headersSent = true; },
        write(s) { this.headersSent = true; out.chunks.push(String(s)); return true; },
        end() { this.writableEnded = true; out.ended = true; },
        status(c) { out.status = c; return this; },
        json(o) { this.headersSent = true; this.writableEnded = true; out.json = o; },
        on() {}, off() {}, once() {},
    };
    return { res, out };
}

function sseText(out) {
    let text = '';
    let finish = null;
    let error = null;
    for (const c of out.chunks) {
        for (const line of c.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const p = line.slice(5).trim();
            if (p === '[DONE]') continue;
            const j = JSON.parse(p);
            if (j.error) error = j.error.message;
            text += j.choices?.[0]?.delta?.content ?? '';
            finish = j.choices?.[0]?.finish_reason ?? finish;
        }
    }
    return { text, finish, error };
}

async function runWith(script, { model = 'claude-opus-5-5', messages = [{ role: 'user', content: 'hi' }], claude = {}, stream = true, maxTokens } = {}) {
    const { __setSdkForTesting } = await import('../lib/claude/sdk-loader.js');
    const { runClaudeChat } = await import('../lib/claude/chat.js');
    const { CompletionWriter } = await import('../lib/common/completion.js');
    const calls = [];
    __setSdkForTesting({
        query({ prompt, options }) {
            calls.push({ prompt, options });
            const msgs = typeof script === 'function' ? script(calls.length) : script;
            return (async function* gen() {
                for (const m of msgs) {
                    if (m instanceof Error) throw m;
                    if (options.abortController?.signal.aborted) return;
                    yield m;
                }
            })();
        },
    });
    const { res, out } = fakeRes();
    const writer = new CompletionWriter({ res, stream, model, stops: [], showReasoning: true });
    const settings = {
        showReasoning: true, maxTokens, stops: [],
        claude: { backend: 'subscription', thinking: 'adaptive', identityMode: false, useResume: true, fastMode: false, ...claude },
    };
    await runClaudeChat({ req: { get: () => '' }, res, messages, model, settings, writer, signal: new AbortController().signal });
    __setSdkForTesting(null);
    return { calls, out };
}

const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const start = (model = 'claude-opus-5-5', id = 'msg_1') => ev({ type: 'message_start', message: { id, model } });
const textBlock = (i = 0) => ev({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
const delta = (text, i = 0) => ev({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } });
const assistant = (text, model = 'claude-opus-5-5', id = 'msg_1') => ({ type: 'assistant', parent_tool_use_id: null, message: { id, model, content: [{ type: 'text', text }] } });
const success = { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };

test('runner streams text once (deltas win over the complete assistant block)', async () => {
    const { calls, out } = await runWith([
        { type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 's', claude_code_version: '2.1.285' },
        start(), textBlock(), delta('Hel'), delta('lo'), assistant('Hello'), success,
    ]);
    assert.equal(calls.length, 1);
    const r = sseText(out);
    assert.equal(r.text, 'Hello');
    assert.equal(r.finish, 'stop');
    // isolation recipe on the options
    const o = calls[0].options;
    assert.deepEqual(o.tools, []);
    assert.equal(o.verbatimPrompts, true);
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.permissionMode, 'dontAsk');
    assert.equal(o.allowDangerouslySkipPermissions, undefined);
    assert.equal(o.includePartialMessages, true);
    assert.equal(o.title, 'SillyTavern');
    assert.equal(o.persistSession, false); // single turn → stream-input path, no transcript
    assert.deepEqual(o.systemPrompt, { type: 'custom', prompt: '', snapshot: false });
    assert.deepEqual(o.thinking, { type: 'adaptive', display: 'summarized' });
});

test('runner: resume path carries a session store and keeps persistence default', async () => {
    const { calls } = await runWith([start(), textBlock(), delta('ok'), success], { messages: BASE.concat([{ role: 'user', content: 'more' }]) });
    const o = calls[0].options;
    assert.ok(o.resume);
    assert.ok(o.sessionStore);
    assert.equal(o.persistSession, undefined);
    assert.equal(o.systemPrompt.prompt, 'MAIN\n\nCARD');
});

test('runner: a refusal is final — one query, error, no retry, no other model', async () => {
    const { calls, out } = await runWith([
        start(),
        { type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-opus-5-5', api_refusal_category: 'cyber', content: '' },
    ]);
    assert.equal(calls.length, 1);
    assert.match(out.json?.error?.message ?? sseText(out).error, /declined this request.*NOT retried or moved to another model/s);
});

test('runner: stop_reason refusal mid-stream keeps the partial text and ends in an error', async () => {
    const { calls, out } = await runWith([start(), textBlock(), delta('Part'), ev({ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'bio' } } })]);
    assert.equal(calls.length, 1);
    const r = sseText(out);
    assert.equal(r.text, 'Part');
    assert.match(r.error, /declined this request \(safety classifier: bio\)/);
});

test('runner: a reply from another model is refused before any output', async () => {
    const { calls, out } = await runWith([start('claude-opus-4-8'), textBlock(), delta('substitute'), success]);
    assert.equal(calls.length, 1);
    assert.match(out.json?.error?.message ?? '', /Model substitution refused/);
    assert.equal(sseText(out).text, '');
});

test('runner: max_tokens stops the reply with finish_reason length', async () => {
    const { calls, out } = await runWith([start(), textBlock(), delta('cut'), ev({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 60 } }), delta(' never')]);
    assert.equal(calls.length, 1);
    const r = sseText(out);
    assert.equal(r.text, 'cut');
    assert.equal(r.finish, 'length');
});

test('runner: a transient rate limit is retried; deterministic 400s are not', async () => {
    const rl = Object.assign(new Error('x'), {});
    const { calls, out } = await runWith((n) => (n === 1
        ? [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 429 rate_limit_error' }]
        : [start(), textBlock(), delta('after retry'), success]));
    assert.equal(calls.length, 2);
    assert.equal(sseText(out).text, 'after retry');
    void rl;

    const bad = await runWith([{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'invalid_request messages.429.content.0.text: text content blocks must be non-empty' }]);
    assert.equal(bad.calls.length, 1);
});

test('runner: thinking Off is honoured on Opus 4.8 and ignored on always-thinking models', async () => {
    let r = await runWith([start('claude-opus-4-8'), textBlock(), delta('a'), success], { model: 'claude-opus-4-8', claude: { thinking: 'off' } });
    assert.deepEqual(r.calls[0].options.thinking, { type: 'disabled' });
    r = await runWith([start('claude-fable-5-1'), textBlock(), delta('a'), success], { model: 'claude-fable-5-1', claude: { thinking: 'off' } });
    assert.deepEqual(r.calls[0].options.thinking, { type: 'adaptive', display: 'summarized' });
    r = await runWith([start('claude-haiku-4-5-20251001'), textBlock(), delta('a'), success], { model: 'claude-haiku-4-5', claude: { thinking: 'on', thinkingBudget: 1500, effort: 'high' } });
    assert.deepEqual(r.calls[0].options.thinking, { type: 'enabled', budgetTokens: 1500, display: 'summarized' });
    assert.equal(r.calls[0].options.effort, undefined); // Haiku takes no effort
});

test('runner: fast mode is opt-in and only then bypasses the org check', async () => {
    let r = await runWith([start(), textBlock(), delta('a'), success]);
    assert.equal(r.calls[0].options.settings, undefined);
    assert.equal(r.calls[0].options.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, undefined);
    r = await runWith([start(), textBlock(), delta('a'), success], { claude: { fastMode: true } });
    assert.deepEqual(r.calls[0].options.settings, { fastMode: true });
    assert.equal(r.calls[0].options.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, '1');
});
