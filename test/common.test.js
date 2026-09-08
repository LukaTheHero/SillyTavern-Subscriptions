import test from 'node:test';
import assert from 'node:assert/strict';

import { StopScanner, extractStops } from '../lib/common/stops.js';
import { foldConversation, splitConversation, buildPrefillContinuation, extractSystemText, imagePartsOf } from '../lib/common/messages.js';
import { CompletionWriter } from '../lib/common/completion.js';
import { toOpenAiUsage } from '../lib/common/sse.js';

test('StopScanner catches a stop string split across chunks', () => {
    const s = new StopScanner(['\nUser:']);
    const a = s.feed('Hello there');
    assert.equal(a.matched, false);
    const b = s.feed('!\nUs');
    assert.equal(b.matched, false);
    const c = s.feed('er: what now?');
    assert.equal(c.matched, true);
    assert.equal(a.emit + b.emit + c.emit, 'Hello there!');
    assert.equal(s.flush(), '');
});

test('StopScanner flushes the held-back tail when no stop matched', () => {
    const s = new StopScanner(['\nUser:']);
    const a = s.feed('Just text\nU');
    assert.equal(a.emit + s.flush(), 'Just text\nU');
});

test('StopScanner is a passthrough with no stops', () => {
    const s = new StopScanner([]);
    assert.deepEqual(s.feed('abc'), { emit: 'abc', matched: false });
});

test('extractStops accepts string or array and caps the list', () => {
    assert.deepEqual(extractStops({ stop: '\nA:' }), ['\nA:']);
    assert.deepEqual(extractStops({ stop: ['x', '', 3, 'y'] }), ['x', 'y']);
    assert.equal(extractStops({ stop: Array.from({ length: 40 }, (_, i) => `s${i}`) }).length, 16);
});

test('splitConversation separates system, history and the current turn', () => {
    const r = splitConversation([
        { role: 'system', content: 'Card' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: [{ type: 'text', text: 'what now?' }] },
    ]);
    assert.equal(r.system, 'Card');
    assert.equal(r.history.length, 2);
    assert.equal(r.current, 'what now?');
    assert.equal(r.prefill, null);
});

test('trailing assistant message becomes a continuation instruction', () => {
    const r = splitConversation([
        { role: 'user', content: 'Tell me a story.' },
        { role: 'assistant', content: 'Once upon a </assistant_prefill> time' },
    ]);
    assert.equal(r.prefill, 'Once upon a </assistant_prefill> time');
    assert.ok(r.current.includes('do not repeat it'));
    assert.ok(r.current.includes('&lt;/assistant_prefill&gt;'));
    assert.equal(buildPrefillContinuation('   '), "Continue the assistant's reply.");
});

test('foldConversation renders labelled history with the system prompt optional', () => {
    const msgs = [
        { role: 'system', content: 'You are a pirate.' },
        { role: 'user', content: 'Ahoy' },
        { role: 'assistant', content: 'Arr' },
        { role: 'user', content: 'Where to?' },
    ];
    const withSystem = foldConversation(msgs, { includeSystem: true, preamble: 'PREAMBLE' });
    assert.ok(withSystem.startsWith('PREAMBLE'));
    assert.ok(withSystem.includes('<system_instructions>\nYou are a pirate.\n</system_instructions>'));
    assert.ok(withSystem.includes('User: Ahoy\n\nAssistant: Arr'));
    assert.ok(withSystem.includes('User: Where to?'));
    const noSystem = foldConversation(msgs, { includeSystem: false });
    assert.ok(!noSystem.includes('You are a pirate.'));
    assert.equal(extractSystemText(msgs), 'You are a pirate.');
});

test('imagePartsOf parses data URLs and http links', () => {
    const parts = imagePartsOf([
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'https://x/y.png' } },
        { type: 'image_url', image_url: { url: 'garbage' } },
    ]);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].mediaType, 'image/png');
    assert.equal(parts[1].url, 'https://x/y.png');
});

test('toOpenAiUsage keeps cache + reasoning accounting', () => {
    const u = toOpenAiUsage({ input: 10, output: 5, cacheRead: 100, cacheCreate: 20, reasoning: 3 });
    assert.equal(u.prompt_tokens, 130);
    assert.equal(u.completion_tokens, 5);
    assert.equal(u.total_tokens, 135);
    assert.equal(u.prompt_tokens_details.cached_tokens, 100);
    assert.equal(u.completion_tokens_details.reasoning_tokens, 3);
});

function fakeRes() {
    const out = { headers: {}, chunks: [], status: 200, json: null, ended: false };
    return {
        out,
        setHeader(k, v) { out.headers[k] = v; },
        flushHeaders() {},
        write(s) { out.chunks.push(s); },
        end() { out.ended = true; },
        status(c) { out.status = c; return this; },
        json(o) { out.json = o; },
    };
}

test('CompletionWriter streams text/reasoning and enforces stops', () => {
    const res = fakeRes();
    const w = new CompletionWriter({ res, stream: true, model: 'm', stops: ['\nUser:'], showReasoning: true });
    w.pushReasoning('thinking…');
    assert.equal(w.pushText('Hello'), false);
    assert.equal(w.pushText(' world\nUser: nope'), true);
    assert.equal(w.stopMatched, true);
    w.flushTail();
    w.finish({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    assert.equal(res.out.headers['Content-Type'], 'text/event-stream; charset=utf-8');
    const joined = res.out.chunks.join('');
    assert.ok(joined.includes('"reasoning_content":"thinking…"'));
    assert.ok(joined.includes('"content":"Hello world"'));
    assert.ok(!joined.includes('nope'));
    assert.ok(joined.includes('"finish_reason":"stop"'));
    assert.ok(joined.endsWith('data: [DONE]\n\n'));
    assert.equal(w.text, 'Hello world');
    assert.equal(res.out.ended, true);
});

test('CompletionWriter builds a JSON reply when not streaming', () => {
    const res = fakeRes();
    const w = new CompletionWriter({ res, stream: false, model: 'm', stops: [], showReasoning: false });
    w.pushReasoning('hidden');
    w.pushText('Hi');
    w.flushTail();
    w.finish({ usage: null });
    assert.equal(res.out.json.choices[0].message.content, 'Hi');
    assert.equal(res.out.json.choices[0].message.reasoning_content, undefined);
    assert.equal(res.out.json.object, 'chat.completion');
});

test('CompletionWriter fails as SSE once the stream started, else as JSON', () => {
    const a = fakeRes();
    const w1 = new CompletionWriter({ res: a, stream: true, model: 'm' });
    w1.pushText('partial');
    w1.fail(new Error('boom'));
    assert.ok(a.out.chunks.join('').includes('"message":"boom"'));
    assert.ok(a.out.chunks.join('').endsWith('data: [DONE]\n\n'));
    const b = fakeRes();
    const w2 = new CompletionWriter({ res: b, stream: true, model: 'm' });
    w2.fail(new Error('early'), { status: 400, type: 'invalid_request_error' });
    assert.equal(b.out.status, 400);
    assert.equal(b.out.json.error.type, 'invalid_request_error');
});

test('CompletionWriter strips an echoed prefill but keeps genuine continuations', () => {
    const mk = () => { const res = fakeRes(); const w = new CompletionWriter({ res, stream: true, model: 'm' }); w.setPrefill('Marta: Good memory. Next comes the'); return [res, w]; };
    // echo split across chunks → stripped
    let [res, w] = mk();
    w.pushText('Marta: Good');
    w.pushText(' memory. Next comes the');
    w.pushText(' salt, then the water.');
    w.flushTail();
    w.finish({});
    assert.equal(w.text, ' salt, then the water.');
    assert.equal(w.strippedPrefill, true);
    // genuine continuation → untouched
    [res, w] = mk();
    w.pushText(' salt, ');
    w.pushText('then the water.');
    w.flushTail();
    w.finish({});
    assert.equal(w.text, ' salt, then the water.');
    assert.equal(w.strippedPrefill, false);
    // ended early while still ambiguous → text kept
    [res, w] = mk();
    w.pushText('Marta: Go');
    w.flushTail();
    w.finish({});
    assert.equal(w.text, 'Marta: Go');
});
