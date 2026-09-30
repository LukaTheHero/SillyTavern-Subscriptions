import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCodexConfig, overflowProviderOf, isolationOverrides } from '../lib/codex/config.js';
import { clampEffort, codexModelInfo, STATIC_CODEX_MODELS } from '../lib/codex/models.js';
import { resolveGeminiModel, effortFromModelId } from '../lib/gemini/models.js';
import { launchSpec } from '../lib/common/exec.js';

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
    assert.deepEqual(cfg.mcpNames, ['context7', 'node_repl']); // [mcp_servers.node_repl.env] is a server too
    assert.deepEqual(cfg.pluginNames, ['browser@openai-bundled']);
    assert.equal(cfg.providers.myrelay.base_url, 'https://relay.example/v1');
    assert.equal(overflowProviderOf(cfg), 'myrelay');
    const args = isolationOverrides(cfg);
    assert.ok(args.includes('mcp_servers.context7.enabled=false'));
    // Codex keeps quote characters in -c paths literally, so plugin names go unquoted.
    assert.ok(args.includes('plugins.browser@openai-bundled.enabled=false'));
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
    // No live catalog: the base id plus agy's own --effort (agy validates the level).
    const r = resolveGeminiModel('gemini-3.8-flash-high', 'low');
    assert.equal(r.agyModel, 'gemini-3.8-flash');
    assert.equal(r.agyEffort, 'low');
    assert.equal(r.apiModel, 'gemini-3.8-flash');
    assert.equal(r.effort, 'low');
    const listed = resolveGeminiModel('gemini-3.8-flash-high', 'low', { source: 'agy', models: [{ id: 'gemini-3.8-flash-low' }] });
    assert.equal(listed.agyModel, 'gemini-3.8-flash-low');
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

test('normalizeBase keeps paths and only appends /v1 to bare origins', async () => {
    const { normalizeBase } = await import('../lib/common/openai-compat.js');
    assert.equal(normalizeBase('https://api.openai.com/v1'), 'https://api.openai.com/v1');
    assert.equal(normalizeBase('https://relay.example/'), 'https://relay.example/v1');
    assert.equal(normalizeBase('https://relay.example/v1/'), 'https://relay.example/v1');
    assert.equal(normalizeBase(' https://generativelanguage.googleapis.com/v1beta/openai '), 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(normalizeBase('relay.example'), 'relay.example');
});

