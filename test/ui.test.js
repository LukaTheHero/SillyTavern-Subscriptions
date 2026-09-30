// ──────────────────────────────────────────────
// UI extension (index.js) — pure helpers
// ──────────────────────────────────────────────
//
// index.js is an ES module (SillyTavern loads extension scripts with
// type="module"); its browser boot only runs when SillyTavern's global API
// exists, so importing it here runs nothing but the helper definitions.
//
// The structural Include Body merge is checked twice: with a JSON-only stand-in
// parser (always runs) and with SillyTavern's own `yaml` package when it can be
// found — set ST_ROOT to a SillyTavern checkout, or run from an installed copy
// under SillyTavern/plugins/ (../../node_modules/yaml).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    UI_VERSION, SETTINGS_VERSION, DEFAULT_BASE, defaultSettings,
    loadSettings, normalizeSettings, parseEndpointBase, endpointFor, isOurEndpoint,
    buildSubscriptionsBlock, mergeIncludeBody, stripBlocks, connect,
    providerReadiness, subscriptionInfo, apiInfo, shouldDeepProbe,
    windowLabel, formatMoney, extraUsageText, compareVersions, duplicateDecision, extensionFolder,
    CODEX_EFFORTS,
} from '../index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadStYaml() {
    const roots = [process.env.ST_ROOT, resolve(repoRoot, '..', '..')].filter(Boolean);
    for (const r of roots) {
        try {
            const y = createRequire(join(r, 'package.json'))('yaml');
            if (typeof y?.parse === 'function' && typeof y?.stringify === 'function') return y;
        } catch { /* try next */ }
    }
    return null;
}
const stYaml = loadStYaml();

/** SillyTavern's src/util.js mergeObjectWithYaml (the server side of Include Body). */
function stMerge(obj, yamlString, Y) {
    if (!yamlString) return obj;
    try {
        const parsed = Y.parse(yamlString);
        if (Array.isArray(parsed)) {
            for (const item of parsed) if (typeof item === 'object' && item && !Array.isArray(item)) Object.assign(obj, item);
        } else if (parsed && typeof parsed === 'object') {
            Object.assign(obj, parsed);
        }
    } catch { /* ST swallows parse errors — the whole body is lost */ }
    return obj;
}

/** JSON-only stand-in for SillyTavern.libs.yaml (JSON is valid YAML). */
const jsonYaml = { parse: (s) => JSON.parse(s), stringify: (v) => JSON.stringify(v) };

const fresh = () => loadSettings({});

// ── Versioning ──

test('manifest version matches UI_VERSION and declares a minimum client version', () => {
    const m = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));
    assert.equal(m.version, UI_VERSION);
    assert.equal(UI_VERSION, '3.1.0');
    assert.equal(m.js, 'index.js');
    assert.match(String(m.minimum_client_version), /^\d+\.\d+\.\d+$/);
});

test('compareVersions is numeric, not lexical', () => {
    assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
    assert.equal(compareVersions('3.0.1', '3.1.0'), -1);
    assert.equal(compareVersions('3.1', '3.1.0'), 0);
    assert.equal(compareVersions('x', '3.1.0'), 0);
});

// ── Settings ──

test('fresh settings are subscription-only everywhere', () => {
    const root = {};
    const s = loadSettings(root);
    assert.equal(root.subscriptions, s);
    for (const p of ['claude', 'codex', 'gemini']) assert.equal(s[p].backend, 'subscription');
    assert.equal(s.claude.fastMode, false);
    assert.equal(s.codex.verbosity, 'default');
    assert.equal(s.settingsVersion, SETTINGS_VERSION);
    assert.deepEqual(s.notices, []);
    assert.equal(s.endpointBase, DEFAULT_BASE);
});

test('legacy panels migrate on first run (fast mode carried with a notice, ultra → max)', () => {
    const s = loadSettings({
        claude_max: { effort: 'high', thinking: 'off', fastMode: true, identityMode: true },
        codex_max: { effort: 'ultra', backend: 'auto' },
        gemini_antigravity: { effort: 'low', backend: 'api' },
    });
    assert.equal(s.claude.effort, 'high');
    assert.equal(s.claude.thinking, 'off');
    assert.equal(s.claude.fastMode, true);
    assert.deepEqual(s.notices, ['fastModeCost']);
    assert.equal(s.codex.effort, 'max');
    assert.equal(s.codex.backend, 'subscription'); // only an explicit legacy 'api' carries over
    assert.equal(s.gemini.backend, 'api');
    assert.equal(s.gemini.effort, 'low');
});

test('null / wrong-typed persisted values are repaired instead of crashing', () => {
    const root = { subscriptions: { claude: null, codex: [], gemini: 'x', enabled: 'yes', showReasoning: 0, scope: 'evil', endpointBase: 'javascript:alert(1)', notices: 'x', settingsVersion: 3 } };
    const s = loadSettings(root);
    assert.deepEqual(s.claude, defaultSettings.claude);
    assert.deepEqual(s.codex, defaultSettings.codex);
    assert.deepEqual(s.gemini, defaultSettings.gemini);
    assert.equal(s.enabled, true);
    assert.equal(s.showReasoning, true);
    assert.equal(s.scope, 'all');
    assert.equal(s.endpointBase, DEFAULT_BASE);
    assert.deepEqual(s.notices, []);
    // A non-object root entry is treated as a fresh install.
    assert.equal(loadSettings({ subscriptions: null }).claude.backend, 'subscription');
});

test('unknown enum strings fall back to safe values (backends → subscription)', () => {
    const s = normalizeSettings({
        claude: { backend: 'api\nfoo: 1', effort: 'insane', thinking: 'maybe', identityMode: 'true', useResume: 'no', fastMode: 1 },
        codex: { backend: 'API', effort: 'ultra', serviceTier: 'x', reasoningSummary: 'x', verbosity: 'loud' },
        gemini: { backend: null, effort: 'max' },
    });
    assert.equal(s.claude.backend, 'subscription');
    assert.equal(s.claude.effort, 'auto');
    assert.equal(s.claude.thinking, 'adaptive');
    assert.equal(s.claude.identityMode, false);
    assert.equal(s.claude.useResume, true);
    assert.equal(s.claude.fastMode, false);
    assert.equal(s.codex.backend, 'subscription');
    assert.equal(s.codex.effort, 'max');
    assert.equal(s.codex.serviceTier, 'standard');
    assert.equal(s.codex.reasoningSummary, 'auto');
    assert.equal(s.codex.verbosity, 'default');
    assert.equal(s.gemini.backend, 'subscription');
    assert.equal(s.gemini.effort, 'auto');
    assert.ok(!CODEX_EFFORTS.includes('ultra'));
});

test('settingsVersion migrations: 3.0.0 auto → subscription, 3.0.x gets the one-time notices', () => {
    const v1 = loadSettings({ subscriptions: { claude: { backend: 'auto' }, codex: { backend: 'auto' }, gemini: { backend: 'api' } } });
    assert.equal(v1.claude.backend, 'subscription');
    assert.equal(v1.codex.backend, 'subscription');
    assert.equal(v1.gemini.backend, 'api');
    assert.deepEqual(v1.notices, ['customKeyPlaceholder']);
    assert.equal(v1.settingsVersion, 3);

    // A 3.0.1+ user who chose Auto explicitly keeps it.
    const v2 = loadSettings({ subscriptions: { settingsVersion: 2, claude: { backend: 'auto', fastMode: true } } });
    assert.equal(v2.claude.backend, 'auto');
    assert.deepEqual(v2.notices, ['customKeyPlaceholder', 'fastModeCost']);

    // Already migrated: nothing re-added; a newer version is never lowered.
    const v3 = loadSettings({ subscriptions: { settingsVersion: 3, notices: [] } });
    assert.deepEqual(v3.notices, []);
    assert.equal(loadSettings({ subscriptions: { settingsVersion: 9 } }).settingsVersion, 9);
    assert.deepEqual(loadSettings({ subscriptions: { settingsVersion: 3, notices: ['fastModeCost', 'fastModeCost', 'bogus'] } }).notices, ['fastModeCost']);
});

// ── Endpoint ──

test('parseEndpointBase accepts http(s) origins only', () => {
    assert.equal(parseEndpointBase(''), DEFAULT_BASE);
    assert.equal(parseEndpointBase(' http://127.0.0.1:9000/claude/v1/ '), 'http://127.0.0.1:9000');
    assert.equal(parseEndpointBase('https://box.lan/subs/v1'), 'https://box.lan/subs');
    assert.equal(parseEndpointBase('ftp://host'), null);
    assert.equal(parseEndpointBase('http://user:pw@host:1'), null);
    assert.equal(parseEndpointBase('http://host:1/?x=1'), null);
    assert.equal(parseEndpointBase('not a url'), null);
});

test('endpointFor / isOurEndpoint', () => {
    const s = fresh();
    assert.equal(endpointFor(s), 'http://127.0.0.1:8901/v1');
    s.scope = 'codex';
    assert.equal(endpointFor(s), 'http://127.0.0.1:8901/codex/v1');
    assert.ok(isOurEndpoint('http://127.0.0.1:8901/claude/v1/', s));
    assert.ok(!isOurEndpoint('http://127.0.0.1:89011/v1', s));
    assert.ok(!isOurEndpoint('', s));
});

// ── Connect ──

/** Minimal jQuery stand-in that mimics ST's handlers: a source change reconnects (clicks the button). */
function fakeJq(state) {
    const log = [];
    const handlers = {
        '#chat_completion_source:change': () => { if (state['#main_api'] === 'openai') fakeJq.click(state, log); },
    };
    const $ = (sel) => {
        if (!(sel in state) && sel !== '#api_button_openai') throw new Error(`unexpected selector ${sel}`);
        const api = {
            val(v) {
                if (v === undefined) return state[sel];
                log.push(`val ${sel}=${v}`);
                state[sel] = v;
                return api;
            },
            trigger(ev) {
                log.push(`${ev} ${sel}`);
                if (sel === '#api_button_openai' && ev === 'click') state.clicks++;
                handlers[`${sel}:${ev}`]?.();
                return api;
            },
        };
        return api;
    };
    $.log = log;
    return $;
}
fakeJq.click = (state, log) => { state.clicks++; log.push('click #api_button_openai (reconnect)'); };

test('connect never touches the Custom API key field and connects exactly once', () => {
    const toast = { success() {}, error(m) { throw new Error(m); } };
    const settings = fresh();

    const a = { '#main_api': 'textgenerationwebui', '#chat_completion_source': 'openai', '#custom_api_url_text': '', clicks: 0 };
    const $a = fakeJq(a);
    connect(settings, $a, toast);
    assert.equal(a['#main_api'], 'openai');
    assert.equal(a['#chat_completion_source'], 'custom');
    assert.equal(a['#custom_api_url_text'], 'http://127.0.0.1:8901/v1');
    assert.equal(a.clicks, 1);
    assert.ok($a.log.indexOf('input #custom_api_url_text') < $a.log.indexOf('change #chat_completion_source'), 'URL is set before the source change');
    assert.ok(!$a.log.some((l) => l.includes('api_key')));

    const b = { '#main_api': 'openai', '#chat_completion_source': 'custom', '#custom_api_url_text': 'http://old/v1', clicks: 0 };
    const $b = fakeJq(b);
    connect(settings, $b, toast);
    assert.equal(b.clicks, 1);
    assert.ok(!$b.log.some((l) => l.startsWith('change')), 'no change events when already on openai + custom');
    assert.equal(b['#custom_api_url_text'], 'http://127.0.0.1:8901/v1');
});

// ── Per-request block ──

test('buildSubscriptionsBlock: defaults, omitted auto/default values, reasoning gate', () => {
    const s = fresh();
    assert.deepEqual(buildSubscriptionsBlock(s, { include_reasoning: true }), {
        show_reasoning: true,
        claude: { backend: 'subscription', thinking: 'adaptive', identity_mode: false, use_resume: true, fast_mode: false },
        codex: { backend: 'subscription', service_tier: 'standard', reasoning_summary: 'auto' },
        gemini: { backend: 'subscription' },
    });
    assert.equal(buildSubscriptionsBlock(s, { include_reasoning: false }).show_reasoning, false);
    assert.equal(buildSubscriptionsBlock(s, {}).show_reasoning, true);
    s.showReasoning = false;
    assert.equal(buildSubscriptionsBlock(s, { include_reasoning: true }).show_reasoning, false);

    s.claude.effort = 'xhigh';
    s.codex.effort = 'max';
    s.codex.verbosity = 'high';
    s.gemini.effort = 'low';
    const b = buildSubscriptionsBlock(s, {});
    assert.equal(b.claude.effort, 'xhigh');
    assert.equal(b.codex.effort, 'max');
    assert.equal(b.codex.verbosity, 'high');
    assert.equal(b.gemini.effort, 'low');
});

test('buildSubscriptionsBlock re-validates values it was handed', () => {
    const b = buildSubscriptionsBlock({
        claude: { backend: 'api\nbackend: api', effort: 'x', thinking: 'x', fastMode: 'true' },
        codex: { backend: 'x', effort: 'ultra', verbosity: 'x' },
        gemini: null,
    }, {});
    assert.equal(b.claude.backend, 'subscription');
    assert.equal(b.claude.effort, undefined);
    assert.equal(b.claude.fast_mode, false);
    assert.equal(b.codex.effort, 'max');
    assert.equal(b.codex.verbosity, undefined);
    assert.deepEqual(b.gemini, { backend: 'subscription' });
});

// ── Include Body merge ──

const BLOCK = buildSubscriptionsBlock(loadSettings({}), {});

test('mergeIncludeBody text fallback (no parser): strips old blocks, appends JSON', () => {
    assert.equal(mergeIncludeBody('', BLOCK, null), `subscriptions: ${JSON.stringify(BLOCK)}`);
    const out = mergeIncludeBody('top_k: 20\nsubscriptions:\n  claude:\n    backend: api\nclaude_subscription:\n  backend: api\nmin_p: 0.1', BLOCK, undefined);
    assert.ok(!/backend: api/.test(out));
    assert.ok(out.startsWith('top_k: 20\nmin_p: 0.1\nsubscriptions: {'));
    assert.deepEqual(JSON.parse(out.slice(out.indexOf('subscriptions: ') + 'subscriptions: '.length)), BLOCK);
});

test('mergeIncludeBody structural path (JSON stand-in parser)', () => {
    const obj = JSON.parse(mergeIncludeBody('{"top_k": 20, "subscriptions": {"claude": {"backend": "api"}}, "codex_subscription": {"backend": "api"}}', BLOCK, jsonYaml));
    assert.deepEqual(obj, { top_k: 20, subscriptions: BLOCK });

    const list = JSON.parse(mergeIncludeBody('[{"top_k": 20}, {"claude_subscription": {"backend": "api"}, "min_p": 0.1}, "junk"]', BLOCK, jsonYaml));
    assert.deepEqual(list, [{ top_k: 20 }, { min_p: 0.1 }, 'junk', { subscriptions: BLOCK }]);

    assert.deepEqual(JSON.parse(mergeIncludeBody('"just a string"', BLOCK, jsonYaml)), { subscriptions: BLOCK });
    assert.deepEqual(JSON.parse(mergeIncludeBody('   ', BLOCK, jsonYaml)), { subscriptions: BLOCK });
    // Not JSON → the stand-in throws → text fallback.
    assert.ok(mergeIncludeBody('top_k: 20', BLOCK, jsonYaml).startsWith('top_k: 20\nsubscriptions: {'));
});

test('mergeIncludeBody with SillyTavern\'s yaml keeps the user\'s params in every body shape', { skip: stYaml ? false : 'SillyTavern yaml package not found (set ST_ROOT)' }, () => {
    const cases = {
        json: ['{"top_k": 20, "min_p": 0.05}', { top_k: 20, min_p: 0.05 }],
        flow: ['{top_k: 20, repetition_penalty: 1.1}', { top_k: 20, repetition_penalty: 1.1 }],
        list: ['- top_k: 20\n- min_p: 0.1', { top_k: 20, min_p: 0.1 }],
        commentInOldBlock: ['top_k: 20\nsubscriptions:\n  show_reasoning: true\n# a comment\n  claude:\n    backend: api\nmin_p: 0.1', { top_k: 20, min_p: 0.1 }],
        quotedDuplicateKey: ['top_k: 20\n"subscriptions": {claude: {backend: api}}\nsubscriptions:\n  gemini:\n    backend: api', { top_k: 20 }],
        legacyNamespaces: ['claude_subscription:\n  backend: api\ntop_k: 5', { top_k: 5 }],
        scalar: ['hello', {}],
        commentOnly: ['# nothing here', {}],
        empty: ['', {}],
    };
    for (const [name, [text, userParams]] of Object.entries(cases)) {
        const merged = mergeIncludeBody(text, BLOCK, stYaml);
        const body = stMerge({}, merged, stYaml);
        assert.deepEqual(body, { ...userParams, subscriptions: BLOCK }, `case ${name}: ${merged}`);
    }
});

test('the text fallback output is valid YAML for plain block bodies', { skip: stYaml ? false : 'SillyTavern yaml package not found (set ST_ROOT)' }, () => {
    const merged = mergeIncludeBody('top_k: 20\nsubscriptions:\n  claude:\n    backend: api', BLOCK, null);
    assert.deepEqual(stMerge({}, merged, stYaml), { top_k: 20, subscriptions: BLOCK });
});

test('stripBlocks removes every stale namespace at column 0', () => {
    assert.equal(stripBlocks('a: 1\ngemini_subscription:\n  backend: api\nb: 2'), 'a: 1\nb: 2');
    assert.equal(stripBlocks(null), '');
});

// ── Status interpretation ──

const claudeContract = (sub, api, extra = {}) => ({ provider: 'claude', available: true, sdk: 'loaded', cli: { path: '/x', version: '2.1.285' }, credential: { present: true }, backends: { subscription: sub, api }, ...extra });

test('providerReadiness follows the selected backend (Claude)', () => {
    const ok = claudeContract({ ready: true }, { ready: null });
    assert.deepEqual(
        [providerReadiness('claude', ok, 'subscription').tone, providerReadiness('claude', ok, 'subscription').text],
        ['ok', 'ready · subscription'],
    );
    assert.equal(providerReadiness('claude', ok, 'api').text, 'key not visible · API');
    assert.equal(providerReadiness('claude', ok, 'api').tone, 'unknown');

    // Legacy status: key present but no login — Subscription is NOT ready (old badge said "ready").
    const legacy = { provider: 'claude', ok: true, available: true, sdk: 'loaded', cli: { path: '/x' }, credential: { present: false }, api: { available: true, source: 'env', baseUrl: 'https://api.example' } };
    assert.equal(providerReadiness('claude', legacy, 'subscription').tone, 'warn');
    assert.equal(providerReadiness('claude', legacy, 'subscription').state, 'needs login');
    assert.match(providerReadiness('claude', legacy, 'subscription').detail, /claude auth login/);
    assert.equal(providerReadiness('claude', legacy, 'api').tone, 'ok');
    // Auto never uses the key just because no login exists.
    assert.equal(providerReadiness('claude', legacy, 'auto').state, 'needs login');

    const keychain = { ...legacy, credential: { present: 'unknown' }, api: { available: false } };
    assert.equal(providerReadiness('claude', keychain, 'subscription').tone, 'unknown');

    const noRuntime = { ...legacy, available: false, sdk: 'unavailable', cli: {} };
    assert.equal(providerReadiness('claude', noRuntime, 'api').tone, 'err');
    assert.equal(providerReadiness('claude', undefined, 'subscription').tone, 'err');

    const explicitNoKey = claudeContract({ ready: false, message: 'Log in first.' }, { ready: false, message: 'No key configured.' });
    assert.equal(providerReadiness('claude', explicitNoKey, 'api').state, 'no API key');
    assert.equal(providerReadiness('claude', explicitNoKey, 'subscription').detail, 'Log in first.');
});

test('providerReadiness (Codex / Gemini)', () => {
    const codexRelayOnly = { provider: 'codex', available: true, cli: { found: true }, login: { loggedIn: false }, config: { modelProvider: 'my-relay' }, api: { available: false } };
    assert.equal(providerReadiness('codex', codexRelayOnly, 'subscription').state, 'needs ChatGPT login');
    assert.equal(providerReadiness('codex', codexRelayOnly, 'auto').tone, 'ok');
    const codexNoCli = { provider: 'codex', cli: { found: false }, api: { available: true, source: 'env' } };
    assert.equal(providerReadiness('codex', codexNoCli, 'subscription').state, 'CLI not found');
    assert.equal(providerReadiness('codex', codexNoCli, 'api').tone, 'ok');
    assert.equal(providerReadiness('codex', codexNoCli, 'auto').state, 'ready (API key)');

    const geminiRelay = { provider: 'gemini', cli: { found: true }, settings: { overflowOn: true, routing: 'relay (https://relay.example)' }, api: { available: false } };
    const r = providerReadiness('gemini', geminiRelay, 'subscription');
    assert.equal(r.tone, 'err');
    assert.equal(r.state, 'relay configured');
    assert.equal(providerReadiness('gemini', geminiRelay, 'auto').tone, 'ok');
    const geminiNone = { provider: 'gemini', cli: { found: false }, api: { available: false } };
    assert.equal(providerReadiness('gemini', geminiNone, 'auto').tone, 'unknown');
    assert.equal(providerReadiness('gemini', { ...geminiNone, backends: { subscription: { ready: false }, api: { ready: false } } }, 'auto').state, 'agy not found');
});

test('providerReadiness review fixes: runtime reason, Codex API-key login, Gemini contract', () => {
    // Runtime missing: the detail is the provider's reason, not the login summary.
    const noRuntime = claudeContract({ ready: false, message: 'max login' }, { ready: null }, { available: false, sdk: 'unavailable', cli: {}, message: 'No Claude Code CLI found.' });
    const r = providerReadiness('claude', noRuntime, 'subscription');
    assert.equal(r.state, 'unavailable');
    assert.equal(r.detail, 'No Claude Code CLI found.');

    // Codex Auto with the CLI signed in by API key: Auto runs it (and it bills per token).
    const codexKeyLogin = { provider: 'codex', cli: { found: true }, login: { loggedIn: false, apiKeyLogin: true }, config: { modelProvider: 'openai' }, backends: { subscription: { ready: false, message: 'API-key login' }, api: { ready: null } } };
    assert.equal(providerReadiness('codex', codexKeyLogin, 'auto').state, 'ready (API key)');
    assert.match(providerReadiness('codex', codexKeyLogin, 'auto').detail, /per token/);
    assert.equal(providerReadiness('codex', codexKeyLogin, 'subscription').state, 'needs ChatGPT login');

    // Gemini with the status contract: sign-in not checkable, relay verdict from overflowOn.
    const gem = (sub, settings) => ({ provider: 'gemini', cli: { found: true }, settings, backends: { subscription: sub, api: { ready: null } } });
    const signIn = gem({ ready: null, message: 'shows on the first chat' }, { overflowOn: false, modelProvider: null, routing: 'Google sign-in (subscription)' });
    assert.equal(providerReadiness('gemini', signIn, 'subscription').state, 'sign-in unchecked');
    assert.equal(providerReadiness('gemini', signIn, 'subscription').tone, 'unknown');
    assert.equal(providerReadiness('gemini', signIn, 'auto').state, 'sign-in unchecked');
    const blocked = gem({ ready: false, message: 'agy is configured to bill an API key' }, { overflowOn: true, modelProvider: 'gemini', routing: 'Gemini API key (pay per token)' });
    assert.equal(providerReadiness('gemini', blocked, 'subscription').state, 'relay configured');
    assert.equal(providerReadiness('gemini', blocked, 'auto').tone, 'ok');
    const tooOld = gem({ ready: false, message: 'agy too old to isolate' }, { overflowOn: false });
    assert.equal(providerReadiness('gemini', tooOld, 'subscription').state, 'not ready');
    assert.equal(providerReadiness('gemini', tooOld, 'auto').state, 'not ready');
    // overflowOn:false is authoritative even when another field looks like routing.
    assert.equal(providerReadiness('gemini', gem({ ready: true }, { overflowOn: false, modelProvider: 'x' }), 'subscription').tone, 'ok');
});

test('shouldDeepProbe asks for the account read when only it can confirm the Codex login', () => {
    const s = fresh();
    const keyring = { providers: { codex: { cli: { found: true }, login: { loggedIn: false }, config: { modelProvider: 'openai' }, backends: { subscription: { ready: null } } } } };
    assert.equal(shouldDeepProbe(s, keyring), true);
    assert.equal(shouldDeepProbe({ ...s, scope: 'gemini' }, keyring), false);
});

test('subscriptionInfo / apiInfo prefer the status contract fields', () => {
    assert.deepEqual(subscriptionInfo('gemini', { cli: { found: true }, backends: { subscription: { ready: 'yes' } } }), { ready: null, message: undefined });
    assert.deepEqual(apiInfo({ backends: { api: { ready: true, source: 'env', baseUrl: 'https://x' } } }), { ready: true, source: 'env', baseUrl: 'https://x', message: undefined });
    assert.deepEqual(apiInfo({ api: { available: false } }), { ready: null });
});

test('shouldDeepProbe only starts the Codex app-server when Codex can be in use', () => {
    const s = fresh();
    assert.equal(shouldDeepProbe(s, null), true);
    assert.equal(shouldDeepProbe({ ...s, scope: 'claude' }, null), false);
    const st = (codex) => ({ providers: { codex } });
    assert.equal(shouldDeepProbe(s, st({ cli: { found: false } })), false);
    assert.equal(shouldDeepProbe(s, st({ cli: { found: true }, login: { loggedIn: false }, config: { modelProvider: 'openai' } })), false);
    assert.equal(shouldDeepProbe(s, st({ cli: { found: true }, login: { loggedIn: true } })), true);
    assert.equal(shouldDeepProbe(s, st({ cli: { found: false }, appServer: { running: true } })), true);
    // A relay provider in config.toml only matters for Auto / API.
    const relayOnly = st({ cli: { found: true }, login: { loggedIn: false }, config: { modelProvider: 'relay' } });
    assert.equal(shouldDeepProbe({ ...s, scope: 'codex' }, relayOnly), false);
    assert.equal(shouldDeepProbe({ ...s, scope: 'codex', codex: { ...s.codex, backend: 'auto' } }, relayOnly), true);
});

// ── Quota formatting ──

test('windowLabel covers cinder_cove and per-model weekly windows', () => {
    assert.equal(windowLabel({ type: 'cinder_cove' }), 'one-time credit');
    assert.equal(windowLabel({ type: 'five_hour' }), '5-hour window');
    assert.equal(windowLabel({ type: 'seven_day_fable' }), '7-day (Fable)');
    assert.equal(windowLabel({ type: 'seven_day_claude_opus_5_5' }), '7-day (Claude Opus 5.5)');
    assert.equal(windowLabel({ type: 'seven_day_x', label: '7-day (X model)' }), '7-day (X model)');
    assert.equal(windowLabel({ type: 'weird' }), 'weird');
    assert.equal(windowLabel({ type: 'toString' }), 'toString');
});

test('Extra Usage amounts render as currency with 2 decimals', () => {
    assert.match(formatMoney(12.5, 'USD'), /12\.50/);
    assert.match(formatMoney(3, 'eur'), /3\.00/);
    assert.equal(formatMoney(1.234, 'US'), '1.23 US');
    assert.equal(formatMoney(null, 'USD'), '–');
    assert.match(extraUsageText({ usedCredits: 4.2, monthlyLimit: 50, currency: 'USD' }), /4\.20 of .*50\.00 this month/);
    assert.match(extraUsageText({ usedCredits: 0, monthlyLimit: 0 }), /0\.00 used this month/);
});

// ── Duplicate-copy guard ──

test('duplicateDecision: newest copy wins, same version stays quiet', () => {
    const disposable = (version) => ({ version, url: 'http://h/scripts/extensions/third-party/A/index.js', dispose() {} });
    assert.deepEqual(duplicateDecision(undefined, '3.1.0'), { action: 'boot', warn: false });
    assert.deepEqual(duplicateDecision(true, '3.1.0'), { action: 'dormant', warn: true });
    assert.deepEqual(duplicateDecision(disposable('3.0.9'), '3.1.0'), { action: 'takeover', warn: true });
    assert.deepEqual(duplicateDecision(disposable('3.1.0'), '3.1.0'), { action: 'dormant', warn: false });
    assert.deepEqual(duplicateDecision(disposable('3.2.0'), '3.1.0'), { action: 'dormant', warn: true });
    assert.deepEqual(duplicateDecision({ version: '3.0.0' }, '3.1.0'), { action: 'dormant', warn: true });
    assert.equal(extensionFolder('http://h:8000/scripts/extensions/third-party/SillyTavern-Subscriptions-UI/index.js'), '/scripts/extensions/third-party/SillyTavern-Subscriptions-UI');
});

// ── Source-level guards ──

test('UI sources: current wording, no fake key', () => {
    const src = readFileSync(join(repoRoot, 'index.js'), 'utf8');
    const css = readFileSync(join(repoRoot, 'style.css'), 'utf8');
    assert.ok(src.includes('claude auth login'));
    assert.ok(!/`claude login`/.test(src), 'the login command is `claude auth login`');
    assert.ok(!src.includes('Show model thoughts'));
    assert.ok(src.includes('Request model reasoning'));
    assert.ok(!/api_key_custom/.test(src), 'Connect must never touch the Custom API key field');
    assert.ok(!/\.st-subs-row\b/.test(css), 'unused .st-subs-row rules were removed');
});
