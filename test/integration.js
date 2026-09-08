// Standalone integration harness — runs the listener WITHOUT SillyTavern.
//
//   node test/integration.js                 # status + model lists + 501 check
//   LIVE=1 node test/integration.js          # + one tiny chat per usable provider (spends quota!)
//   LIVE=claude,codex node test/integration.js
//   PORT=8911 STREAM=0 node test/integration.js
//
// Never run this against the port SillyTavern's copy of the plugin already
// uses — pick a spare one (default 8911).

import { startStandaloneListener, stopStandaloneListener } from '../lib/listener.js';
import { stopAppServer } from '../lib/codex/app-server.js';

const PORT = parseInt(process.env.PORT ?? '8911', 10);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const LIVE = (process.env.LIVE ?? '').toLowerCase();
const liveProviders = LIVE === '1' || LIVE === 'true' || LIVE === 'all' ? ['claude', 'codex', 'gemini'] : LIVE.split(',').map((s) => s.trim()).filter(Boolean);
const STREAM = process.env.STREAM !== '0';
const MODELS = {
    claude: process.env.CLAUDE_MODEL ?? 'claude-fable-5-1',
    codex: process.env.CODEX_MODEL ?? 'gpt-5.5',
    gemini: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash-low',
};

const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function readSse(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let chunks = 0;
    let usage = null;
    let finish = null;
    let error = null;
    let gotDone = false;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') { gotDone = true; continue; }
            let json;
            try { json = JSON.parse(payload); } catch { continue; }
            if (json.error) { error = json.error.message; continue; }
            chunks++;
            const d = json.choices?.[0]?.delta ?? {};
            if (d.content) text += d.content;
            if (d.reasoning_content) reasoning += d.reasoning_content;
            if (json.choices?.[0]?.finish_reason) finish = json.choices[0].finish_reason;
            if (json.usage) usage = json.usage;
        }
    }
    return { text, reasoning, chunks, usage, finish, error, gotDone };
}

async function chat(provider, { stream, stop }) {
    const body = {
        model: MODELS[provider],
        stream,
        max_tokens: 400,
        messages: [
            { role: 'system', content: 'You are Captain Redbeard, a pirate in a text roleplay. Stay in character. Keep replies under 40 words.' },
            { role: 'user', content: 'Ahoy! Tell me in one sentence what you think of the sea, then stop.' },
        ],
        subscriptions: { show_reasoning: true, [provider]: { backend: 'auto' } },
    };
    if (stop) body.stop = stop;
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ms = Date.now() - t0;
    if (stream) {
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, ms };
        const r = await readSse(res);
        return { ok: !r.error && r.text.length > 0 && r.gotDone, detail: r.error ? `SSE error: ${r.error}` : `${r.chunks} chunks, ${r.text.length} chars, reasoning ${r.reasoning.length} chars, finish ${r.finish}, usage ${JSON.stringify(r.usage)} :: ${JSON.stringify(r.text.slice(0, 160))}`, ms };
    }
    const data = await res.json().catch(async () => ({ error: { message: await res.text() } }));
    if (!res.ok || data.error) return { ok: false, detail: `HTTP ${res.status}: ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`, ms };
    const msg = data.choices?.[0]?.message ?? {};
    return { ok: typeof msg.content === 'string' && msg.content.length > 0, detail: `${msg.content?.length ?? 0} chars, reasoning ${(msg.reasoning_content ?? '').length} chars, usage ${JSON.stringify(data.usage)} :: ${JSON.stringify((msg.content ?? '').slice(0, 160))}`, ms };
}

async function multiTurn(provider) {
    const body = {
        model: MODELS[provider],
        stream: true,
        max_tokens: 300,
        stop: ['\nUser:', '\nCaptain:'],
        messages: [
            { role: 'system', content: 'Cozy text roleplay in a village bakery. You are Marta, the baker. The user plays Tobias, her new apprentice. Keep replies under 30 words. Never speak for Tobias.' },
            { role: 'user', content: 'Tobias: Good morning, Marta! What are we baking first today?' },
            { role: 'assistant', content: 'Marta: Rye loaves, Tobias — the miller brought fresh flour. Wash your hands and fetch the big bowl.' },
            { role: 'user', content: 'Tobias: Got it. How much flour should I measure?' },
            { role: 'assistant', content: 'Marta: Three scoops. And tell me, lad — which flour did I say the miller brought?' },
            { role: 'user', content: 'Tobias: Rye, you said rye. Three scoops it is. What goes in next?' },
            { role: 'assistant', content: 'Marta: Good memory. Next comes the' },
        ],
        subscriptions: { show_reasoning: false, [provider]: { backend: 'auto' } },
    };
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, ms };
    const r = await readSse(res);
    const repeatsPrefill = /next comes the/i.test(r.text);
    const speaksForJim = /\bTobias:/.test(r.text);
    return { ok: !r.error && r.text.length > 0 && !speaksForJim, detail: `${r.chunks} chunks, prefill-repeated=${repeatsPrefill}, speaks-for-user=${speaksForJim} :: ${JSON.stringify(r.text.slice(0, 200))}${r.error ? ' ERROR ' + r.error : ''}`, ms };
}

async function main() {
    await startStandaloneListener({ port: PORT, host: HOST });
    try {
        const status = await (await fetch(`${BASE}/status?deep=1`)).json();
        record('GET /status', status.plugin === 'subscriptions', `v${status.version} ${status.platform} node ${status.node}`);
        for (const p of ['claude', 'codex', 'gemini']) {
            const s = status.providers[p];
            console.log(`      ${p}: ok=${s.ok} available=${s.available}${s.message ? ' — ' + s.message : ''}`);
            if (p === 'claude') console.log(`        sdk ${s.sdkVersion}, cli ${s.cli?.source}, login ${s.credential?.present ? s.credential.subscriptionType : 'none'}, api ${s.api?.available ? s.api.source : 'none'}`);
            if (p === 'codex') console.log(`        cli ${s.cli?.version ?? '-'} (${s.cli?.source ?? '-'}), home ${s.home}, login ${s.login?.loggedIn ? s.login.mode : 'none'}, provider ${s.config?.modelProvider}, api ${s.api?.available ? s.api.source : 'none'}, catalog ${s.catalogSource}`);
            if (p === 'gemini') console.log(`        cli ${s.cli?.version ?? '-'} (${s.cli?.source ?? '-'}), routing ${s.settings?.routing}, api ${s.api?.available ? s.api.source : 'none'}`);
        }

        const all = await (await fetch(`${BASE}/v1/models`)).json();
        const byProvider = {};
        for (const m of all.data) byProvider[m.provider] = (byProvider[m.provider] ?? 0) + 1;
        record('GET /v1/models', Array.isArray(all.data) && all.data.length > 0, JSON.stringify(byProvider));
        for (const p of ['claude', 'codex', 'gemini']) {
            const list = await (await fetch(`${BASE}/${p}/v1/models`)).json();
            const onlyThis = list.data.every((m) => m.provider === p);
            record(`GET /${p}/v1/models`, list.data.length > 0 && onlyThis, `${list.data.length} models, e.g. ${list.data.slice(0, 3).map((m) => m.id).join(', ')}`);
        }

        const emb = await fetch(`${BASE}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'x' }) });
        record('POST /v1/embeddings → 501', emb.status === 501);

        const bad = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mystery-9000', messages: [{ role: 'user', content: 'hi' }] }) });
        record('unknown model → 400', bad.status === 400);

        const quota = await (await fetch(`${BASE}/v1/usage/quota`)).json();
        record('GET /v1/usage/quota', quota.ok === true, `claude ${quota.claude?.ok ? quota.claude.source : 'n/a'}, codex ${quota.codex ? 'windows ' + quota.codex.windows?.length : 'n/a'}`);

        for (const p of liveProviders) {
            if (!status.providers[p]?.available) { record(`chat ${p}`, false, 'provider unavailable on this host — skipped'); continue; }
            const ns = await chat(p, { stream: false });
            record(`chat ${p} (json)`, ns.ok, `${ns.ms}ms ${ns.detail}`);
            if (STREAM) {
                const st = await chat(p, { stream: true, stop: ['\nUser:'] });
                record(`chat ${p} (sse)`, st.ok, `${st.ms}ms ${st.detail}`);
            }
            if (process.env.MULTI !== '0') {
                // Multi-turn history (exercises Claude's session-resume path and the folds) + a prefill continuation.
                const mt = await multiTurn(p);
                record(`chat ${p} (multi-turn + prefill)`, mt.ok, `${mt.ms}ms ${mt.detail}`);
            }
        }
    } finally {
        stopAppServer();
        await stopStandaloneListener();
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
    console.error('integration harness crashed:', err);
    stopAppServer();
    process.exit(2);
});
