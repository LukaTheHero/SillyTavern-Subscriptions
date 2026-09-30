#!/usr/bin/env node
// `npm run doctor` — print what the plugin can see on this machine without
// starting SillyTavern: platform, Node, each CLI, logins, keys, catalogs.
// `npm run doctor -- --deep` also starts the Codex app-server for
// account/rate-limit reads.
//
// Each provider is judged by its DEFAULT backend (the subscription): an API
// key alone never makes a provider "OK", because the default never bills it.
// Exit code 1 when no provider's subscription is usable.

import { aggregateStatus } from '../lib/status.js';
import { unifiedModelList } from '../lib/models.js';
import { stopAppServer } from '../lib/codex/app-server.js';

const deep = process.argv.includes('--deep') || process.env.npm_config_deep === 'true';
const readyWord = (r) => (r === true ? 'ready' : (r === false ? 'NOT READY' : 'unknown'));
const tick = (r) => (r === true ? 'OK  ' : (r === false ? 'FAIL' : ' ?  '));

function backendLines(p) {
    const b = p?.backends ?? {};
    const lines = [];
    lines.push(`     subscription (default): ${readyWord(b.subscription?.ready)}${b.subscription?.message ? ` — ${b.subscription.message}` : ''}`);
    if (b.api?.ready === true) lines.push(`     api key (Auto overflow / API backend): ${b.api.source ?? 'found'}${b.api.baseUrl ? ` → ${b.api.baseUrl}` : ''}`);
    else lines.push(`     api key: ${b.api?.message ?? 'none found in the environment'}`);
    return lines;
}

let anyReady = false;
try {
    const s = await aggregateStatus({ deep });
    console.log(`SillyTavern-Subscriptions v${s.version} — ${s.platform}, node ${s.node}`);
    console.log('');

    const c = s.providers.claude;
    const cReady = c.backends?.subscription?.ready ?? (c.ok ? true : false);
    console.log(`${tick(c.available ? cReady : false)} Claude (Anthropic Pro/Max)`);
    console.log(`     Agent SDK: ${c.sdk} ${c.sdkVersion ?? ''}`);
    console.log(`     Claude Code CLI: ${c.cli?.path ? `${c.cli.version ? `v${c.cli.version} ` : ''}(${c.cli.source})` : 'not found'}`);
    for (const l of backendLines(c)) console.log(l);
    if (c.message) console.log(`     ! ${c.message}`);

    const x = s.providers.codex;
    const xReady = x.backends?.subscription?.ready ?? null;
    console.log(`${tick(x.available === false ? false : xReady)} Codex (ChatGPT Plus/Pro)`);
    console.log(`     CLI: ${x.cli?.found ? `${x.cli.path} v${x.cli.version ?? '?'} (${x.cli.source})` : 'not found'}`);
    if (x.home) console.log(`     home: ${x.home}`);
    for (const l of backendLines(x)) console.log(l);
    if (x.config?.modelProvider && x.config.modelProvider !== 'openai') console.log(`     note: config.toml routes the CLI through provider "${x.config.modelProvider}" — only Auto follows it`);
    if (x.rateLimits?.windows?.length) for (const w of x.rateLimits.windows) console.log(`     ${w.type}: ${Math.round((w.utilization ?? 0) * 100)}% used`);
    if (x.message) console.log(`     ! ${x.message}`);

    const g = s.providers.gemini;
    const gReady = g.backends?.subscription?.ready ?? null;
    console.log(`${tick(g.available === false ? false : gReady)} Gemini (Google Antigravity)`);
    console.log(`     CLI: ${g.cli?.found ? `${g.cli.path} v${g.cli.version ?? '?'} (${g.cli.source})` : 'not found'}`);
    if (g.billing) console.log(`     agy billing: ${g.billing}`);
    for (const l of backendLines(g)) console.log(l);
    if (g.message) console.log(`     ! ${g.message}`);

    anyReady = [c.available && cReady === true, xReady === true, gReady === true].some(Boolean);

    console.log('');
    const list = await unifiedModelList({ live: deep });
    const counts = {};
    for (const m of list.data) counts[m.provider] = (counts[m.provider] ?? 0) + 1;
    console.log(`models advertised on /v1/models: ${JSON.stringify(counts)}`);
    console.log('');
    console.log(anyReady
        ? 'Next: start SillyTavern, open Extensions → Subscriptions → Connect.'
        : 'No subscription is ready yet — log in (claude auth login / codex login / agy) as the user that runs SillyTavern.');
} finally {
    stopAppServer();
}
process.exitCode = anyReady ? 0 : 1;
