// HTTP-layer tests: CompletionWriter on real sockets (heartbeat, write
// safety after end / disconnect), the OpenAI-compatible passthrough against a
// local mock upstream (timers, cancellation, readable errors), and the
// SillyTavern-side plugin plumbing (UI auto-install, ST-mounted routes).
// Every server here binds 127.0.0.1 on an ephemeral port; nothing leaves the
// machine and no model is ever called.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CompletionWriter } from '../lib/common/completion.js';
import { runOpenAiCompat, normalizeBase, explainFetchError } from '../lib/common/openai-compat.js';
import { isAbortError } from '../lib/common/abort.js';
import { locateSillyTavern, installUiExtension, mountStRoutes, safeRoute } from '../plugin.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(handler, fn) {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        return await fn(base, server);
    } finally {
        for (const s of sockets) s.destroy();
        await new Promise((r) => server.close(r));
    }
}

/** Minimal response double that records what the writer sends. */
function fakeRes() {
    const out = { headers: {}, chunks: [], status: 200, json: null, ended: false };
    return {
        out,
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        setHeader(k, v) { if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT'); out.headers[k] = v; },
        flushHeaders() { this.headersSent = true; },
        write(s) { if (this.writableEnded) throw new Error('write after end'); this.headersSent = true; out.chunks.push(s); },
        end() { this.writableEnded = true; out.ended = true; },
        status(c) { out.status = c; return this; },
        json(o) { if (this.writableEnded) throw new Error('write after end'); out.json = o; this.headersSent = true; this.writableEnded = true; },
    };
}

/** Count uncaught exceptions while `fn` runs (a write after end() would land here). */
async function countUncaught(fn) {
    let count = 0;
    const onErr = () => { count++; };
    process.on('uncaughtException', onErr);
    try {
        await fn();
        await delay(50);
    } finally {
        process.off('uncaughtException', onErr);
    }
    return count;
}

// ── CompletionWriter on a real socket ──

test('startHeartbeat sends SSE headers at once and keep-alive comments until finish', async () => {
    let release;
    const released = new Promise((r) => { release = r; });
    await withServer(async (req, res) => {
        const w = new CompletionWriter({ res, stream: true, model: 'm' });
        w.startHeartbeat(20);
        await released;
        w.pushText('Hello');
        w.flushTail();
        w.finish({});
    }, async (base) => {
        // fetch() resolves on headers — before any content exists. Without the
        // heartbeat this would hang until the timeout.
        const resp = await fetch(base, { signal: AbortSignal.timeout(3000) });
        assert.equal(resp.status, 200);
        assert.match(resp.headers.get('content-type'), /text\/event-stream/);
        await delay(150);
        release();
        const body = await resp.text();
        assert.ok(body.startsWith('data: {'), 'role chunk first');
        assert.ok((body.match(/^: keep-alive$/gm) ?? []).length >= 2, 'several heartbeats');
        assert.ok(body.includes('"content":"Hello"'));
        assert.ok(body.endsWith('data: [DONE]\n\n'), 'nothing after [DONE]');
    });
});

test('writer never writes after the client disconnected (no uncaught error, no throw)', async () => {
    const uncaught = await countUncaught(async () => {
        let done;
        const finished = new Promise((r) => { done = r; });
        await withServer((req, res) => {
            const w = new CompletionWriter({ res, stream: true, model: 'm' });
            w.startHeartbeat(5);
            res.on('close', () => {
                setTimeout(() => {
                    assert.doesNotThrow(() => {
                        w.pushText('late');
                        w.pushReasoning('late');
                        w.flushTail();
                        w.finish({});
                        w.fail(new Error('after close'));
                    });
                    done();
                }, 20);
            });
        }, async (base) => {
            const ac = new AbortController();
            const resp = await fetch(base, { signal: ac.signal });
            assert.equal(resp.status, 200);
            ac.abort();
            await finished;
        });
    });
    assert.equal(uncaught, 0);
});

test('flushTail after a JSON error does not throw ERR_HTTP_HEADERS_SENT', async () => {
    await withServer((req, res) => {
        const w = new CompletionWriter({ res, stream: true, model: 'm' });
        w.setPrefill('Hello there, traveller');
        w.pushText('Hello th'); // held back by the prefill filter
        w.fail(new Error('early'), { status: 400, type: 'invalid_request_error' });
        assert.doesNotThrow(() => { w.flushTail(); w.finish({}); w.fail(new Error('again')); });
    }, async (base) => {
        const resp = await fetch(base);
        assert.equal(resp.status, 400);
        const j = await resp.json();
        assert.equal(j.error.message, 'early');
    });
});

test('finish/fail on an already-ended response are no-ops', () => {
    const res = fakeRes();
    const w = new CompletionWriter({ res, stream: false, model: 'm' });
    res.end(); // someone else ended it
    assert.doesNotThrow(() => { w.pushText('x'); w.flushTail(); w.finish({}); });
    const res2 = fakeRes();
    const w2 = new CompletionWriter({ res: res2, stream: true, model: 'm' });
    res2.destroyed = true;
    assert.doesNotThrow(() => { w2.startHeartbeat(10); w2.pushText('x'); w2.fail(new Error('gone')); });
    assert.equal(res2.out.chunks.length, 0);
});

test('startHeartbeat is a no-op for non-streaming replies', () => {
    const res = fakeRes();
    const w = new CompletionWriter({ res, stream: false, model: 'm' });
    w.startHeartbeat(5);
    assert.equal(res.headersSent, false);
    w.pushText('ok');
    w.finish({});
    assert.equal(res.out.json.choices[0].message.content, 'ok');
});

// ── Prefill-echo filter ──

function prefillRun(prefill, chunks) {
    const res = fakeRes();
    const w = new CompletionWriter({ res, stream: false, model: 'm' });
    w.setPrefill(prefill);
    for (const c of chunks) w.pushText(c);
    w.flushTail();
    w.finish({});
    return { text: w.text, stripped: w.strippedPrefill };
}

test('prefill echo: plain echo is stripped', () => {
    assert.deepEqual(prefillRun('She smiled and waved.', ['She smiled and waved. Then she left.']), { text: ' Then she left.', stripped: true });
});

test('prefill echo: *action* prefill echoed verbatim is stripped', () => {
    assert.deepEqual(prefillRun('*She smiles.*', ['*She smiles.* Then she waves.']), { text: ' Then she waves.', stripped: true });
    assert.deepEqual(prefillRun('*She smiles.*', ['*She', ' smi', 'les.*', ' Then she waves.']), { text: ' Then she waves.', stripped: true });
});

test('prefill echo: "dialogue" prefill echoed verbatim is stripped', () => {
    assert.deepEqual(prefillRun('"Hello there,"', ['"Hello there," she said.']), { text: ' she said.', stripped: true });
});

test('prefill echo: short prefill "The" does not eat "theater"', () => {
    assert.deepEqual(prefillRun('The', [' theater was dark.']), { text: ' theater was dark.', stripped: false });
});

test('prefill echo: short prefill "I" does not eat "It"', () => {
    assert.deepEqual(prefillRun('I', ['It was raining.']), { text: 'It was raining.', stripped: false });
});

test('prefill echo: a genuine continuation passes untouched', () => {
    assert.deepEqual(prefillRun('Marta: Good memory.', [' She nods', ' slowly.']), { text: ' She nods slowly.', stripped: false });
});

test('prefill echo: short prefills are still stripped on a word boundary, case-insensitively', () => {
    assert.deepEqual(prefillRun('Sure,', ['Sure, let us go.']), { text: ' let us go.', stripped: true });
    assert.deepEqual(prefillRun('I', ['I was there.']), { text: ' was there.', stripped: true });
    assert.deepEqual(prefillRun('hello', ['Hello world']), { text: ' world', stripped: true });
    assert.deepEqual(prefillRun('İstanbul', ['İstanbul is big.']), { text: ' is big.', stripped: true });
});

test('prefill echo: a reply that is only the prefill ends empty; a partial one is kept', () => {
    assert.deepEqual(prefillRun('*She smiles.*', ['*She smiles.*']), { text: '', stripped: true });
    assert.deepEqual(prefillRun('*She smiles.*', ['*She smi']), { text: '*She smi', stripped: false });
});

// ── OpenAI-compatible passthrough ──

function sse(obj) { return `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`; }
const delta = (d, extra = {}) => ({ choices: [{ index: 0, delta: d, finish_reason: null }], ...extra });

test('normalizeBase keeps paths and only appends /v1 to bare origins', () => {
    assert.equal(normalizeBase('https://api.openai.com/v1'), 'https://api.openai.com/v1');
    assert.equal(normalizeBase('https://relay.example/'), 'https://relay.example/v1');
    assert.equal(normalizeBase('https://relay.example'), 'https://relay.example/v1');
    assert.equal(normalizeBase('https://relay.example/v1/'), 'https://relay.example/v1');
    assert.equal(normalizeBase(' https://generativelanguage.googleapis.com/v1beta/openai '), 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(normalizeBase('relay.example'), 'relay.example');
});

test('openai-compat streams reasoning + content, then releases the socket after [DONE]', async () => {
    let upstreamClosed = false;
    let seenBody = null;
    await withServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        seenBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.on('close', () => { upstreamClosed = true; });
        res.write(sse(delta({ reasoning_content: 'hmm' })));
        res.write(sse(delta({ content: 'Hello' })));
        res.write(sse(delta({ content: ' world' })));
        res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        res.write(sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
        res.write(sse('[DONE]'));
        // keep the connection open: the client must let go on its own
    }, async (base) => {
        const res = fakeRes();
        const writer = new CompletionWriter({ res, stream: true, model: 'gpt-x' });
        await runOpenAiCompat({ baseUrl: base, apiKey: 'test-key', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: '' }], writer });
        assert.equal(writer.text, 'Hello world');
        assert.equal(writer.reasoning, 'hmm');
        const joined = res.out.chunks.join('');
        assert.ok(joined.includes('"total_tokens":5'));
        assert.ok(joined.endsWith('data: [DONE]\n\n'));
        assert.equal(seenBody.stream, true);
        assert.deepEqual(seenBody.stream_options, { include_usage: true });
        assert.equal(seenBody.messages.length, 1, 'empty user message dropped');
        for (let i = 0; i < 40 && !upstreamClosed; i++) await delay(25);
        assert.equal(upstreamClosed, true, 'upstream socket released after [DONE]');
    });
});

test('openai-compat non-streaming reply goes through the writer', async () => {
    await withServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Done.', reasoning_content: 'r' }, finish_reason: 'length' }], usage: { total_tokens: 9 } }));
    }, async (base) => {
        const res = fakeRes();
        const writer = new CompletionWriter({ res, stream: false, model: 'gpt-x' });
        await runOpenAiCompat({ baseUrl: base, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer });
        assert.equal(res.out.json.choices[0].message.content, 'Done.');
        assert.equal(res.out.json.choices[0].message.reasoning_content, 'r');
        assert.equal(res.out.json.choices[0].finish_reason, 'length');
        assert.equal(res.out.json.usage.total_tokens, 9);
    });
});

test('openai-compat HTTP errors are readable and keep the upstream status', async () => {
    await withServer((req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key provided.' } }));
    }, async (base) => {
        const writer = new CompletionWriter({ res: fakeRes(), stream: true, model: 'gpt-x' });
        await assert.rejects(
            runOpenAiCompat({ baseUrl: base, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer }),
            (err) => /^Upstream HTTP 401 from 127\.0\.0\.1:\d+: Invalid API key provided\.$/.test(err.message) && err.httpStatus === 401,
        );
    });
});

test('openai-compat honours an already-aborted signal without contacting upstream', async () => {
    let hits = 0;
    await withServer((req, res) => { hits++; res.end(); }, async (base) => {
        const ac = new AbortController();
        ac.abort();
        const writer = new CompletionWriter({ res: fakeRes(), stream: true, model: 'gpt-x' });
        await assert.rejects(
            runOpenAiCompat({ baseUrl: base, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer, signal: ac.signal }),
            (err) => isAbortError(err),
        );
        await delay(30);
        assert.equal(hits, 0);
    });
});

test('openai-compat: client abort mid-stream cancels the upstream request', async () => {
    let upstreamClosed = false;
    await withServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.on('close', () => { upstreamClosed = true; });
        res.write(sse(delta({ content: 'partial' })));
    }, async (base) => {
        const ac = new AbortController();
        const res = fakeRes();
        const writer = new CompletionWriter({ res, stream: true, model: 'gpt-x' });
        const run = runOpenAiCompat({ baseUrl: base, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer, signal: ac.signal });
        for (let i = 0; i < 40 && !writer.text; i++) await delay(25);
        assert.equal(writer.text, 'partial');
        ac.abort();
        await assert.rejects(run, (err) => isAbortError(err));
        for (let i = 0; i < 40 && !upstreamClosed; i++) await delay(25);
        assert.equal(upstreamClosed, true);
        assert.ok(!res.out.chunks.join('').includes('[DONE]'), 'runner did not finish the reply after the abort');
    });
});

test('openai-compat: a stop match ends the reply and releases the upstream socket', async () => {
    let upstreamClosed = false;
    await withServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.on('close', () => { upstreamClosed = true; });
        res.write(sse(delta({ content: 'Hi there.\nUser: I' })));
    }, async (base) => {
        const res = fakeRes();
        const writer = new CompletionWriter({ res, stream: true, model: 'gpt-x', stops: ['\nUser:'] });
        await runOpenAiCompat({ baseUrl: base, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer });
        assert.equal(writer.text, 'Hi there.');
        assert.equal(writer.stopMatched, true);
        for (let i = 0; i < 40 && !upstreamClosed; i++) await delay(25);
        assert.equal(upstreamClosed, true);
    });
});

test('openai-compat: first-byte, non-stream and idle budgets fail with readable errors', async () => {
    // Upstream accepts the request and never answers.
    await withServer(() => {}, async (base) => {
        const writer = new CompletionWriter({ res: fakeRes(), stream: true, model: 'gpt-x' });
        await assert.rejects(
            runOpenAiCompat({ baseUrl: base, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer, firstByteMs: 150 }),
            /The API backend \(127\.0\.0\.1:\d+\) sent nothing for \d+ s — request aborted\./,
        );
        const writer2 = new CompletionWriter({ res: fakeRes(), stream: false, model: 'gpt-x' });
        await assert.rejects(
            runOpenAiCompat({ baseUrl: base, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer: writer2, firstByteMs: 150 }),
            /did not finish its reply within \d+ s/,
        );
    });
    // Upstream starts streaming, then stalls.
    await withServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse(delta({ content: 'start' })));
    }, async (base) => {
        const writer = new CompletionWriter({ res: fakeRes(), stream: true, model: 'gpt-x' });
        await assert.rejects(
            runOpenAiCompat({ baseUrl: base, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer, firstByteMs: 5000, idleMs: 150 }),
            /went silent for \d+ s mid-reply/,
        );
    });
});

test('openai-compat: an SSE error event surfaces as an error', async () => {
    await withServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse({ error: { message: 'quota exceeded' } }));
    }, async (base) => {
        const writer = new CompletionWriter({ res: fakeRes(), stream: true, model: 'gpt-x' });
        await assert.rejects(
            runOpenAiCompat({ baseUrl: base, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer }),
            /Upstream error: quota exceeded/,
        );
    });
});

test('openai-compat: connection failures and undici timeouts get readable messages', async () => {
    // A port that was just freed → ECONNREFUSED.
    const port = await new Promise((resolve) => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const writer = new CompletionWriter({ res: fakeRes(), stream: true, model: 'gpt-x' });
    await assert.rejects(
        runOpenAiCompat({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], writer }),
        /Cannot reach the API backend \(127\.0\.0\.1:\d+\): ECONNREFUSED/,
    );
    const headersTimeout = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    assert.match(explainFetchError(headersTimeout, 'relay.example').message, /relay\.example\) did not respond within 300 s/);
    const bodyTimeout = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' }) });
    assert.match(explainFetchError(bodyTimeout, 'relay.example').message, /did not respond within 300 s/);
    const own = Object.assign(new Error('Upstream HTTP 500'), { httpStatus: 500 });
    assert.equal(explainFetchError(own, 'x'), own);
});

// ── SillyTavern plumbing (plugin.js) ──

function makeTmp() {
    return mkdtempSync(join(tmpdir(), 'sts-http-test-'));
}

function makeStTree(root) {
    mkdirSync(join(root, 'public', 'scripts', 'extensions', 'third-party'), { recursive: true });
    mkdirSync(join(root, 'plugins'), { recursive: true });
    return root;
}

function makePluginDir(root, version = '3.1.0') {
    const dir = join(root, 'plugin-src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ display_name: 'Subscriptions', js: 'index.js', version }));
    writeFileSync(join(dir, 'index.js'), '// ui');
    writeFileSync(join(dir, 'style.css'), '/* css */');
    return dir;
}

test('locateSillyTavern prefers the working directory and honours DATA_ROOT', () => {
    const tmp = makeTmp();
    try {
        const st = makeStTree(join(tmp, 'st'));
        const devCheckout = join(tmp, 'dev', 'SillyTavern-Subscriptions'); // e.g. plugins/ entry is a junction to here
        mkdirSync(devCheckout, { recursive: true });
        const a = locateSillyTavern({ pluginDir: devCheckout, cwd: st, dataRoot: undefined });
        assert.equal(a.root, st);
        assert.equal(a.dataRoot, join(st, 'data'));
        const b = locateSillyTavern({ pluginDir: devCheckout, cwd: st, dataRoot: 'custom-data' });
        assert.equal(b.dataRoot, join(st, 'custom-data'));
        const abs = join(tmp, 'elsewhere');
        assert.equal(locateSillyTavern({ pluginDir: devCheckout, cwd: st, dataRoot: abs }).dataRoot, abs);
        // cwd is not ST → fall back to <plugin>/../..
        const inPlace = join(st, 'plugins', 'SillyTavern-Subscriptions');
        mkdirSync(inPlace, { recursive: true });
        assert.equal(locateSillyTavern({ pluginDir: inPlace, cwd: tmp, dataRoot: undefined }).root, st);
        assert.equal(locateSillyTavern({ pluginDir: devCheckout, cwd: tmp, dataRoot: undefined }), null);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('installUiExtension installs with a marker, then retires its own copy once a dialog clone appears', () => {
    const tmp = makeTmp();
    const savedEnv = process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
    delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
    try {
        const stRoot = makeStTree(join(tmp, 'st'));
        const pluginDir = makePluginDir(tmp);
        const dataRoot = join(tmp, 'custom-data'); // outside the ST dir, like --dataRoot
        const st = locateSillyTavern({ pluginDir, cwd: stRoot, dataRoot });
        const target = join(st.thirdParty, 'SillyTavern-Subscriptions-UI');

        assert.equal(installUiExtension({ pluginDir, st }), 'installed');
        assert.ok(existsSync(join(target, 'index.js')));
        assert.equal(JSON.parse(readFileSync(join(target, '.auto-installed'), 'utf8')).installedBy, 'sillytavern-subscriptions');
        assert.equal(installUiExtension({ pluginDir, st }), 'current');

        writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ display_name: 'Subscriptions', js: 'index.js', version: '3.2.0' }));
        assert.equal(installUiExtension({ pluginDir, st }), 'updated');

        // Per-user dialog clone under the custom data root → our marked copy goes away.
        const clone = join(dataRoot, 'default-user', 'extensions', 'SillyTavern-Subscriptions');
        mkdirSync(clone, { recursive: true });
        writeFileSync(join(clone, 'manifest.json'), '{}');
        assert.equal(installUiExtension({ pluginDir, st }), 'dialog-clone');
        assert.equal(existsSync(target), false);
    } finally {
        if (savedEnv === undefined) delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL; else process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL = savedEnv;
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('installUiExtension disarms (never deletes) an unmarked older copy and leaves foreign folders alone', () => {
    const tmp = makeTmp();
    const savedEnv = process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
    delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
    try {
        const stRoot = makeStTree(join(tmp, 'st'));
        const pluginDir = makePluginDir(tmp);
        const st = locateSillyTavern({ pluginDir, cwd: stRoot, dataRoot: undefined });
        const target = join(st.thirdParty, 'SillyTavern-Subscriptions-UI');
        // A pre-marker auto-install (same manifest identity, older version) …
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'manifest.json'), JSON.stringify({ display_name: 'Subscriptions', js: 'index.js', version: '3.0.0' }));
        writeFileSync(join(target, 'index.js'), '// old ui');
        // … and a global dialog clone.
        const clone = join(st.thirdParty, 'SillyTavern-Subscriptions');
        mkdirSync(clone, { recursive: true });
        writeFileSync(join(clone, 'manifest.json'), '{}');

        assert.equal(installUiExtension({ pluginDir, st }), 'dialog-clone');
        assert.equal(existsSync(join(target, 'manifest.json')), false);
        assert.equal(existsSync(join(target, 'manifest.json.disabled')), true);
        assert.equal(existsSync(join(target, 'index.js')), true, 'nothing deleted');

        // A folder that is not ours (different manifest) is only reported.
        rmSync(target, { recursive: true, force: true });
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'manifest.json'), JSON.stringify({ display_name: 'Something else', js: 'main.js' }));
        assert.equal(installUiExtension({ pluginDir, st }), 'dialog-clone');
        assert.equal(existsSync(join(target, 'manifest.json')), true);

        // A link (e.g. to a dev checkout) is never followed or removed.
        rmSync(target, { recursive: true, force: true });
        const linked = join(tmp, 'linked-ui');
        mkdirSync(linked, { recursive: true });
        writeFileSync(join(linked, '.auto-installed'), '{}');
        writeFileSync(join(linked, 'manifest.json'), '{}');
        let linkedOk = true;
        try { symlinkSync(linked, target, 'junction'); } catch { linkedOk = false; }
        if (linkedOk) {
            assert.equal(installUiExtension({ pluginDir, st }), 'dialog-clone');
            assert.equal(existsSync(join(linked, 'manifest.json')), true);
            assert.equal(existsSync(join(linked, '.auto-installed')), true);
        }
    } finally {
        if (savedEnv === undefined) delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL; else process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL = savedEnv;
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('installUiExtension keeps the shared copy while only some users of a multi-user install cloned the panel', () => {
    const tmp = makeTmp();
    const savedEnv = process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
    delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
    try {
        const stRoot = makeStTree(join(tmp, 'st'));
        const pluginDir = makePluginDir(tmp);
        const st = locateSillyTavern({ pluginDir, cwd: stRoot, dataRoot: undefined });
        const target = join(st.thirdParty, 'SillyTavern-Subscriptions-UI');
        for (const u of ['default-user', 'alice']) mkdirSync(join(st.dataRoot, u, 'extensions'), { recursive: true });
        mkdirSync(join(st.dataRoot, '_storage'), { recursive: true }); // internal dir, not a user
        const aliceClone = join(st.dataRoot, 'alice', 'extensions', 'SillyTavern-Subscriptions');
        mkdirSync(aliceClone, { recursive: true });
        writeFileSync(join(aliceClone, 'manifest.json'), '{}');

        // default-user still depends on the shared copy → installed, not retired.
        assert.equal(installUiExtension({ pluginDir, st }), 'installed');
        assert.ok(existsSync(join(target, '.auto-installed')));

        // Once every user has their own clone, the shared copy is a pure duplicate.
        const defClone = join(st.dataRoot, 'default-user', 'extensions', 'SillyTavern-Subscriptions');
        mkdirSync(defClone, { recursive: true });
        writeFileSync(join(defClone, 'manifest.json'), '{}');
        assert.equal(installUiExtension({ pluginDir, st }), 'dialog-clone');
        assert.equal(existsSync(target), false);
    } finally {
        if (savedEnv === undefined) delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL; else process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL = savedEnv;
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('installUiExtension never touches a git clone or copies into a linked folder', () => {
    const tmp = makeTmp();
    const savedEnv = process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
    delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
    try {
        const stRoot = makeStTree(join(tmp, 'st'));
        const pluginDir = makePluginDir(tmp);
        const st = locateSillyTavern({ pluginDir, cwd: stRoot, dataRoot: undefined });
        const target = join(st.thirdParty, 'SillyTavern-Subscriptions-UI');

        // A linked folder (dev checkout) with no dialog clone: nothing is copied into it.
        const linked = join(tmp, 'dev-ui');
        mkdirSync(linked, { recursive: true });
        writeFileSync(join(linked, 'manifest.json'), JSON.stringify({ display_name: 'Subscriptions', js: 'index.js', version: '0.0.1' }));
        let linkedOk = true;
        try { symlinkSync(linked, target, 'junction'); } catch { linkedOk = false; }
        if (linkedOk) {
            assert.equal(installUiExtension({ pluginDir, st }), 'linked');
            assert.equal(existsSync(join(linked, '.auto-installed')), false);
            assert.equal(existsSync(join(linked, 'index.js')), false);
            rmSync(target, { recursive: true, force: true });
            assert.equal(existsSync(join(linked, 'manifest.json')), true, 'removing the link kept its target');
        }

        // A git clone at our folder name next to a global dialog clone: reported, not disarmed.
        mkdirSync(join(target, '.git'), { recursive: true });
        writeFileSync(join(target, 'manifest.json'), JSON.stringify({ display_name: 'Subscriptions', js: 'index.js', version: '3.0.0' }));
        const clone = join(st.thirdParty, 'SillyTavern-Subscriptions');
        mkdirSync(clone, { recursive: true });
        writeFileSync(join(clone, 'manifest.json'), '{}');
        assert.equal(installUiExtension({ pluginDir, st }), 'dialog-clone');
        assert.equal(existsSync(join(target, 'manifest.json')), true);
        assert.equal(existsSync(join(target, 'manifest.json.disabled')), false);
    } finally {
        if (savedEnv === undefined) delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL; else process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL = savedEnv;
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('installUiExtension respects ST_SUBSCRIPTIONS_NO_UI_INSTALL and a missing SillyTavern', () => {
    const saved = process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
    try {
        process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL = '1';
        assert.equal(installUiExtension({ pluginDir: tmpdir(), st: null }), 'disabled');
        delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL;
        const tmp = makeTmp();
        try {
            const pluginDir = makePluginDir(tmp);
            assert.equal(installUiExtension({ pluginDir, st: null }), 'no-sillytavern');
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    } finally {
        if (saved === undefined) delete process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL; else process.env.ST_SUBSCRIPTIONS_NO_UI_INSTALL = saved;
    }
});

test('ST-mounted routes are GET-only and registered without a body parser', () => {
    const routes = {};
    const router = {
        use() { throw new Error('no middleware expected on the SillyTavern router'); },
        get(path, handler) { routes[path] = handler; },
    };
    mountStRoutes(router);
    assert.deepEqual(Object.keys(routes).sort(), ['/models', '/quota', '/status']);
    for (const h of Object.values(routes)) assert.equal(typeof h, 'function');
});

test('safeRoute turns sync throws and rejections into JSON 500s, never unhandled rejections', async () => {
    const mkRes = (headersSent = false) => {
        const out = { status: null, body: null, ended: false };
        return {
            out,
            headersSent,
            status(c) { out.status = c; return this; },
            json(o) { out.body = o; },
            end() { out.ended = true; },
        };
    };
    const req = { method: 'GET', url: '/status', originalUrl: '/api/plugins/subscriptions/status' };
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    const origError = console.error;
    console.error = () => {};
    try {
        const a = mkRes();
        safeRoute(async () => { throw new Error('async boom'); })(req, a, () => {});
        const b = mkRes();
        safeRoute(() => { throw new Error('sync boom'); })(req, b, () => {});
        const c = mkRes(true);
        safeRoute(async () => { throw new Error('late boom'); })(req, c, () => {});
        const d = mkRes();
        safeRoute(async (_req, res) => { res.json({ ok: true }); })(req, d, () => {});
        await delay(30);
        assert.equal(a.out.status, 500);
        assert.deepEqual(a.out.body, { error: { message: 'async boom', type: 'server_error' } });
        assert.equal(b.out.status, 500);
        assert.equal(b.out.body.error.message, 'sync boom');
        assert.equal(c.out.ended, true);
        assert.equal(c.out.body, null);
        assert.deepEqual(d.out.body, { ok: true });
        assert.equal(d.out.status, null);
    } finally {
        console.error = origError;
        process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(unhandled, 0);
});

// ── /status and /v1/models helpers ──

test('pluginVersion reads package.json; a failed provider probe keeps the status shape', async () => {
    const { pluginVersion, failedProviderStatus } = await import('../lib/status.js');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pluginVersion(), pkg.version);
    const s = failedProviderStatus('codex', new Error('probe blew up'));
    assert.equal(s.provider, 'codex');
    assert.equal(s.ok, false);
    assert.equal(s.available, false);
    assert.equal(s.message, 'probe blew up');
    assert.equal(s.backends.subscription.ready, null);
    assert.equal(s.backends.api.ready, null);
});

test('Claude models are listed whenever the CLI exists, login or not', async () => {
    const { providerUsability } = await import('../lib/models.js');
    const { claudeCliSummary } = await import('../lib/claude/sdk-loader.js');
    assert.equal(providerUsability().claude, !!claudeCliSummary().path);
});
