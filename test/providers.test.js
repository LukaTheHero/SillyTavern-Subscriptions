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
    const api = buildSubprocessEnv({ envPins: {}, maxTokens: undefined, auth: { mode: 'api', baseUrl: 'https://api.linkapi.ai', authToken: 'tok', configDir: '/iso' }, base });
    assert.equal(api.ANTHROPIC_BASE_URL, 'https://api.linkapi.ai');
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
        'model_provider = "linkapi"',
        '# comment',
        'notify = [ "x", "turn-ended" ]',
        '[model_providers.linkapi]',
        'name = "LinkAPI"',
        'base_url = "https://api.linkapi.ai/v1"',
        'env_key = "LINKAPI_CODEX_API_KEY"',
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
    assert.equal(cfg.modelProvider, 'linkapi');
    assert.equal(cfg.model, 'gpt-6-astra');
    assert.deepEqual(cfg.mcpNames, ['context7']);
    assert.deepEqual(cfg.pluginNames, ['browser@openai-bundled']);
    assert.equal(cfg.providers.linkapi.base_url, 'https://api.linkapi.ai/v1');
    assert.equal(overflowProviderOf(cfg), 'linkapi');
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
