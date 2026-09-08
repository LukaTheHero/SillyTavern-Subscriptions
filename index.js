// ──────────────────────────────────────────────
// Subscriptions — UI extension for the `subscriptions` server plugin
// ──────────────────────────────────────────────
//
// This file is the UI EXTENSION (loaded in the browser). The SERVER plugin
// entry is plugin.js. Keeping the extension at the repo root with manifest.json
// makes the repo installable straight from SillyTavern's "Install extension"
// dialog, AND the server plugin auto-installs these same files — a window
// guard makes whichever copy loads second a no-op.
//
// Built exclusively on SillyTavern.getContext() — no relative imports — so the
// file works unchanged from ANY install location.
//
// What it does:
//   • One-click Connect: pilots SillyTavern's Custom (OpenAI-compatible)
//     source at the plugin's local endpoint. A "scope" picker chooses whether
//     the model list shows every subscription or just one (Claude / Codex /
//     Gemini) — the plugin routes each model to the right backend either way.
//   • Per-provider settings (Claude effort/thinking/identity/resume/fast mode,
//     Codex effort/service tier/reasoning summary, Gemini effort, and a
//     subscription-vs-API backend switch for each) injected per request
//     through `custom_include_body` as a `subscriptions:` block.
//   • Status & quota panel: same-origin plugin route first (works from remote
//     browsers), direct listener fallback.
//
// Injection only fires when the active connection points at this plugin's
// listener, so other Custom endpoints are untouched.

(function () {
    if (window.__stSubscriptionsUiLoaded) {
        console.log('[subscriptions] another copy of the Subscriptions panel is already active — this one stays dormant');
        return;
    }
    window.__stSubscriptionsUiLoaded = true;

    const ctx = SillyTavern.getContext();
    const { eventSource, eventTypes, extensionSettings, saveSettingsDebounced } = ctx;

    const MODULE = 'subscriptions';
    const DEFAULT_BASE = 'http://127.0.0.1:8901';
    const PLUGIN_ROUTE = '/api/plugins/subscriptions';

    const SCOPES = ['all', 'claude', 'codex', 'gemini'];
    const BACKENDS = ['auto', 'subscription', 'api'];
    const CLAUDE_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    const CLAUDE_THINKING = ['adaptive', 'on', 'off'];
    const CODEX_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const CODEX_TIERS = ['standard', 'priority', 'ultrafast'];
    const CODEX_SUMMARIES = ['auto', 'concise', 'detailed', 'none'];
    const GEMINI_EFFORTS = ['auto', 'low', 'medium', 'high'];

    const defaultSettings = {
        enabled: true,
        endpointBase: DEFAULT_BASE,
        scope: 'all',
        showReasoning: true,
        claude: { backend: 'auto', effort: 'auto', thinking: 'adaptive', identityMode: false, useResume: true, fastMode: false },
        codex: { backend: 'auto', effort: 'auto', serviceTier: 'standard', reasoningSummary: 'auto' },
        gemini: { backend: 'auto', effort: 'auto' },
    };

    function migrateLegacy(target) {
        // Pull settings from the three predecessor panels on first run.
        const claude = extensionSettings.claude_max;
        if (claude && typeof claude === 'object') {
            if (CLAUDE_EFFORTS.includes(claude.effort)) target.claude.effort = claude.effort;
            if (CLAUDE_THINKING.includes(claude.thinking)) target.claude.thinking = claude.thinking;
            if (typeof claude.showReasoning === 'boolean') target.showReasoning = claude.showReasoning;
            if (typeof claude.identityMode === 'boolean') target.claude.identityMode = claude.identityMode;
            if (typeof claude.useResume === 'boolean') target.claude.useResume = claude.useResume;
            if (typeof claude.fastMode === 'boolean') target.claude.fastMode = claude.fastMode;
        }
        const codex = extensionSettings.codex_max;
        if (codex && typeof codex === 'object') {
            if (CODEX_EFFORTS.includes(codex.effort)) target.codex.effort = codex.effort;
            if (codex.backend === 'api') target.codex.backend = 'api';
        }
        const gemini = extensionSettings.gemini_antigravity;
        if (gemini && typeof gemini === 'object') {
            if (GEMINI_EFFORTS.includes(gemini.effort)) target.gemini.effort = gemini.effort;
            if (gemini.backend === 'api') target.gemini.backend = 'api';
        }
    }

    function getSettings() {
        if (extensionSettings[MODULE] === undefined) {
            extensionSettings[MODULE] = structuredClone(defaultSettings);
            migrateLegacy(extensionSettings[MODULE]);
        }
        const s = extensionSettings[MODULE];
        for (const key in defaultSettings) {
            if (s[key] === undefined) s[key] = structuredClone(defaultSettings[key]);
            else if (typeof defaultSettings[key] === 'object' && defaultSettings[key] !== null) {
                for (const k2 in defaultSettings[key]) if (s[key][k2] === undefined) s[key][k2] = defaultSettings[key][k2];
            }
        }
        return s;
    }

    function normalizeUrl(url) {
        return String(url ?? '').trim().replace(/\/+$/, '');
    }

    function endpointFor(settings) {
        const base = normalizeUrl(settings.endpointBase) || DEFAULT_BASE;
        return settings.scope && settings.scope !== 'all' ? `${base}/${settings.scope}/v1` : `${base}/v1`;
    }

    function isOurEndpoint(customUrl, settings) {
        const a = normalizeUrl(customUrl).toLowerCase();
        const base = (normalizeUrl(settings.endpointBase) || DEFAULT_BASE).toLowerCase();
        return a !== '' && (a === base || a.startsWith(base + '/'));
    }

    // ── One-click connect (same selector path as ST's /api-url command) ──

    function connect(settings) {
        try {
            const endpoint = endpointFor(settings);
            $('#main_api').val('openai').trigger('change');
            // Endpoint + key MUST be set before the source change: ST's change
            // handler auto-reconnects immediately with whatever URL is current.
            $('#custom_api_url_text').val(endpoint).trigger('input');
            const keyField = $('#api_key_custom');
            if (keyField.length && !String(keyField.val() ?? '').trim()) keyField.val('sk-no-key-needed');
            $('#chat_completion_source').val('custom').trigger('change');
            $('#api_button_openai').trigger('click');
            toastr?.success?.(`Connecting to ${endpoint} — the model list will populate in a moment.`, 'Subscriptions');
        } catch (err) {
            console.error('[subscriptions] connect failed', err);
            toastr?.error?.(String(err), 'Subscriptions');
        }
    }

    // ── Per-request injection (CHAT_COMPLETION_SETTINGS_READY) ──

    function buildIncludeBodyYaml(s) {
        const lines = ['subscriptions:'];
        lines.push(`  show_reasoning: ${s.showReasoning}`);
        lines.push('  claude:');
        lines.push(`    backend: ${s.claude.backend}`);
        if (s.claude.effort !== 'auto') lines.push(`    effort: ${s.claude.effort}`);
        lines.push(`    thinking: ${s.claude.thinking}`);
        lines.push(`    identity_mode: ${s.claude.identityMode}`);
        lines.push(`    use_resume: ${s.claude.useResume}`);
        lines.push(`    fast_mode: ${s.claude.fastMode}`);
        lines.push('  codex:');
        lines.push(`    backend: ${s.codex.backend}`);
        if (s.codex.effort !== 'auto') lines.push(`    effort: ${s.codex.effort}`);
        lines.push(`    service_tier: ${s.codex.serviceTier}`);
        lines.push(`    reasoning_summary: ${s.codex.reasoningSummary}`);
        lines.push('  gemini:');
        lines.push(`    backend: ${s.gemini.backend}`);
        if (s.gemini.effort !== 'auto') lines.push(`    effort: ${s.gemini.effort}`);
        return lines.join('\n');
    }

    const STALE_KEYS = ['subscriptions', 'claude_subscription', 'codex_subscription', 'gemini_subscription'];

    function stripBlocks(text) {
        let out = String(text ?? '');
        for (const key of STALE_KEYS) {
            out = out.replace(new RegExp(`^${key}:[\\s\\S]*?(?=^\\S|\\s*$(?![\\s\\S]))`, 'm'), '');
        }
        return out.replace(/\n{3,}/g, '\n\n').trim();
    }

    function onSettingsReady(data) {
        try {
            const settings = getSettings();
            if (!settings.enabled) return;
            if (!data || data.chat_completion_source !== 'custom') return;
            if (!isOurEndpoint(data.custom_url, settings)) return;
            const cleaned = stripBlocks(data.custom_include_body);
            data.custom_include_body = (cleaned ? cleaned + '\n' : '') + buildIncludeBodyYaml(settings);
        } catch (err) {
            console.error('[subscriptions] failed to inject settings', err);
        }
    }

    // ── Fetch helpers: same-origin plugin route first, direct listener fallback ──

    async function pluginFetch(routePath, listenerPath, settings, timeoutMs = 20000) {
        let res = null;
        try {
            res = await fetch(`${PLUGIN_ROUTE}${routePath}`, { signal: AbortSignal.timeout(timeoutMs) });
        } catch { /* fall through */ }
        if (!res || !res.ok) {
            const base = normalizeUrl(settings.endpointBase) || DEFAULT_BASE;
            res = await fetch(`${base}${listenerPath}`, { signal: AbortSignal.timeout(timeoutMs) });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    // ── Status & quota rendering ──

    const WINDOW_LABELS = {
        five_hour: '5-hour window',
        seven_day: '7-day (all models)',
        seven_day_opus: '7-day (Opus)',
        seven_day_sonnet: '7-day (Sonnet)',
        seven_day_fable: '7-day (Fable)',
        seven_day_oauth_apps: '7-day (apps)',
        seven_day_overage_included: '7-day incl. overage',
        primary: '5-hour window',
        secondary: 'Weekly window',
    };

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function row(label, valueText, tone) {
        const r = el('div', 'st-subs-status-row');
        r.append(el('span', null, label));
        const v = el('span', tone ? `st-subs-tag-${tone}` : null, valueText);
        r.append(v);
        return r;
    }

    function quotaRows(windows) {
        const frag = document.createDocumentFragment();
        for (const w of windows ?? []) {
            const pct = w.utilization !== null && w.utilization !== undefined ? Math.round(w.utilization * 100) : null;
            const r = el('div', 'st-subs-quota-row');
            r.append(el('span', null, WINDOW_LABELS[w.type] ?? w.type));
            const bar = el('div', 'st-subs-quota-bar');
            const fill = el('div', 'st-subs-quota-fill');
            fill.style.width = `${Math.min(100, pct ?? 0)}%`;
            if ((pct ?? 0) >= 90) fill.classList.add('critical');
            else if ((pct ?? 0) >= 70) fill.classList.add('warning');
            bar.append(fill);
            const resets = w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
            r.append(bar, el('span', null, pct !== null ? `${pct}%${resets}` : `–${resets}`));
            frag.append(r);
        }
        return frag;
    }

    function setBadge(provider, tone, text) {
        const b = document.getElementById(`st_subs_badge_${provider}`);
        if (!b) return;
        b.className = `st-subs-badge ${tone}`;
        b.textContent = text;
    }

    async function refreshStatus() {
        const settings = getSettings();
        const box = document.getElementById('st_subs_status');
        if (!box) return;
        box.textContent = 'Checking…';
        try {
            const [status, quota] = await Promise.all([
                pluginFetch('/status?deep=1', '/status?deep=1', settings, 30000),
                pluginFetch('/quota?deep=1', '/v1/usage/quota?deep=1', settings, 20000).catch(() => null),
            ]);
            box.innerHTML = '';
            const p = status.providers ?? {};

            // Plugin line
            box.append(row('Plugin', `v${status.version} · ${status.platform} · node ${status.node}${status.listener?.running ? ` · :${status.listener.port}` : ' · listener DOWN'}`, status.listener?.running ? 'ok' : 'err'));

            // Claude
            {
                const c = p.claude ?? {};
                const sec = el('div', 'st-subs-status-section');
                sec.append(el('b', null, 'Claude (Anthropic Pro/Max)'));
                sec.append(row('Agent SDK', c.sdk === 'loaded' ? `loaded (${c.sdkVersion})` : 'unavailable', c.sdk === 'loaded' ? 'ok' : 'err'));
                sec.append(row('Claude CLI', c.cli?.path ? `${c.cli.source}` : 'not found', c.cli?.path ? 'ok' : 'err'));
                const cred = c.credential ?? {};
                sec.append(row('Login', cred.present ? `${cred.subscriptionType ?? 'unknown'}${cred.rateLimitTier ? ` (${cred.rateLimitTier})` : ''}${cred.expired ? ' · token expired (auto-refresh on next chat)' : ''}` : 'not logged in (claude login)', cred.present ? (cred.expired ? 'warn' : 'ok') : 'err'));
                sec.append(row('API/LinkAPI key', c.api?.available ? `${c.api.source} → ${c.api.baseUrl}` : 'none', c.api?.available ? 'ok' : undefined));
                if (c.message) sec.append(row('Note', c.message, 'warn'));
                const q = quota?.claude;
                if (q?.ok && q.windows?.length) sec.append(quotaRows(q.windows));
                if (q?.extraUsage?.isEnabled) sec.append(row('Extra Usage', `${q.extraUsage.usedCredits} / ${q.extraUsage.monthlyLimit} ${q.extraUsage.currency}`));
                box.append(sec);
                setBadge('claude', c.ok ? 'ok' : (c.available ? 'warn' : 'err'), c.ok ? 'ready' : (c.available ? 'needs login' : 'unavailable'));
            }
            // Codex
            {
                const c = p.codex ?? {};
                const sec = el('div', 'st-subs-status-section');
                sec.append(el('b', null, 'Codex (ChatGPT Plus/Pro)'));
                sec.append(row('Codex CLI', c.cli?.found ? `v${c.cli.version ?? '?'} (${c.cli.source})` : 'not found', c.cli?.found ? 'ok' : 'err'));
                if (c.home) sec.append(row('Codex home', c.home));
                const login = c.login ?? {};
                sec.append(row('ChatGPT login', login.loggedIn ? `${login.mode}${c.account?.planType ? ` · ${c.account.planType}` : ''}` : 'not logged in (codex login)', login.loggedIn ? 'ok' : (c.config?.overflowProvider ? 'warn' : 'err')));
                sec.append(row('Routing', c.config?.modelProvider && c.config.modelProvider !== 'openai' ? `relay provider "${c.config.modelProvider}" (overflow ON)` : 'openai (subscription)', c.config?.modelProvider && c.config.modelProvider !== 'openai' ? 'warn' : 'ok'));
                sec.append(row('API/LinkAPI key', c.api?.available ? `${c.api.source} → ${c.api.baseUrl}` : 'none', c.api?.available ? 'ok' : undefined));
                sec.append(row('Isolation', `${c.config?.mcpServersDisabled ?? 0} MCP servers / ${c.config?.pluginsDisabled ?? 0} plugins disabled for roleplay`));
                if (c.message) sec.append(row('Note', c.message, 'warn'));
                const rl = quota?.codex ?? c.rateLimits;
                if (rl?.windows?.length) sec.append(quotaRows(rl.windows));
                if (rl?.planType) sec.append(row('Plan', rl.planType));
                box.append(sec);
                setBadge('codex', c.ok ? 'ok' : (c.available ? 'warn' : 'err'), c.ok ? 'ready' : (c.available ? 'needs login' : 'unavailable'));
            }
            // Gemini
            {
                const c = p.gemini ?? {};
                const sec = el('div', 'st-subs-status-section');
                sec.append(el('b', null, 'Gemini (Google Antigravity)'));
                sec.append(row('Antigravity CLI', c.cli?.found ? `v${c.cli.version ?? '?'} (${c.cli.source})` : 'not found', c.cli?.found ? 'ok' : 'err'));
                sec.append(row('Routing', c.settings?.routing ?? 'unknown', c.settings?.overflowOn ? 'warn' : 'ok'));
                sec.append(row('API/LinkAPI key', c.api?.available ? `${c.api.source} → ${c.api.baseUrl}` : 'none', c.api?.available ? 'ok' : undefined));
                if (c.message) sec.append(row('Note', c.message, 'warn'));
                box.append(sec);
                setBadge('gemini', c.ok ? 'ok' : 'err', c.ok ? 'ready' : 'unavailable');
            }
        } catch (err) {
            box.innerHTML = '';
            box.append(el('span', 'st-subs-tag-err', `Offline (${err instanceof Error ? err.message : err}). Is the server plugin running? Check the SillyTavern console for [subscriptions] lines.`));
        }
    }

    // ── Settings UI helpers ──

    function makeSelectRow(labelText, id, values, current, onChange, labels = {}) {
        const label = el('label', 'st-subs-label', labelText);
        label.htmlFor = id;
        const select = document.createElement('select');
        select.id = id;
        select.classList.add('text_pole');
        for (const v of values) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = labels[v] ?? v;
            if (v === current) opt.selected = true;
            select.append(opt);
        }
        select.addEventListener('change', () => onChange(select.value));
        return [label, select];
    }

    function makeCheckboxRow(labelText, id, checked, onChange) {
        const wrap = el('label', 'checkbox_label');
        wrap.htmlFor = id;
        const box = document.createElement('input');
        box.id = id;
        box.type = 'checkbox';
        box.checked = checked;
        box.addEventListener('change', () => onChange(box.checked));
        wrap.append(box, el('span', null, labelText));
        return wrap;
    }

    function makeHelp(text) {
        return el('small', 'st-subs-help', text);
    }

    function makeDrawer(parent, title, provider, open = false) {
        const drawer = el('div', 'inline-drawer st-subs-provider');
        const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
        toggle.append(el('b', null, title));
        const badge = el('span', 'st-subs-badge', '…');
        badge.id = `st_subs_badge_${provider}`;
        toggle.append(badge);
        const icon = el('div', `inline-drawer-icon fa-solid fa-circle-chevron-down ${open ? 'up' : 'down'}`);
        toggle.append(icon);
        const content = el('div', 'inline-drawer-content');
        if (open) content.style.display = 'block';
        drawer.append(toggle, content);
        parent.append(drawer);
        return content;
    }

    const BACKEND_LABELS = {
        auto: 'Auto (subscription first, API overflow when limits hit)',
        subscription: 'Subscription only (CLI login)',
        api: 'API key / LinkAPI only (pay per token)',
    };

    function addExtensionSettings(settings) {
        const container = document.getElementById('extensions_settings') ?? document.body;
        const drawer = el('div', 'inline-drawer');
        container.append(drawer);

        const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
        toggle.append(el('b', null, 'Subscriptions (Claude Max · Codex · Gemini)'));
        toggle.append(el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
        const content = el('div', 'inline-drawer-content');
        drawer.append(toggle, content);

        // Legacy panels still loaded?
        const legacy = [];
        if (window.__claudeMaxUiLoaded) legacy.push('Claude Max');
        if (window.__codexMaxUiLoaded) legacy.push('Codex Max');
        if (window.__geminiAntigravityUiLoaded) legacy.push('Gemini Antigravity');
        if (legacy.length) {
            content.append(el('div', 'st-subs-notice', `Old panel(s) still installed: ${legacy.join(', ')}. This panel replaces them — remove their extensions (Extensions → Manage) to avoid duplicate settings.`));
        }

        // Connect + scope
        const connectBtn = el('div', 'menu_button st-subs-connect', 'Connect');
        connectBtn.addEventListener('click', () => connect(getSettings()));
        content.append(connectBtn);

        const [scopeLabel, scopeSelect] = makeSelectRow('Connect to', 'stSubsScope', SCOPES, settings.scope, (v) => {
            settings.scope = SCOPES.includes(v) ? v : 'all';
            saveSettingsDebounced();
            endpointPreview.textContent = `Endpoint: ${endpointFor(settings)}`;
        }, { all: 'All subscriptions (one model list)', claude: 'Claude only', codex: 'Codex / ChatGPT only', gemini: 'Gemini / Antigravity only' });
        content.append(scopeLabel, scopeSelect);
        const endpointPreview = makeHelp(`Endpoint: ${endpointFor(settings)}`);
        content.append(endpointPreview);
        content.append(makeHelp(
            'One click does the whole setup: switches the API to Chat Completion → Custom (OpenAI-compatible), fills in the ' +
            'endpoint and connects. Then pick any model from the normal model dropdown — claude-* goes to your Claude ' +
            'subscription, gpt-* to ChatGPT/Codex, gemini-* to Antigravity. "All subscriptions" lists every provider that is ' +
            'usable on this machine; pick a single provider if you prefer a shorter list.',
        ));

        const endpointLabel = el('label', 'st-subs-label', 'Listener base URL (advanced)');
        const endpointInput = document.createElement('input');
        endpointInput.type = 'text';
        endpointInput.classList.add('text_pole');
        endpointInput.value = settings.endpointBase;
        endpointInput.addEventListener('input', () => {
            settings.endpointBase = normalizeUrl(endpointInput.value).replace(/\/(claude|codex|gemini)?\/?v1$/i, '') || DEFAULT_BASE;
            saveSettingsDebounced();
            endpointPreview.textContent = `Endpoint: ${endpointFor(settings)}`;
        });
        content.append(endpointLabel, endpointInput);
        content.append(makeHelp('Only change this if you set ST_SUBSCRIPTIONS_PORT / _HOST. Enter just the origin (http://host:port); /v1 or /claude/v1 is added automatically.'));

        content.append(makeCheckboxRow('Enabled (inject these settings into requests to the proxy)', 'stSubsEnabled', settings.enabled, (v) => { settings.enabled = v; saveSettingsDebounced(); }));
        content.append(makeCheckboxRow('Show reasoning (collapsible thinking box, all providers)', 'stSubsShowReasoning', settings.showReasoning, (v) => { settings.showReasoning = v; saveSettingsDebounced(); }));
        content.append(makeHelp(
            'Display toggle only — it does not change whether a model thinks. ON: thinking summaries stream into SillyTavern\'s ' +
            'collapsible "thoughts" box (also enable "Show model thoughts" in ST\'s user settings). Claude and Codex stream ' +
            'summaries; Antigravity\'s CLI never exposes Gemini\'s thoughts.',
        ));

        // ── Claude ──
        const claude = makeDrawer(content, 'Claude — Anthropic Pro/Max', 'claude');
        {
            const [l, s] = makeSelectRow('Backend', 'stSubsClaudeBackend', BACKENDS, settings.claude.backend, (v) => { settings.claude.backend = BACKENDS.includes(v) ? v : 'auto'; saveSettingsDebounced(); }, BACKEND_LABELS);
            claude.append(l, s);
            claude.append(makeHelp('Subscription = the `claude login` on the SillyTavern host. API = ANTHROPIC key or your LinkAPI relay key (from the Custom API key field, LINKAPI_CLAUDE_API_KEY, or ~/.claude/settings.json). Auto uses the subscription and switches to the API key for a request when the 5-hour/weekly window is exhausted.'));
            const [el2, es] = makeSelectRow('Reasoning effort', 'stSubsClaudeEffort', CLAUDE_EFFORTS, settings.claude.effort, (v) => { settings.claude.effort = CLAUDE_EFFORTS.includes(v) ? v : 'auto'; saveSettingsDebounced(); }, { auto: 'Auto (model default)', xhigh: 'xhigh (deeper)', max: 'max (deepest)' });
            claude.append(el2, es);
            claude.append(makeHelp('How hard Claude reasons before replying — low is fastest, max thinks longest. Higher = better consistency on complex scenes, slower replies, more quota.'));
            const [tl, ts] = makeSelectRow('Thinking mode', 'stSubsClaudeThinking', CLAUDE_THINKING, settings.claude.thinking, (v) => { settings.claude.thinking = CLAUDE_THINKING.includes(v) ? v : 'adaptive'; saveSettingsDebounced(); }, { adaptive: 'Adaptive (model decides — recommended)', on: 'Always on', off: 'Off (ignored by always-thinking models)' });
            claude.append(tl, ts);
            claude.append(makeHelp('Fable and Opus 4.7+ always think (this cannot disable it there); on other models thinking is auto-disabled when Max response length is under 2048 tokens.'));
            claude.append(makeCheckboxRow('Session resume (real multi-turn context + prompt caching)', 'stSubsClaudeResume', settings.claude.useResume, (v) => { settings.claude.useResume = v; saveSettingsDebounced(); }));
            claude.append(makeHelp('ON (recommended): the chat is replayed as a genuine multi-turn Claude session — better who-said-what tracking and working prompt caching. OFF flattens the chat into one text block (troubleshooting only).'));
            claude.append(makeCheckboxRow('Identity mode (Claude Code preamble)', 'stSubsClaudeIdentity', settings.claude.identityMode, (v) => { settings.claude.identityMode = v; saveSettingsDebounced(); }));
            claude.append(makeHelp('OFF (recommended): your character card is the entire system prompt. ON: prepends Anthropic\'s Claude Code preamble so the model knows which Claude it is, at the cost of tokens and a coding flavour.'));
            claude.append(makeCheckboxRow('Fast mode (/fast — where your plan allows it)', 'stSubsClaudeFast', settings.claude.fastMode, (v) => { settings.claude.fastMode = v; saveSettingsDebounced(); }));
            claude.append(makeHelp('Requests high-speed generation. The CLI decides whether your plan/model allows it; the server log shows the effective state.'));
        }

        // ── Codex ──
        const codex = makeDrawer(content, 'Codex — ChatGPT Plus/Pro', 'codex');
        {
            const [l, s] = makeSelectRow('Backend', 'stSubsCodexBackend', BACKENDS, settings.codex.backend, (v) => { settings.codex.backend = BACKENDS.includes(v) ? v : 'auto'; saveSettingsDebounced(); }, { auto: 'Auto (follow the Codex CLI config — respects your LinkAPI toggle)', subscription: 'Subscription only (ChatGPT login, provider openai)', api: 'API key / LinkAPI only (pay per token)' });
            codex.append(l, s);
            codex.append(makeHelp('Runs through the Codex CLI\'s app-server with a clean system prompt (no coding preamble, no MCP servers, no tools). Subscription needs `codex login` on the SillyTavern host. API uses LINKAPI_CODEX_API_KEY / OPENAI_API_KEY (or the Custom API key field) directly.'));
            const [el2, es] = makeSelectRow('Reasoning effort', 'stSubsCodexEffort', CODEX_EFFORTS, settings.codex.effort, (v) => { settings.codex.effort = CODEX_EFFORTS.includes(v) ? v : 'auto'; saveSettingsDebounced(); }, { auto: 'Auto (model default)', ultra: 'ultra (GPT-6 Astra)' });
            codex.append(el2, es);
            codex.append(makeHelp('Clamped to what the chosen model supports (the model list is read live from your account).'));
            const [stl, sts] = makeSelectRow('Service tier', 'stSubsCodexTier', CODEX_TIERS, settings.codex.serviceTier, (v) => { settings.codex.serviceTier = CODEX_TIERS.includes(v) ? v : 'standard'; saveSettingsDebounced(); }, { standard: 'Standard', priority: 'Fast (priority — 2× speed, more usage)', ultrafast: 'Ultrafast (where offered)' });
            codex.append(stl, sts);
            const [rl, rs] = makeSelectRow('Reasoning summary', 'stSubsCodexSummary', CODEX_SUMMARIES, settings.codex.reasoningSummary, (v) => { settings.codex.reasoningSummary = CODEX_SUMMARIES.includes(v) ? v : 'auto'; saveSettingsDebounced(); }, { auto: 'Auto', concise: 'Concise', detailed: 'Detailed', none: 'None' });
            codex.append(rl, rs);
            codex.append(makeHelp('How much of the model\'s reasoning is summarised into the thoughts box.'));
        }

        // ── Gemini ──
        const gemini = makeDrawer(content, 'Gemini — Google Antigravity', 'gemini');
        {
            const [l, s] = makeSelectRow('Backend', 'stSubsGeminiBackend', BACKENDS, settings.gemini.backend, (v) => { settings.gemini.backend = BACKENDS.includes(v) ? v : 'auto'; saveSettingsDebounced(); }, { auto: 'Auto (agy when installed, else API key)', subscription: 'Antigravity CLI only (agy sign-in / its own toggle)', api: 'API key / LinkAPI only (pay per token)' });
            gemini.append(l, s);
            gemini.append(makeHelp('The agy CLI bills whatever it is signed in to (your Google account, or LinkAPI when its overflow toggle is ON). API sends the chat straight to GOOGLE_GEMINI_BASE_URL with GEMINI_API_KEY / LINKAPI_ANTIGRAVITY_API_KEY.'));
            const [el2, es] = makeSelectRow('Reasoning effort', 'stSubsGeminiEffort', GEMINI_EFFORTS, settings.gemini.effort, (v) => { settings.gemini.effort = GEMINI_EFFORTS.includes(v) ? v : 'auto'; saveSettingsDebounced(); }, { auto: 'Auto (from the model name, e.g. …-high)', low: 'Low (fastest)', medium: 'Medium', high: 'High (deepest)' });
            gemini.append(el2, es);
            gemini.append(makeHelp('Antigravity encodes effort in the model id (gemini-3.8-flash-high). Setting it here overrides that suffix.'));
        }

        // ── Status & quota ──
        const statusHeader = el('div', 'st-subs-status-header');
        statusHeader.append(el('b', null, 'Status & quota'));
        const statusRefresh = el('div', 'menu_button fa-solid fa-rotate st-subs-status-refresh');
        statusRefresh.title = 'Refresh status';
        statusRefresh.addEventListener('click', refreshStatus);
        statusHeader.append(statusRefresh);
        const statusBox = el('div', 'st-subs-status-box', 'Press refresh to check the three subscriptions.');
        statusBox.id = 'st_subs_status';
        content.append(statusHeader, statusBox);

        content.append(el('small', 'st-subs-hint',
            'Leave SillyTavern\'s native "Reasoning Effort" dropdown on Auto — the per-provider effort above replaces it. ' +
            'Temperature/Top-P only apply on the API backends (the CLIs expose no sampling controls).'));
    }

    // ── Boot ──
    const settings = getSettings();
    addExtensionSettings(settings);
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    console.log('[subscriptions] UI extension loaded');
})();
