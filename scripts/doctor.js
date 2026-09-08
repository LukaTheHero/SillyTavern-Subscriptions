#!/usr/bin/env node
// `npm run doctor` — print what the plugin can see on this machine without
// starting SillyTavern: platform, Node, each CLI, logins, keys, catalogs.
// Pass --deep to also start the Codex app-server for account/rate-limit reads.

import { aggregateStatus } from '../lib/status.js';
import { unifiedModelList } from '../lib/models.js';
import { stopAppServer } from '../lib/codex/app-server.js';

const deep = process.argv.includes('--deep');
const tick = (ok) => (ok ? 'OK  ' : 'FAIL');

try {
    const s = await aggregateStatus({ deep });
    console.log(`SillyTavern-Subscriptions v${s.version} — ${s.platform}, node ${s.node}`);
    console.log('');

    const c = s.providers.claude;
    console.log(`${tick(c.ok)} Claude (Anthropic Pro/Max)`);
    console.log(`     Agent SDK: ${c.sdk} ${c.sdkVersion ?? ''}`);
    console.log(`     CLI: ${c.cli?.path ?? 'not found'} (${c.cli?.source ?? '-'})`);
    console.log(`     login: ${c.credential?.present ? `${c.credential.subscriptionType}${c.credential.expired ? ' (token expired — refreshes on next chat)' : ''}` : 'none — run `claude login`'}`);
    console.log(`     api/LinkAPI key: ${c.api?.available ? `${c.api.source} → ${c.api.baseUrl}` : 'none'}`);
    if (c.message) console.log(`     ! ${c.message}`);

    const x = s.providers.codex;
    console.log(`${tick(x.ok)} Codex (ChatGPT Plus/Pro)`);
    console.log(`     CLI: ${x.cli?.found ? `${x.cli.path} v${x.cli.version ?? '?'} (${x.cli.source})` : 'not found'}`);
    console.log(`     home: ${x.home}`);
    console.log(`     login: ${x.login?.loggedIn ? x.login.mode : 'none — run `codex login`'}${x.account?.planType ? ` (${x.account.planType})` : ''}`);
    console.log(`     provider in config.toml: ${x.config?.modelProvider}${x.config?.overflowProvider ? ` (overflow provider: ${x.config.overflowProvider})` : ''}`);
    console.log(`     isolation: ${x.config?.mcpServersDisabled ?? 0} MCP servers, ${x.config?.pluginsDisabled ?? 0} plugins disabled for roleplay`);
    console.log(`     api/LinkAPI key: ${x.api?.available ? `${x.api.source} → ${x.api.baseUrl}` : 'none'}`);
    if (x.rateLimits?.windows?.length) for (const w of x.rateLimits.windows) console.log(`     ${w.type}: ${Math.round(w.utilization * 100)}% used`);
    if (x.message) console.log(`     ! ${x.message}`);

    const g = s.providers.gemini;
    console.log(`${tick(g.ok)} Gemini (Google Antigravity)`);
    console.log(`     CLI: ${g.cli?.found ? `${g.cli.path} v${g.cli.version ?? '?'} (${g.cli.source})` : 'not found'}`);
    console.log(`     routing: ${g.settings?.routing ?? 'unknown'}`);
    console.log(`     api/LinkAPI key: ${g.api?.available ? `${g.api.source} → ${g.api.baseUrl}` : 'none'}`);
    if (g.message) console.log(`     ! ${g.message}`);

    console.log('');
    const list = await unifiedModelList({ live: deep });
    const counts = {};
    for (const m of list.data) counts[m.provider] = (counts[m.provider] ?? 0) + 1;
    console.log(`models advertised on /v1/models: ${JSON.stringify(counts)}`);
    console.log('');
    console.log('Next: start SillyTavern, open Extensions → Subscriptions → Connect.');
} finally {
    stopAppServer();
}
