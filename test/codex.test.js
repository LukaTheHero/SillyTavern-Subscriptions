// Codex provider unit tests — no live model calls. The app-server is either
// an in-process fake (runAppServerTurn) or a small mock executable written to
// a temp dir that speaks the app-server's JSON-RPC over stdio (CodexAppServer,
// runCodexChat, codexStatus).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCodexConfig, isolationOverrides, enabledMcpServers, globalInstructionFiles, DISABLED_FEATURES } from '../lib/codex/config.js';
import { clampEffort, resolveCodexEffort } from '../lib/codex/models.js';
import { runAppServerTurn, runCodexChat, assertChatgptLogin, codexUsage, codexTurnError, codexVerbosity } from '../lib/codex/chat.js';
import { CodexAppServer, stopAppServer, getAppServer } from '../lib/codex/app-server.js';
import { subscriptionReadiness, codexStatus } from '../lib/codex/status.js';
import { pluginVersion } from '../lib/status.js';
import { CompletionWriter } from '../lib/common/completion.js';

// ── helpers ──

function fakeRes() {
    const out = { chunks: [], statusCode: 200, body: null, ended: false, headers: {} };
    return Object.assign(out, {
        setHeader(k, v) { out.headers[k] = v; },
        flushHeaders() {},
        write(s) { out.chunks.push(String(s)); return true; },
        end() { out.ended = true; out.writableEnded = true; },
        status(c) { out.statusCode = c; return this; },
        json(o) { out.body = o; out.ended = true; out.writableEnded = true; },
    });
}

function makeWriter({ stream = true, stops = [], showReasoning = true } = {}) {
    const res = fakeRes();
    const writer = new CompletionWriter({ res, stream, model: 'gpt-5.5', stops, showReasoning, idPrefix: 'chatcmpl-codex' });
    return { res, writer };
}

/** SSE payloads written so far (parsed), '[DONE]' kept as a string. */
function ssePayloads(res) {
    return res.chunks.join('').split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => {
        const d = b.slice(6);
        return d === '[DONE]' ? d : JSON.parse(d);
    });
}
const sseText = (res) => ssePayloads(res).map((p) => p?.choices?.[0]?.delta?.content ?? '').join('');
const sseReasoning = (res) => ssePayloads(res).map((p) => p?.choices?.[0]?.delta?.reasoning_content ?? '').join('');
const sseError = (res) => ssePayloads(res).find((p) => p?.error)?.error ?? null;
const sseFinish = (res) => ssePayloads(res).map((p) => p?.choices?.[0]?.finish_reason).find(Boolean) ?? null;

function settings({ effort, verbosity, summary = 'auto', showReasoning = true, backend = 'subscription' } = {}) {
    return { showReasoning, stops: [], maxTokens: undefined, reasoningEffort: undefined, codex: { backend, effort, serviceTier: 'standard', reasoningSummary: summary, verbosity } };
}

const MESSAGES = [{ role: 'system', content: 'You are Aria.' }, { role: 'user', content: 'Hi there' }];
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * In-process stand-in for CodexAppServer. `script(server, params)` runs after
 * turn/start answered and emits notifications with server.emit().
 */
class FakeServer {
    constructor({ started = {}, script = null, account = { type: 'chatgpt', planType: 'plus' }, accountError = null, turnStartDelay = 0, codexHome = null } = {}) {
        this.started = started;
        this.script = script;
        this.account = account;
        this.accountError = accountError;
        this.turnStartDelay = turnStartDelay;
        this.codexHome = codexHome;
        this.calls = [];
        this.listeners = new Set();
    }
    async request(method, params) {
        this.calls.push({ method, params });
        switch (method) {
            case 'thread/start':
                return { thread: { id: 't1' }, model: params.model, modelProvider: params.modelProvider ?? 'openai', instructionSources: [], ...this.started };
            case 'turn/start':
                if (this.turnStartDelay) await sleep(this.turnStartDelay);
                if (this.script) setImmediate(() => this.script(this, params));
                return { turn: { id: 'u1', status: 'inProgress' } };
            case 'account/read':
                if (this.accountError) throw this.accountError;
                return { account: this.account, requiresOpenaiAuth: true };
            default:
                return {};
        }
    }
    subscribeThread(threadId, fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    emit(method, params = {}) {
        for (const fn of [...this.listeners]) fn({ method, params: { threadId: 't1', turnId: 'u1', ...params } });
    }
    complete(status = 'completed', error = null) {
        this.emit('turn/completed', { turn: { id: 'u1', status, error } });
    }
    methods() { return this.calls.map((c) => c.method); }
}

// ── config.js ──

test('config scan finds inline-table, dotted, literal and quoted MCP servers and plugins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-subs-codex-cfg-'));
    writeFileSync(join(dir, 'config.toml'), [
        'model = "gpt-5.5" # trailing comment',
        'model_provider = "relay"',
        'mcp_servers.dotted_top.command = "x"',
        'developer_note = """',
        '[mcp_servers.inside_multiline_string]',
        '"""',
        'notify = [',
        '  "a", "[mcp_servers.inside_array]",',
        ']',
        '[model_providers]',
        'relay = { name = "Relay", base_url = "https://relay.example/v1", env_key = "K" }',
        '[mcp_servers]',
        'inline_srv = { command = "npx", args = ["-y", "x"] }',
        'dotted.command = "y"',
        '[mcp_servers.\'lit_srv\']',
        'command = "z"',
        '[mcp_servers."has.dot"]',
        'command = "w"',
        '[mcp_servers.table_srv.env]',
        'A = "1"',
        '[plugins."fake-plugin@some-market"]',
        'enabled = true',
        "[plugins.'weird name@m']",
        'enabled = true',
        '[projects."c:\\\\"]',
        'trust_level = "trusted"',
    ].join('\n'));
    const cfg = readCodexConfig(dir);
    assert.equal(cfg.model, 'gpt-5.5');
    assert.equal(cfg.modelProvider, 'relay');
    assert.equal(cfg.providers.relay.base_url, 'https://relay.example/v1');
    assert.deepEqual(cfg.mcpNames, ['dotted_top', 'inline_srv', 'dotted', 'lit_srv', 'has.dot', 'table_srv']);
    assert.deepEqual(cfg.pluginNames, ['fake-plugin@some-market', 'weird name@m']);

    const args = isolationOverrides(cfg);
    const values = args.filter((_, i) => i % 2 === 1);
    assert.ok(args.every((a, i) => i % 2 === 1 || a === '-c'), 'every override is a -c pair');
    assert.ok(values.includes('mcp_servers.lit_srv.enabled=false'), 'literal key is emitted bare');
    assert.ok(values.includes('mcp_servers.inline_srv.enabled=false'));
    assert.ok(!values.some((v) => v.includes('has.dot') || v.includes('"') && v.startsWith('mcp_servers')), 'unsafe names are never quoted into a -c path');
    assert.ok(values.includes('plugins.fake-plugin@some-market.enabled=false'));
    assert.ok(!values.some((v) => v.includes('weird name')), 'unsafe plugin names are skipped (features.plugins=false covers them)');
});

test('isolation overrides switch off tools, web search, host context and project docs', () => {
    const values = isolationOverrides({ mcpNames: [], pluginNames: [] }).filter((_, i) => i % 2 === 1);
    for (const f of ['shell_tool', 'unified_exec', 'view_image', 'apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use', 'memories']) {
        assert.ok(values.includes(`features.${f}=false`), f);
    }
    assert.equal(DISABLED_FEATURES.length, values.filter((v) => v.startsWith('features.')).length);
    for (const v of [
        'web_search="disabled"', 'notify=[]', 'project_doc_max_bytes=0', 'thread_unload_delay_secs=1',
        'include_environment_context=false', 'include_permissions_instructions=false', 'include_apps_instructions=false',
        'include_collaboration_mode_instructions=false', 'skills.include_instructions=false', 'skills.bundled.enabled=false',
    ]) assert.ok(values.includes(v), v);
    assert.ok(!values.some((v) => v.startsWith('--disable')));
    const noWs = isolationOverrides({ mcpNames: [] }, { webSearchKey: false });
    assert.ok(!noWs.includes('web_search="disabled"'));
    const extra = isolationOverrides({ mcpNames: ['a'] }, { extraMcpNames: ['a', 'b'] });
    assert.equal(extra.filter((v) => v.startsWith('mcp_servers.')).length, 2);
});

test('enabledMcpServers and globalInstructionFiles', () => {
    assert.deepEqual(enabledMcpServers({ mcp_servers: { a: { enabled: false }, b: { enabled: true }, c: { command: 'x' } } }), ['b', 'c']);
    assert.deepEqual(enabledMcpServers({}), []);
    assert.deepEqual(enabledMcpServers(null), []);
    const dir = mkdtempSync(join(tmpdir(), 'st-subs-codex-agents-'));
    assert.deepEqual(globalInstructionFiles(dir), []);
    writeFileSync(join(dir, 'AGENTS.md'), '   \n');
    assert.deepEqual(globalInstructionFiles(dir), [], 'blank file is not an instruction source');
    writeFileSync(join(dir, 'AGENTS.md'), 'be terse');
    assert.deepEqual(globalInstructionFiles(dir), [join(dir, 'AGENTS.md')]);
    writeFileSync(join(dir, 'AGENTS.override.md'), 'override');
    assert.deepEqual(globalInstructionFiles(dir), [join(dir, 'AGENTS.override.md')]);
});

// ── models.js ──

test('clampEffort never escalates: unknown → default, below range → lowest', () => {
    assert.equal(clampEffort('gpt-5.5', 'minimal'), 'low');
    assert.equal(clampEffort('gpt-5.5', 'none'), 'low');
    assert.equal(clampEffort('gpt-5.5', 'auto'), undefined);
    assert.equal(clampEffort('gpt-5.5', 'bogus'), undefined);
    assert.equal(clampEffort('gpt-6-astra', 'minimal'), 'low');
    assert.equal(clampEffort('gpt-5.5', 'max'), 'xhigh');
    assert.equal(clampEffort('gpt-5.5', 'high'), 'high');
    assert.equal(clampEffort('gpt-5.5', undefined), undefined);
});

test('ultra is never sent: max where offered, else xhigh', () => {
    assert.equal(resolveCodexEffort('gpt-6-astra', 'ultra'), 'max');
    assert.equal(resolveCodexEffort('gpt-5.5', 'ultra'), 'xhigh');
    assert.equal(resolveCodexEffort('gpt-5.5', 'medium'), 'medium');
    assert.equal(resolveCodexEffort('gpt-5.5', 'auto'), undefined);
});

// ── chat.js helpers ──

test('codexUsage takes cache reads and writes out of the uncached input', () => {
    const u = codexUsage({ last: { inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 20, totalTokens: 1050 }, total: { inputTokens: 9999 } });
    assert.equal(u.prompt_tokens, 1000);
    assert.equal(u.completion_tokens, 50);
    assert.equal(u.total_tokens, 1050);
    assert.deepEqual(u.prompt_tokens_details, { cached_tokens: 400, cache_creation_tokens: 100 });
    assert.equal(u.completion_tokens_details.reasoning_tokens, 20);
    assert.equal(codexUsage(null), null);
    assert.equal(codexUsage({ total: { inputTokens: 10, outputTokens: 1 } }).prompt_tokens, 10);
});

test('codexTurnError marks safety refusals as final and maps statuses', () => {
    const r = codexTurnError({ message: 'flagged', codexErrorInfo: 'cyberPolicy' });
    assert.equal(r.refusal, true);
    assert.equal(r.noRetry, true);
    assert.equal(r.httpStatus, 422);
    assert.match(r.message, /NOT retried/);
    assert.equal(codexTurnError({ message: 'x', codexErrorInfo: 'misalignmentPolicyViolation' }).refusal, true);
    assert.equal(codexTurnError({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }).httpStatus, 429);
    assert.equal(codexTurnError({ message: 'x', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }).codexErrorCode, 'responseStreamDisconnected');
    assert.equal(codexTurnError({ message: 'x' }).httpStatus, 502);
    assert.equal(codexTurnError({ message: 'x' }).refusal, undefined);
});

test('codexVerbosity accepts only low/medium/high', () => {
    assert.equal(codexVerbosity(settings({ verbosity: 'high' })), 'high');
    assert.equal(codexVerbosity(settings({ verbosity: 'loud' })), undefined);
    assert.equal(codexVerbosity(settings()), undefined);
});

// ── subscription gate ──

test('assertChatgptLogin: only a ChatGPT account passes', async () => {
    assert.equal((await assertChatgptLogin(new FakeServer({ account: { type: 'chatgpt', planType: 'pro' } }))).type, 'chatgpt');
    await assert.rejects(assertChatgptLogin(new FakeServer({ account: { type: 'apiKey' } })), (e) => e.httpStatus === 400 && /API key/.test(e.message) && /never uses a key/.test(e.message));
    await assert.rejects(assertChatgptLogin(new FakeServer({ account: null })), (e) => e.httpStatus === 400 && /not signed in/.test(e.message));
    await assert.rejects(assertChatgptLogin(new FakeServer({ account: { type: 'amazonBedrock' } })), (e) => e.httpStatus === 400);

    // account/read unavailable → auth.json in the app-server's home, auth_mode must be chatgpt
    const dir = mkdtempSync(join(tmpdir(), 'st-subs-codex-auth-'));
    const err = new Error('method not found');
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-not-real', tokens: { id_token: 'x' } }));
    await assert.rejects(assertChatgptLogin(new FakeServer({ accountError: err, codexHome: dir })), (e) => e.httpStatus === 400);
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'x' } }));
    assert.equal((await assertChatgptLogin(new FakeServer({ accountError: err, codexHome: dir }))).type, 'chatgpt');
});

// ── runAppServerTurn ──

test('turn streams text, sends verbosity, unsubscribes (never thread/delete)', async () => {
    const server = new FakeServer({
        script: (s) => {
            s.emit('turn/started', { turn: { id: 'u1' } });
            s.emit('item/started', { item: { type: 'agentMessage', id: 'm1', phase: 'final_answer' } });
            s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'Hello ' });
            s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'world' });
            s.emit('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Hello world', phase: 'final_answer' } });
            s.emit('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5 } } });
            s.complete();
        },
    });
    const { res, writer } = makeWriter();
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings({ effort: 'ultra' }), writer, modelProvider: 'openai' });
    assert.equal(sseText(res), 'Hello world');
    assert.equal(sseFinish(res), 'stop');
    const start = server.calls.find((c) => c.method === 'thread/start').params;
    assert.deepEqual(start.config, { model_verbosity: 'medium' });
    assert.equal(start.developerInstructions, '', 'config.toml developer_instructions must not reach the model');
    assert.equal(start.modelProvider, 'openai');
    assert.equal(start.approvalPolicy, 'never');
    assert.equal(server.calls.find((c) => c.method === 'turn/start').params.effort, 'xhigh', 'ultra maps down');
    assert.ok(server.methods().includes('thread/unsubscribe'));
    assert.ok(!server.methods().includes('thread/delete'));
    const usage = ssePayloads(res).find((p) => p?.usage)?.usage;
    assert.equal(usage.prompt_tokens, 100);
});

test('explicit verbosity is passed through to the thread config', async () => {
    const server = new FakeServer({ script: (s) => { s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'x' }); s.complete(); } });
    const { writer } = makeWriter();
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings({ verbosity: 'high' }), writer, modelProvider: null });
    assert.deepEqual(server.calls[0].params.config, { model_verbosity: 'high' });
    assert.equal(server.calls[0].params.modelProvider, undefined);
});

test('global AGENTS.md reported by thread/start refuses the chat before any turn', async () => {
    const server = new FakeServer({ started: { instructionSources: ['/home/u/.codex/AGENTS.md'] } });
    const { writer } = makeWriter();
    await assert.rejects(
        runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai' }),
        (e) => e.httpStatus === 400 && e.message.includes('/home/u/.codex/AGENTS.md') && e.message.includes('ST_SUBSCRIPTIONS_CODEX_HOME'),
    );
    assert.ok(!server.methods().includes('turn/start'));
    assert.ok(server.methods().includes('thread/unsubscribe'));
    assert.deepEqual(server.lastInstructionSources, ['/home/u/.codex/AGENTS.md']);
});

test('a served model other than the requested one is refused', async () => {
    const server = new FakeServer({ started: { model: 'gpt-5.4-mini' } });
    const { writer } = makeWriter();
    await assert.rejects(
        runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai' }),
        (e) => e.httpStatus === 422 && /gpt-5\.4-mini/.test(e.message),
    );
    assert.ok(!server.methods().includes('turn/start'));
    // same id in another case is fine
    const ok = new FakeServer({ started: { model: 'GPT-5.5' }, script: (s) => s.complete() });
    await runAppServerTurn({ server: ok, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer: makeWriter().writer, modelProvider: 'openai' });
});

test('model/rerouted after partial output ends the stream with an error, not a stop', async () => {
    const server = new FakeServer({
        script: (s) => {
            s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'Partial ' });
            s.emit('model/rerouted', { fromModel: 'gpt-5.5', toModel: 'gpt-5.4-mini', reason: 'highRiskCyberActivity' });
            setTimeout(() => s.complete('interrupted'), 5);
        },
    });
    const { res, writer } = makeWriter();
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai' });
    assert.equal(sseText(res), 'Partial ');
    assert.match(sseError(res).message, /rerouted/);
    assert.equal(sseFinish(res), null, 'no finish_reason stop');
    assert.ok(server.methods().includes('turn/interrupt'));
    assert.ok(res.chunks.join('').includes('[DONE]'));
});

test('a cyberPolicy error is a final refusal even when Codex would retry', async () => {
    const server = new FakeServer({
        script: (s) => {
            s.emit('error', { error: { message: 'This content was flagged', codexErrorInfo: 'cyberPolicy' }, willRetry: true });
            setTimeout(() => s.complete('interrupted'), 5);
        },
    });
    const { writer } = makeWriter();
    await assert.rejects(
        runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai' }),
        (e) => e.refusal === true && e.httpStatus === 422,
    );
    assert.ok(server.methods().includes('turn/interrupt'));
});

test('a tool item stops the turn (defence in depth)', async () => {
    const server = new FakeServer({
        script: (s) => {
            s.emit('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'cat ~/.codex/auth.json' } });
            setTimeout(() => s.complete('interrupted'), 5);
        },
    });
    const { writer } = makeWriter();
    await assert.rejects(
        runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai' }),
        (e) => /tool \(commandExecution\)/.test(e.message) && e.noRetry === true,
    );
    assert.ok(server.methods().includes('turn/interrupt'));
});

test('turn failure after partial output reaches the client as an error event', async () => {
    const server = new FakeServer({
        script: (s) => {
            s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'Some text' });
            s.complete('failed', { message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } });
        },
    });
    const { res, writer } = makeWriter();
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai' });
    assert.equal(sseText(res), 'Some text');
    assert.match(sseError(res).message, /stream disconnected/);
    assert.equal(sseFinish(res), null);
});

test('commentary goes to reasoning; separate answer items are separated', async () => {
    const server = new FakeServer({
        script: (s) => {
            s.emit('item/started', { item: { type: 'agentMessage', id: 'c1', phase: 'commentary' } });
            s.emit('item/agentMessage/delta', { itemId: 'c1', delta: 'Let me think.' });
            s.emit('item/started', { item: { type: 'agentMessage', id: 'a1', phase: null } });
            s.emit('item/agentMessage/delta', { itemId: 'a1', delta: 'First.' });
            s.emit('item/started', { item: { type: 'agentMessage', id: 'a2', phase: 'final_answer' } });
            s.emit('item/agentMessage/delta', { itemId: 'a2', delta: 'Second.' });
            // a completed item without deltas still arrives (fallback path)
            s.emit('item/completed', { item: { type: 'agentMessage', id: 'a3', text: 'Third.', phase: 'final_answer' } });
            s.emit('item/completed', { item: { type: 'agentMessage', id: 'a2', text: 'Second.', phase: 'final_answer' } });
            s.complete();
        },
    });
    const { res, writer } = makeWriter();
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai' });
    assert.equal(sseText(res), 'First.\n\nSecond.\n\nThird.');
    assert.equal(sseReasoning(res), 'Let me think.');
});

test('stop sequence interrupts the turn and still finishes normally', async () => {
    const server = new FakeServer({
        script: (s) => {
            s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'Line one\nUser: ' });
            s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'should not appear' });
            setTimeout(() => s.complete('interrupted'), 5);
        },
    });
    const res = fakeRes();
    const writer = new CompletionWriter({ res, stream: true, model: 'gpt-5.5', stops: ['\nUser:'] });
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai' });
    assert.equal(sseText(res), 'Line one');
    assert.equal(sseFinish(res), 'stop');
    assert.ok(server.methods().includes('turn/interrupt'));
});

test('abort during turn/start is remembered and sent once the turn id is known', async () => {
    const ac = new AbortController();
    const server = new FakeServer({ turnStartDelay: 40 });
    const { res, writer } = makeWriter();
    const run = runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai', signal: ac.signal, timing: { interruptGraceMs: 20 } });
    await sleep(10);
    assert.ok(server.methods().includes('turn/start'));
    ac.abort();
    await run;
    const interruptCall = server.calls.find((c) => c.method === 'turn/interrupt');
    assert.ok(interruptCall, 'turn/interrupt sent after turn/start returned');
    assert.equal(interruptCall.params.turnId, 'u1');
    assert.equal(res.chunks.length, 0, 'nothing written after the client left');
    assert.equal(res.body, null);
});

test('abort mid-stream stops writing and interrupts the turn', async () => {
    const ac = new AbortController();
    const server = new FakeServer({
        script: (s) => {
            s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'Before' });
            ac.abort();
            setTimeout(() => {
                s.emit('item/agentMessage/delta', { itemId: 'm1', delta: ' after' });
                s.complete('interrupted');
            }, 5);
        },
    });
    const { res, writer } = makeWriter();
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai', signal: ac.signal });
    assert.equal(sseText(res), 'Before');
    assert.ok(!res.chunks.join('').includes('[DONE]'), 'the runner leaves ending the response to the listener');
    assert.ok(server.methods().includes('turn/interrupt'));
});

test('already-aborted signal: no thread is started', async () => {
    const ac = new AbortController();
    ac.abort();
    const server = new FakeServer();
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer: makeWriter().writer, modelProvider: 'openai', signal: ac.signal });
    assert.equal(server.calls.length, 0);
});

test('idle watchdog: long window before the first text, short window between deltas', async () => {
    // Silent reasoning longer than the short window but shorter than the long one survives.
    const quiet = new FakeServer({
        script: (s) => setTimeout(() => { s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'late but fine' }); s.complete(); }, 60),
    });
    const a = makeWriter();
    await runAppServerTurn({ server: quiet, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer: a.writer, modelProvider: 'openai', timing: { idleBeforeOutputMs: 400, idleMs: 20, interruptGraceMs: 20 } });
    assert.equal(sseText(a.res), 'late but fine');

    // Once text streams, a stall longer than the short window fails the reply.
    const stall = new FakeServer({ script: (s) => s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'start' }) });
    const b = makeWriter();
    await runAppServerTurn({ server: stall, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer: b.writer, modelProvider: 'openai', timing: { idleBeforeOutputMs: 5000, idleMs: 30, interruptGraceMs: 20 } });
    assert.equal(sseText(b.res), 'start');
    assert.match(sseError(b.res).message, /stopped streaming/);
    assert.ok(stall.methods().includes('turn/interrupt'));

    // Nothing at all within the long window → 504 before any output.
    const dead = new FakeServer({ script: () => {} });
    await assert.rejects(
        runAppServerTurn({ server: dead, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer: makeWriter().writer, modelProvider: 'openai', timing: { idleBeforeOutputMs: 30, idleMs: 10, interruptGraceMs: 10 } }),
        (e) => e.httpStatus === 504,
    );
});

test('app-server exit mid-turn after output is an error, not a normal stop', async () => {
    const server = new FakeServer({
        script: (s) => {
            s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'abc' });
            s.emit('st/exit', { error: new Error('Codex app-server exited (code 1)') });
        },
    });
    const { res, writer } = makeWriter();
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-5.5', settings: settings(), writer, modelProvider: 'openai' });
    assert.match(sseError(res).message, /exited/);
});

// ── CodexAppServer + runCodexChat against a mock app-server executable ──

const MOCK_APP_SERVER = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const scenario = JSON.parse(process.env.MOCK_CODEX_SCENARIO || '{}');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 9.9.9'); process.exit(0); }
const overrides = [];
for (let i = 0; i < args.length; i++) if (args[i] === '-c') overrides.push(args[++i]);
if (scenario.log) appendFileSync(scenario.log, JSON.stringify({ event: 'launch', overrides }) + '\n');
const configured = scenario.mcp || {};
const mcp = {};
for (const [name, enabled] of Object.entries(configured)) mcp[name] = { command: 'x', enabled };
for (const o of overrides) {
    const m = o.match(/^mcp_servers\.([^.]+)\.enabled=false$/);
    if (!m) continue;
    if (!(m[1] in configured)) { process.stderr.write('Error: invalid transport in ' + '\x60mcp_servers.' + m[1] + '\x60\n'); process.exit(1); }
    if (!(scenario.sticky || []).includes(m[1])) mcp[m[1]].enabled = false;
}
if (scenario.rejectWebSearch && overrides.includes('web_search="disabled"')) { process.stderr.write('Error: failed to load bootstrap configuration in web_search\n'); process.exit(1); }
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
if (scenario.chatter) setInterval(() => notify('thread/status/changed', { threadId: 'other', status: 'idle' }), 5);
createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (scenario.log) appendFileSync(scenario.log, JSON.stringify({ event: 'request', method: msg.method, params: msg.params }) + '\n');
    if ((scenario.hang || []).includes(msg.method)) return;
    if (scenario.dieOn === msg.method) { process.stderr.write('Error: mock died on ' + msg.method + '\n'); process.exit(3); }
    const delay = (scenario.delay || {})[msg.method] || 0;
    const reply = (result) => (delay ? setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result }), delay) : send({ jsonrpc: '2.0', id: msg.id, result }));
    switch (msg.method) {
        case 'initialize': return reply({ userAgent: 'mock', codexHome: scenario.home || process.env.CODEX_HOME || 'mockhome', platformFamily: 'x', platformOs: 'x' });
        case 'config/read': return reply({ config: { mcp_servers: mcp }, origins: {} });
        case 'account/read': return reply({ account: scenario.account === undefined ? { type: 'chatgpt', planType: 'plus', email: null } : scenario.account, requiresOpenaiAuth: true });
        case 'model/list': return reply({ data: [] });
        case 'thread/start': return reply({ thread: { id: 'th1' }, model: scenario.servedModel || msg.params.model, modelProvider: msg.params.modelProvider || 'openai', instructionSources: scenario.instructionSources || [] });
        case 'thread/unsubscribe': return reply({ status: 'unsubscribed' });
        case 'turn/interrupt': return reply({});
        case 'turn/start':
            reply({ turn: { id: 'tu1', status: 'inProgress' } });
            setTimeout(() => {
                notify('turn/started', { threadId: 'th1', turn: { id: 'tu1' } });
                notify('item/agentMessage/delta', { threadId: 'th1', turnId: 'tu1', itemId: 'm1', delta: 'mock reply' });
                notify('turn/completed', { threadId: 'th1', turn: { id: 'tu1', status: 'completed' } });
            }, 5);
            return;
        default: return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown ' + msg.method } });
    }
});
`;

const mockDir = mkdtempSync(join(tmpdir(), 'st-subs-codex-mock-'));
const mockPath = join(mockDir, 'mock-codex.mjs');
writeFileSync(mockPath, MOCK_APP_SERVER);

/** Run `fn` with the mock CLI + a scratch CODEX_HOME + scenario; restores env and stops servers. */
async function withMock(scenario, fn) {
    const saved = { ...process.env };
    const home = mkdtempSync(join(tmpdir(), 'st-subs-codex-home-'));
    const log = join(home, 'mock.log');
    process.env.ST_SUBSCRIPTIONS_CODEX_PATH = mockPath;
    process.env.ST_SUBSCRIPTIONS_CODEX_HOME = home;
    delete process.env.CODEX_PATH;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ST_SUBSCRIPTIONS_CODEX_API_KEY;
    process.env.MOCK_CODEX_SCENARIO = JSON.stringify({ home, log, ...scenario });
    const entries = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    try {
        await fn({ home, entries, launches: () => entries().filter((e) => e.event === 'launch'), requests: () => entries().filter((e) => e.event === 'request') });
    } finally {
        stopAppServer();
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
}

test('app-server: launch flags, clientInfo version, verified isolation', async () => {
    await withMock({}, async ({ home, launches, requests }) => {
        writeFileSync(join(home, 'config.toml'), '[mcp_servers]\nctx = { command = "npx" }\n');
        process.env.MOCK_CODEX_SCENARIO = JSON.stringify({ ...JSON.parse(process.env.MOCK_CODEX_SCENARIO), mcp: { ctx: true } });
        const s = new CodexAppServer();
        try {
            await s.start();
            assert.equal(s.alive, true);
            assert.equal(launches().length, 1, 'scan found the inline-table server: no relaunch needed');
            const o = launches()[0].overrides;
            assert.ok(o.includes('mcp_servers.ctx.enabled=false'));
            assert.ok(o.includes('features.shell_tool=false'));
            assert.ok(o.includes('include_environment_context=false'));
            const init = requests().find((r) => r.method === 'initialize');
            assert.equal(init.params.clientInfo.version, pluginVersion());
            assert.ok(requests().some((r) => r.method === 'config/read'));
            assert.equal(s.isolation.verified, true);
            assert.equal(s.codexHome, home);
        } finally { s.stop(); }
    });
});

test('app-server: a server the scan missed is found via config/read and switched off on relaunch', async () => {
    await withMock({ mcp: { hidden: true } }, async ({ launches }) => {
        const s = new CodexAppServer();
        try {
            await s.start();
            assert.equal(launches().length, 2);
            assert.ok(!launches()[0].overrides.includes('mcp_servers.hidden.enabled=false'));
            assert.ok(launches()[1].overrides.includes('mcp_servers.hidden.enabled=false'));
            assert.equal(s.alive, true);
        } finally { s.stop(); }
    });
});

test('app-server: fails closed for an MCP name that cannot be switched off, or one that stays on', async () => {
    await withMock({ mcp: { 'has.dot': true } }, async () => {
        const s = new CodexAppServer();
        await assert.rejects(s.start(), (e) => e.httpStatus === 400 && /has\.dot/.test(e.message));
        assert.equal(s.alive, false);
        assert.match(s.lastStartError, /has\.dot/);
    });
    await withMock({ mcp: { sticky: true }, sticky: ['sticky'] }, async ({ launches }) => {
        const s = new CodexAppServer();
        await assert.rejects(s.start(), (e) => e.httpStatus === 400 && /stayed enabled/.test(e.message));
        assert.equal(launches().length, 2);
    });
});

test('app-server: a scanned name the real config lacks does not brick startup', async () => {
    await withMock({ mcp: {} }, async ({ home, launches }) => {
        writeFileSync(join(home, 'config.toml'), '[mcp_servers.ghost]\ncommand = "x"\n');
        const s = new CodexAppServer();
        try {
            await s.start();
            assert.equal(launches().length, 2);
            assert.ok(launches()[0].overrides.includes('mcp_servers.ghost.enabled=false'));
            assert.ok(!launches()[1].overrides.some((o) => o.startsWith('mcp_servers.')));
            assert.equal(s.alive, true);
        } finally { s.stop(); }
    });
});

test('app-server: a CLI that rejects web_search="disabled" is relaunched without it', async () => {
    await withMock({ rejectWebSearch: true }, async ({ launches }) => {
        const s = new CodexAppServer();
        try {
            await s.start();
            assert.equal(launches().length, 2);
            assert.ok(!launches()[1].overrides.includes('web_search="disabled"'));
            assert.ok(launches()[1].overrides.includes('features.shell_tool=false'));
        } finally { s.stop(); }
    });
});

test('app-server: stop() fails pending calls; repeated timeouts recycle a hung process', async () => {
    await withMock({ hang: ['model/list'] }, async () => {
        const s = new CodexAppServer();
        await s.start();
        const pending = s.request('model/list', {}, { timeoutMs: 10000 });
        s.stop();
        await assert.rejects(pending, /stopped/);
        assert.equal(s.alive, false);

        await s.start();
        assert.equal(s.alive, true);
        await assert.rejects(s.request('model/list', {}, { timeoutMs: 30 }), /timed out/);
        assert.equal(s.alive, true, 'one timeout is tolerated');
        await assert.rejects(s.request('model/list', {}, { timeoutMs: 30 }), /timed out/);
        assert.equal(s.alive, false, 'second consecutive timeout recycles the process');
        await s.start();
        assert.equal(s.alive, true, 'next start spawns a fresh process');
        s.stop();
    });
});

test('app-server: a slow request on a process that still talks is not treated as a hang', async () => {
    await withMock({ hang: ['model/list'], chatter: true }, async () => {
        const s = new CodexAppServer();
        try {
            await s.start();
            await assert.rejects(s.request('model/list', {}, { timeoutMs: 40 }), /timed out/);
            await assert.rejects(s.request('model/list', {}, { timeoutMs: 40 }), /timed out/);
            await assert.rejects(s.request('model/list', {}, { timeoutMs: 40 }), /timed out/);
            assert.equal(s.alive, true);
        } finally { s.stop(); }
    });
});

test('app-server: callers during a start wait for the isolation check (no early use after initialize)', async () => {
    await withMock({ delay: { 'config/read': 150 } }, async () => {
        const s = new CodexAppServer();
        try {
            const first = s.start();
            for (let i = 0; i < 400 && !s.info; i++) await sleep(5);
            assert.ok(s.info, 'initialize answered');
            assert.equal(s.ready, false, 'not ready before config/read verified isolation');
            assert.equal(s.start(), first, 'a concurrent caller gets the in-flight start');
            await first;
            assert.equal(s.ready, true);
            assert.equal(s.isolation.verified, true);
        } finally { s.stop(); }
    });
});

test('app-server: a process that dies mid-request fails the caller with its stderr', async () => {
    await withMock({ dieOn: 'model/list' }, async () => {
        const s = new CodexAppServer();
        try {
            await s.start();
            await assert.rejects(s.request('model/list', {}, { timeoutMs: 10000 }), /exited \(code 3\).*mock died on model\/list/s);
            assert.equal(s.alive, false);
            await s.start();
            assert.equal(s.ready, true, 'restarts cleanly afterwards');
        } finally { s.stop(); }
    });
});

test('an ultra default in config.toml is never sent as ultra', async () => {
    const home = mkdtempSync(join(tmpdir(), 'st-subs-codex-cfg-'));
    writeFileSync(join(home, 'config.toml'), 'model_reasoning_effort = "ultra"\n');
    const server = new FakeServer({ codexHome: home, script: (s) => { s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'x' }); s.complete(); } });
    const { writer } = makeWriter();
    await runAppServerTurn({ server, messages: MESSAGES, model: 'gpt-6-astra', settings: settings({}), writer, modelProvider: 'openai' });
    assert.equal(server.calls.find((c) => c.method === 'turn/start').params.effort, 'max');
    const plain = new FakeServer({ script: (s) => { s.emit('item/agentMessage/delta', { itemId: 'm1', delta: 'x' }); s.complete(); } });
    await runAppServerTurn({ server: plain, messages: MESSAGES, model: 'gpt-5.5', settings: settings({}), writer: makeWriter().writer, modelProvider: 'openai' });
    assert.equal(plain.calls.find((c) => c.method === 'turn/start').params.effort, undefined, 'no effort chosen → model default');
});

test('codexStatus: a reported AGENTS.md that was removed since no longer blocks', async () => {
    await withMock({ instructionSources: [] }, async ({ home }) => {
        writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));
        const s = await getAppServer();
        const reported = join(home, 'reported-AGENTS.md');
        writeFileSync(reported, 'rules');
        s.lastInstructionSources = [reported]; // as if the last thread/start reported it
        assert.equal((await codexStatus()).backends.subscription.ready, false);
        rmSync(reported);
        const st = await codexStatus();
        assert.deepEqual(st.instructionSources, []);
        assert.equal(st.instructionSourcesVerified, true);
        assert.equal(st.backends.subscription.ready, true);
    });
});

test('runCodexChat subscription: API-key login is refused, ChatGPT login streams', async () => {
    await withMock({ account: { type: 'apiKey' } }, async ({ requests }) => {
        const { res, writer } = makeWriter({ stream: false });
        await runCodexChat({ req: null, messages: MESSAGES, model: 'gpt-5.5', settings: settings({ backend: 'subscription' }), writer, signal: new AbortController().signal });
        assert.equal(res.statusCode, 400);
        assert.match(res.body.error.message, /API key/);
        assert.ok(!requests().some((r) => r.method === 'thread/start'), 'no thread was started');
    });
    await withMock({}, async ({ requests }) => {
        const { res, writer } = makeWriter({ stream: true });
        await runCodexChat({ req: null, messages: MESSAGES, model: 'gpt-5.5', settings: settings({ backend: 'subscription' }), writer, signal: new AbortController().signal });
        assert.equal(sseText(res), 'mock reply');
        const start = requests().find((r) => r.method === 'thread/start');
        assert.equal(start.params.modelProvider, 'openai');
        assert.ok(requests().some((r) => r.method === 'thread/unsubscribe'));
    });
    await withMock({ instructionSources: ['/x/AGENTS.md'] }, async () => {
        const { res, writer } = makeWriter({ stream: false });
        await runCodexChat({ req: null, messages: MESSAGES, model: 'gpt-5.5', settings: settings({ backend: 'subscription' }), writer, signal: new AbortController().signal });
        assert.equal(res.statusCode, 400);
        assert.match(res.body.error.message, /AGENTS\.md/);
    });
});

test('codexStatus: backends contract and ChatGPT-only subscription readiness', async () => {
    await withMock({ account: { type: 'apiKey' } }, async ({ home }) => {
        writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-not-real' }));
        const st = await codexStatus({ deep: false });
        assert.equal(st.cli.found, true);
        assert.equal(st.cli.version, '9.9.9');
        assert.equal(st.backends.subscription.ready, false);
        assert.equal(st.ok, false);
        assert.equal(st.login.loggedIn, false);
        assert.equal(st.login.apiKeyLogin, true);
        assert.equal(st.backends.api.ready, null);
        const deep = await codexStatus({ deep: true });
        assert.equal(deep.account.type, 'apiKey');
        assert.equal(deep.backends.subscription.ready, false);
    });
    await withMock({}, async ({ home }) => {
        writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));
        process.env.OPENAI_API_KEY = 'sk-test-not-real';
        const st = await codexStatus({ deep: false });
        assert.equal(st.backends.subscription.ready, true);
        assert.equal(st.ok, true);
        assert.equal(st.backends.api.ready, true);
        assert.equal(st.backends.api.source, 'OPENAI_API_KEY');
        writeFileSync(join(home, 'AGENTS.md'), 'my private agent rules');
        const withAgents = await codexStatus({ deep: false });
        assert.equal(withAgents.backends.subscription.ready, false);
        assert.deepEqual(withAgents.instructionSources, [join(home, 'AGENTS.md')]);
        assert.equal(withAgents.instructionSourcesVerified, false);
    });
});

test('subscriptionReadiness covers keyring logins and unknown modes', () => {
    const launch = { path: 'x' };
    assert.equal(subscriptionReadiness({ launch: null, auth: { present: false } }).ready, false);
    assert.equal(subscriptionReadiness({ launch, auth: { present: false, path: '/h/auth.json' }, config: { top: { cli_auth_credentials_store: 'keyring' } } }).ready, null);
    assert.equal(subscriptionReadiness({ launch, auth: { present: false, path: '/h/auth.json' }, config: { top: {} } }).ready, false);
    assert.equal(subscriptionReadiness({ launch, auth: { present: true, mode: 'chatgpt' } }).ready, true);
    assert.equal(subscriptionReadiness({ launch, auth: { present: true, mode: 'weird' } }).ready, null);
    assert.equal(subscriptionReadiness({ launch, account: { type: 'chatgpt' }, auth: { present: false } }).ready, true);
    assert.equal(subscriptionReadiness({ launch, account: { type: 'chatgpt' }, auth: { present: false }, instructionSources: ['/a'] }).ready, false);
    assert.equal(subscriptionReadiness({ launch, account: { type: 'chatgpt' }, auth: { present: false }, startError: 'boom' }).ready, false);
});
