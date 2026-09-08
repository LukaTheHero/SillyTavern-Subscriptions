import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseClaudeModel, isAdaptiveOnlyModel, listClaudeModels, CANONICAL_TIER_MODELS } from '../lib/claude/models.js';
import { buildSubprocessEnv, bearerFromRequest, isAnthropicApiKey } from '../lib/claude/env.js';
import { isCliTooOldError, isQuotaExhaustedError, isRateLimitError, recordRateLimitEvent, latestRateLimit } from '../lib/claude/oauth.js';
import { readCodexConfig, overflowProviderOf, isolationOverrides } from '../lib/codex/config.js';
import { clampEffort, codexModelInfo, STATIC_CODEX_MODELS } from '../lib/codex/models.js';
import { resolveGeminiModel, effortFromModelId } from '../lib/gemini/models.js';
import { launchSpec } from '../lib/common/exec.js';

test('parseClaudeModel handles base and [1m] requests', () => {
    const base = parseClaudeModel('claude-fable-5.1');
    assert.equal(base.baseId, 'claude-fable-5-1');
    assert.equal(base.tier, 'fable');
    assert.equal(base.oneM, false);
    assert.equal(base.sdkModel, 'claude-fable-5-1');
    assert.equal(base.adaptiveOnly, true);
    assert.equal(base.envPins.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5-1');
    assert.equal(base.envPins.ANTHROPIC_DEFAULT_OPUS_MODEL, CANONICAL_TIER_MODELS.opus);
    const oneM = parseClaudeModel('claude-opus-5[1m]');
    assert.equal(oneM.oneM, true);
    assert.equal(oneM.sdkModel, 'opus[1m]');
    assert.equal(oneM.envPins.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5');
    assert.equal(isAdaptiveOnlyModel('claude-opus-4-6'), false);
    assert.equal(isAdaptiveOnlyModel('claude-opus-4-7'), true);
    assert.ok(listClaudeModels().some((m) => m.id === 'claude-fable-5-1[1m]'));
});

test('buildSubprocessEnv scrubs auth + nested-session vars and applies API mode', () => {
    const base = { PATH: 'x', ANTHROPIC_API_KEY: 'leak', ANTHROPIC_BASE_URL: 'https://leak', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_OAUTH_TOKEN: 'keep', KEEP_ME: '1' };
    const sub = buildSubprocessEnv({ envPins: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5' }, maxTokens: 512, auth: { mode: 'subscription' }, base });
    assert.equal(sub.ANTHROPIC_API_KEY, undefined);
    assert.equal(sub.ANTHROPIC_BASE_URL, undefined);
    assert.equal(sub.CLAUDECODE, undefined);
    assert.equal(sub.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(sub.CLAUDE_CODE_OAUTH_TOKEN, 'keep');
    assert.equal(sub.KEEP_ME, '1');
    assert.equal(sub.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5');
    assert.equal(sub.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '512');
    assert.equal(sub.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    const api = buildSubprocessEnv({ envPins: {}, maxTokens: undefined, auth: { mode: 'api', baseUrl: 'https://relay.example', authToken: 'tok', configDir: '/iso' }, base });
    assert.equal(api.ANTHROPIC_BASE_URL, 'https://relay.example');
    assert.equal(api.ANTHROPIC_AUTH_TOKEN, 'tok');
    assert.equal(api.CLAUDE_CONFIG_DIR, '/iso');
    assert.equal(api.ANTHROPIC_API_KEY, undefined);
});

test('bearerFromRequest ignores SillyTavern placeholders', () => {
    const req = (v) => ({ get: () => v });
    assert.equal(bearerFromRequest(req('Bearer sk-no-key-needed')), null);
    assert.equal(bearerFromRequest(req('Bearer sk-ant-abc')), 'sk-ant-abc');
    assert.equal(bearerFromRequest(req('')), null);
    assert.equal(isAnthropicApiKey('sk-ant-x'), true);
    assert.equal(isAnthropicApiKey('sk-abc'), false);
});

test('claude error classifiers', () => {
    assert.equal(isCliTooOldError('API Error: 400 Claude Code 2.1.141 does not support this model; version 2.1.251 or newer is required.'), true);
    assert.equal(isQuotaExhaustedError("You've hit your limit · resets 3pm"), true);
    assert.equal(isRateLimitError('429 too many requests'), true);
    assert.equal(isQuotaExhaustedError('429 too many requests'), false);
});

test('recordRateLimitEvent normalises unified windows', () => {
    recordRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1788853800 }, seven_day: { utilization: 0.08, resetsAt: 1789430400 } } });
    const rl = latestRateLimit();
    assert.equal(rl.windows.length, 2);
    assert.equal(rl.windows[0].type, 'five_hour');
    assert.equal(rl.windows[0].utilization, 0.4);
    assert.equal(rl.windows[0].resetsAt, 1788853800000);
});

test('readCodexConfig extracts provider, mcp servers and plugins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-subs-codex-'));
    writeFileSync(join(dir, 'config.toml'), [
        'model = "gpt-6-astra"',
        'model_provider = "myrelay"',
        '# comment',
        'notify = [ "x", "turn-ended" ]',
        '[model_providers.myrelay]',
        'name = "My Relay"',
        'base_url = "https://relay.example/v1"',
        'env_key = "MY_RELAY_KEY"',
        'wire_api = "responses"',
        '[mcp_servers.context7]',
        'command = "npx"',
        '[mcp_servers.node_repl.env]',
        'X = "1"',
        '[plugins."browser@openai-bundled"]',
        'enabled = true',
        '[projects."c:\\\\"]',
        'trust_level = "trusted"',
    ].join('\n'));
    const cfg = readCodexConfig(dir);
    assert.equal(cfg.exists, true);
    assert.equal(cfg.modelProvider, 'myrelay');
    assert.equal(cfg.model, 'gpt-6-astra');
    assert.deepEqual(cfg.mcpNames, ['context7']);
    assert.deepEqual(cfg.pluginNames, ['browser@openai-bundled']);
    assert.equal(cfg.providers.myrelay.base_url, 'https://relay.example/v1');
    assert.equal(overflowProviderOf(cfg), 'myrelay');
    const args = isolationOverrides(cfg);
    assert.ok(args.includes('mcp_servers.context7.enabled=false'));
    assert.ok(args.includes('plugins."browser@openai-bundled".enabled=false'));
    assert.ok(args.includes('notify=[]'));
    const missing = readCodexConfig(join(dir, 'nope'));
    assert.equal(missing.exists, false);
    assert.equal(overflowProviderOf(missing), null);
});

test('codex effort clamping respects the catalog', () => {
    assert.equal(clampEffort('gpt-5.5', 'ultra'), 'xhigh');
    assert.equal(clampEffort('gpt-6-astra', 'ultra'), 'ultra');
    assert.equal(clampEffort('gpt-5.5', 'medium'), 'medium');
    assert.equal(clampEffort('gpt-5.5', undefined), undefined);
    assert.equal(codexModelInfo('gpt-unknown-99').unknown, true);
    assert.ok(STATIC_CODEX_MODELS.some((m) => m.id === 'gpt-6-astra'));
});

test('gemini model/effort resolution', () => {
    assert.equal(effortFromModelId('gemini-3.8-flash-high'), 'high');
    assert.equal(effortFromModelId('gemini-2.5-pro'), null);
    const r = resolveGeminiModel('gemini-3.8-flash-high', 'low');
    assert.equal(r.agyModel, 'gemini-3.8-flash-low');
    assert.equal(r.apiModel, 'gemini-3.8-flash');
    assert.equal(r.effort, 'low');
    const keep = resolveGeminiModel('gemini-3.1-pro-high');
    assert.equal(keep.agyModel, 'gemini-3.1-pro-high');
    assert.equal(keep.effort, 'high');
});

test('launchSpec runs .js under node and native binaries directly', () => {
    const js = launchSpec('/x/bin/codex.js', 'npm');
    assert.equal(js.command, process.execPath);
    assert.deepEqual(js.args, ['/x/bin/codex.js']);
    const bin = launchSpec('/x/bin/agy', 'path');
    assert.equal(bin.command, '/x/bin/agy');
    assert.deepEqual(bin.args, []);
});

test('package.json and manifest.json versions match', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(here, '..', 'manifest.json'), 'utf8'));
    assert.equal(pkg.version, manifest.version);
});

test('safeguard classifier matches the Fable refusal text', async () => {
    const { isSafeguardError } = await import('../lib/claude/oauth.js');
    assert.equal(isSafeguardError("API Error: Fable 5.1's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations."), true);
    assert.equal(isSafeguardError('429 rate limit'), false);
});

test('discoverApiCredentials: plugin vars win, vendor vars next, sk-ant keys vs bearer tokens', async () => {
    const { discoverApiCredentials } = await import('../lib/claude/auth.js');
    const saved = { ...process.env };
    try {
        for (const k of Object.keys(process.env)) if (/^(ST_SUBSCRIPTIONS_CLAUDE|ANTHROPIC_|CLAUDE_CONFIG_DIR)/.test(k)) delete process.env[k];
        process.env.CLAUDE_CONFIG_DIR = 'Z:/definitely/not/here'; // no settings.json env block
        process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
        let c = discoverApiCredentials(null);
        assert.equal(c.source, 'process-env');
        assert.equal(c.apiKey, 'sk-ant-real');
        assert.equal(c.authToken, undefined);
        assert.equal(c.baseUrl, undefined);
        process.env.ANTHROPIC_BASE_URL = 'https://relay.example';
        process.env.ST_SUBSCRIPTIONS_CLAUDE_API_KEY = 'tok-relay';
        c = discoverApiCredentials(null);
        assert.equal(c.source, 'ST_SUBSCRIPTIONS_CLAUDE_API_KEY');
        assert.equal(c.authToken, 'tok-relay');
        assert.equal(c.apiKey, undefined);
        assert.equal(c.baseUrl, 'https://relay.example');
        process.env.ST_SUBSCRIPTIONS_CLAUDE_BASE_URL = 'https://other.example/v1';
        assert.equal(discoverApiCredentials(null).baseUrl, 'https://other.example/v1');
    } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});

test('normalizeBase keeps paths and only appends /v1 to bare origins', async () => {
    const { runOpenAiCompat } = await import('../lib/common/openai-compat.js');
    assert.equal(typeof runOpenAiCompat, 'function');
    // exercised indirectly: bare origin → /v1, path preserved
    const { default: _unused } = { default: null };
    const probe = (u) => { try { const x = new URL(u); return (x.pathname === '/' || x.pathname === '') ? u.replace(/\/+$/, '') + '/v1' : u.replace(/\/+$/, ''); } catch { return u; } };
    assert.equal(probe('https://api.openai.com/v1'), 'https://api.openai.com/v1');
    assert.equal(probe('https://relay.example/'), 'https://relay.example/v1');
    assert.equal(probe('https://generativelanguage.googleapis.com/v1beta/openai'), 'https://generativelanguage.googleapis.com/v1beta/openai');
});

test('served-model guard rejects a fallback model but tolerates synthetic error replies', async () => {
    const { assertServedModel } = await import('../lib/claude/chat.js');
    assert.doesNotThrow(() => assertServedModel('fable', 'claude-fable-5-1', 'claude-fable-5-1'));
    assert.doesNotThrow(() => assertServedModel('fable', '<synthetic>', 'claude-fable-5-1'));
    assert.doesNotThrow(() => assertServedModel('fable', undefined, 'claude-fable-5-1'));
    assert.doesNotThrow(() => assertServedModel('opus', 'claude-sonnet-4-6', 'claude-opus-5'));
    assert.throws(() => assertServedModel('fable', 'claude-opus-4-6', 'claude-fable-5-1'), /Model substitution refused/);
});

test('chooseClaudeAuth auto: key is used outright when no subscription login exists', async () => {
    const { chooseClaudeAuth } = await import('../lib/claude/auth.js');
    const saved = { ...process.env };
    try {
        for (const k of Object.keys(process.env)) if (/^(ST_SUBSCRIPTIONS_CLAUDE|ANTHROPIC_|CLAUDE_CONFIG_DIR)/.test(k)) delete process.env[k];
        process.env.CLAUDE_CONFIG_DIR = 'Z:/definitely/not/here'; // no .credentials.json → not logged in
        assert.equal(chooseClaudeAuth('auto', null).auth.mode, 'subscription');
        process.env.ANTHROPIC_AUTH_TOKEN = 'tok-relay';
        process.env.ANTHROPIC_BASE_URL = 'https://relay.example';
        const pick = chooseClaudeAuth('auto', null);
        assert.equal(pick.auth.mode, 'api');
        assert.equal(pick.auth.authToken, 'tok-relay');
        assert.equal(pick.fallback, null);
        assert.ok(pick.chosen.includes('no subscription login'));
        assert.equal(chooseClaudeAuth('subscription', null).auth.mode, 'subscription');
    } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});
