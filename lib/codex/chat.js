// ──────────────────────────────────────────────
// Codex provider — chat runner
// ──────────────────────────────────────────────
//
// backend = subscription → app-server, modelProvider forced to "openai", and
//                          only when the app-server reports a ChatGPT account
//                          (`account/read`) — an API-key login is refused,
//                          never billed.
// backend = api          → direct OpenAI-compatible HTTP with an API key when
//                          one is available (clean messages[], no CLI needed);
//                          otherwise the app-server with the non-OpenAI model
//                          provider from config.toml (a relay you configured).
// backend = auto         → app-server exactly as the CLI is configured (so any
//                          provider switch you made in the CLI is honoured);
//                          direct HTTP when no CLI exists, or when the CLI has
//                          no login at all, and a key does.
//
// Every app-server turn runs on an ephemeral, tool-less thread. Things that
// would change who or what answers are hard errors, never retried: a safety
// refusal (cyberPolicy / misalignmentPolicyViolation), a model reroute, a
// served model other than the requested one, an attempted tool call, and
// global instruction files (AGENTS.md in CODEX_HOME) Codex would inject.

import { readFileSync } from 'node:fs';
import { getAppServer, codexLaunchSpec } from './app-server.js';
import { readCodexConfig, overflowProviderOf, readCodexAuthSummary, resolveCodexHome } from './config.js';
import { resolveCodexEffort, codexModelInfo, listCodexModels } from './models.js';
import { runOpenAiCompat } from '../common/openai-compat.js';
import { splitConversation, foldConversation, imagePartsOf, TEXT_ONLY_PREAMBLE } from '../common/messages.js';
import { toOpenAiUsage } from '../common/sse.js';
import { bearerFromRequest } from '../claude/env.js';
import { isForeignKey } from '../common/keys.js';
import { runtimeDir } from '../common/runtime.js';
import { onAbort } from '../common/abort.js';

const TAG = '[subscriptions/codex]';
/** Silence allowed before the first reply text (long high-effort reasoning with no summary is silent). */
const IDLE_BEFORE_OUTPUT_MS = 10 * 60 * 1000;
/** Silence allowed between deltas once the reply is streaming. */
const IDLE_MS = 120000;
const DEADLINE_MS = 15 * 60 * 1000;
/** How long to wait for turn/completed after asking for an interrupt. */
const INTERRUPT_GRACE_MS = 3000;
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const VERBOSITIES = ['low', 'medium', 'high'];

/** Thread items that mean the model used a tool — never allowed in roleplay. */
const TOOL_ITEM_TYPES = new Set([
    'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
    'imageView', 'imageGeneration', 'collabAgentToolCall', 'subAgentActivity',
]);
/** codexErrorInfo values that are safety refusals. */
const REFUSAL_CODES = new Set(['cyberPolicy', 'misalignmentPolicyViolation']);

/** Direct-API credentials, if any (never spent here). */
export function discoverCodexApiCredentials(req) {
    const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim().length > 0)?.trim();
    const header = bearerFromRequest(req);
    // A key that is clearly another vendor's (the field is shared) is ignored.
    const candidates = [
        ['api-key-field', isForeignKey('codex', header) ? undefined : header],
        ['ST_SUBSCRIPTIONS_CODEX_API_KEY', process.env.ST_SUBSCRIPTIONS_CODEX_API_KEY],
        ['OPENAI_API_KEY', process.env.OPENAI_API_KEY],
    ].map(([source, v]) => [source, typeof v === 'string' ? v.trim() : '']);
    const hit = candidates.find(([, v]) => v);
    if (!hit) return null;
    const [source, key] = hit;
    // Explicit plugin base URL, then OPENAI_BASE_URL (any OpenAI-compatible relay), else OpenAI.
    const baseUrl = pick(process.env.ST_SUBSCRIPTIONS_CODEX_BASE_URL, process.env.OPENAI_BASE_URL) || OPENAI_DEFAULT_BASE;
    return { key, baseUrl, source };
}

function defaultBaseInstructions() {
    return 'You are a conversational partner in a chat application. Follow the conversation and reply in character. ' + TEXT_ONLY_PREAMBLE;
}

function buildTurnInput(messages) {
    const { currentMessage } = splitConversation(messages);
    const text = foldConversation(messages, { includeSystem: false });
    const input = [{ type: 'text', text }];
    // Images on the final user turn ride along as image inputs (data URLs).
    for (const img of imagePartsOf(currentMessage?.content)) input.push({ type: 'image', url: img.url });
    return input;
}

/** Validated text verbosity ('low' | 'medium' | 'high'), or undefined when the client sent none. */
export function codexVerbosity(settings) {
    const v = settings?.codex?.verbosity;
    return VERBOSITIES.includes(v) ? v : undefined;
}

/**
 * Codex TokenUsageBreakdown → OpenAI usage. `inputTokens` already includes
 * cached reads and cache writes (like Responses `input_tokens`), so both are
 * taken out of the uncached part before toOpenAiUsage() adds them back.
 * `last` (the final model request) is the prompt size of this reply.
 */
export function codexUsage(tokenUsage) {
    const u = tokenUsage?.last ?? tokenUsage?.total;
    if (!u) return null;
    const cacheRead = u.cachedInputTokens ?? 0;
    const cacheCreate = u.cacheWriteInputTokens ?? 0;
    return toOpenAiUsage({
        input: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheCreate),
        output: u.outputTokens ?? 0,
        cacheRead,
        cacheCreate,
        reasoning: u.reasoningOutputTokens ?? 0,
    });
}

/**
 * Codex TurnError → Error with an HTTP status. Safety refusals are flagged
 * `refusal` + `noRetry`: they end the turn and are never retried or re-routed.
 */
export function codexTurnError(error) {
    const info = error?.codexErrorInfo;
    const code = typeof info === 'string' ? info : (info && typeof info === 'object' ? Object.keys(info)[0] ?? null : null);
    const base = String(error?.message ?? 'Codex error');
    const details = typeof error?.additionalDetails === 'string' && error.additionalDetails.trim() ? ` (${error.additionalDetails.trim()})` : '';
    if (REFUSAL_CODES.has(code)) {
        return Object.assign(new Error(`Codex refused this request (${code}): ${base}${details} — it was NOT retried or moved to another model.`), {
            httpStatus: 422, refusal: true, noRetry: true, codexErrorCode: code,
        });
    }
    const status = {
        usageLimitExceeded: 429, rateLimitExceeded: 429, sessionBudgetExceeded: 429,
        unauthorized: 401, contextWindowExceeded: 400, badRequest: 400,
    }[code] ?? 502;
    let hint = '';
    if (code === 'usageLimitExceeded') hint = ' — your ChatGPT plan\'s Codex usage window is used up; wait for the reset.';
    else if (code === 'unauthorized') hint = ' — run `codex login` on the SillyTavern host as the same user.';
    return Object.assign(new Error(`${base}${details}${hint}`), { httpStatus: status, codexErrorCode: code });
}

function errorType(err) {
    return err?.httpStatus && err.httpStatus < 500 ? 'invalid_request_error' : 'server_error';
}

function subscriptionLoginError(type, home) {
    let message;
    if (type === 'apiKey' || type === 'apikey') {
        message = 'Codex is signed in with an API key, which bills per token — the "subscription" backend never uses a key. ' +
            'Run `codex login` with your ChatGPT account (on the SillyTavern host, as the same user), or choose the "api" backend explicitly.';
    } else if (type) {
        message = `Codex is signed in with a ${type} account, not a ChatGPT account — the "subscription" backend only uses a ChatGPT plan. ` +
            'Run `codex login` with your ChatGPT account, or choose the "api" backend explicitly.';
    } else {
        message = `Codex is not signed in with a ChatGPT account${home ? ` (Codex home ${home})` : ''}. Run \`codex login\` on the SillyTavern host as the same user, ` +
            'or point ST_SUBSCRIPTIONS_CODEX_HOME at a Codex home that is logged in.';
    }
    return Object.assign(new Error(message), { httpStatus: 400 });
}

/**
 * The account the app-server authenticates with: { type, planType, email } or
 * { type: null } when signed out; null when account/read is unavailable.
 */
async function readAccount(server) {
    let res;
    try {
        res = await server.request('account/read', { refreshToken: false }, { timeoutMs: 15000 });
    } catch (err) {
        console.warn(`${TAG} account/read unavailable: ${err instanceof Error ? err.message : err}`);
        return null;
    }
    const a = res?.account ?? null;
    server.lastAccount = { type: a?.type ?? null, planType: a?.planType ?? null, email: a?.email ?? null, at: Date.now() };
    return server.lastAccount;
}

/**
 * Subscription gate: the app-server must be signed in with a ChatGPT account.
 * An API-key login (or any other account type) is refused, never billed.
 * Falls back to auth.json in the app-server's real home when account/read
 * is unavailable (older CLIs) — and then requires auth_mode "chatgpt".
 */
export async function assertChatgptLogin(server) {
    const account = await readAccount(server);
    if (account) {
        if (account.type === 'chatgpt') return account;
        throw subscriptionLoginError(account.type, server.codexHome);
    }
    const auth = readCodexAuthSummary(server.codexHome ?? resolveCodexHome());
    if (auth.present && auth.mode === 'chatgpt') return { type: 'chatgpt', source: 'auth.json' };
    throw subscriptionLoginError(auth.present ? auth.mode : null, server.codexHome);
}

const OPENAI_HOSTS = new Set(['api.openai.com', 'chatgpt.com', 'chat.openai.com', 'chatgpt.openai.com']);

/**
 * Subscription gate, part two: Codex sends ChatGPT-login traffic to
 * openai_base_url / chatgpt_base_url from config.toml when set. On a
 * non-OpenAI host that would hand the ChatGPT token, the account id and the
 * chat to a relay — refused on "Subscription only".
 */
export function assertOpenAiEndpoints(effectiveConfig, codexHome) {
    for (const key of ['openai_base_url', 'chatgpt_base_url']) {
        const value = effectiveConfig?.[key];
        if (typeof value !== 'string' || !value.trim()) continue;
        let host = null;
        try { host = new URL(value.trim()).hostname.toLowerCase(); } catch { /* unparsable: refuse below */ }
        if (host && OPENAI_HOSTS.has(host)) continue;
        throw Object.assign(new Error(
            `"Subscription only" will not send your ChatGPT login to ${host ?? value} (${key} in ${codexHome ?? 'the Codex home'}/config.toml). ` +
            'Remove that setting, point ST_SUBSCRIPTIONS_CODEX_HOME at a Codex home without it, or switch the Codex backend to Auto/API.',
        ), { httpStatus: 400, noRetry: true });
    }
}

function instructionSourcesError(sources) {
    return Object.assign(new Error(
        `Codex would add ${sources.join(', ')} (its global agent instructions) to every roleplay prompt, so this chat was refused. ` +
        'Give SillyTavern a dedicated Codex home: set ST_SUBSCRIPTIONS_CODEX_HOME to an empty folder and log in there once ' +
        '(`CODEX_HOME=<that folder> codex login`; PowerShell: `$env:CODEX_HOME="<that folder>"; codex login`), or empty/rename that file.',
    ), { httpStatus: 400 });
}

/**
 * Run one turn on an already-started app-server.
 * @param {object} args
 * @param {import('./app-server.js').CodexAppServer} args.server
 * @param {object[]} args.messages
 * @param {string} args.model
 * @param {object} args.settings
 * @param {import('../common/completion.js').CompletionWriter} args.writer
 * @param {string|null} args.modelProvider
 * @param {AbortSignal} [args.signal]
 * @param {object} [args.timing] test hook: { idleBeforeOutputMs, idleMs, deadlineMs, interruptGraceMs }
 */
export async function runAppServerTurn({ server, messages, model, settings, writer, modelProvider, signal, timing = {} }) {
    const idleBeforeOutputMs = timing.idleBeforeOutputMs ?? IDLE_BEFORE_OUTPUT_MS;
    const idleMs = timing.idleMs ?? IDLE_MS;
    const deadlineMs = timing.deadlineMs ?? DEADLINE_MS;
    const interruptGraceMs = timing.interruptGraceMs ?? INTERRUPT_GRACE_MS;

    const { system } = splitConversation(messages);
    const baseInstructions = (system ? `${system}\n\n${TEXT_ONLY_PREAMBLE}` : defaultBaseInstructions());
    const info = codexModelInfo(model);
    let effort = resolveCodexEffort(model, settings.codex.effort);
    if (!effort) {
        // No effort chosen: Codex would fall back to config.toml's
        // model_reasoning_effort or the model default — 'ultra' there switches
        // on multi-agent delegation, so its plain equivalent is sent instead.
        const configured = server.codexHome ? readCodexConfig(server.codexHome).top.model_reasoning_effort : undefined;
        if (configured === 'ultra' || info.defaultEffort === 'ultra') effort = resolveCodexEffort(model, 'ultra');
    }
    const summary = settings.showReasoning ? (settings.codex.reasoningSummary === 'none' ? 'none' : settings.codex.reasoningSummary) : 'none';
    const serviceTier = settings.codex.serviceTier && settings.codex.serviceTier !== 'standard' && info.tiers?.includes(settings.codex.serviceTier)
        ? settings.codex.serviceTier
        : undefined;
    // Codex's own default is the terse coding-tuned 'low'; roleplay gets 'medium' unless the client asked.
    const verbosity = codexVerbosity(settings) ?? 'medium';

    const threadParams = {
        model,
        cwd: runtimeDir('codex-cwd'),
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions,
        personality: 'none',
        // Empty, not null: null falls back to config.toml's developer_instructions,
        // which would reach the model as a developer message.
        developerInstructions: '',
        config: { model_verbosity: verbosity },
    };
    if (modelProvider) threadParams.modelProvider = modelProvider;

    if (signal?.aborted) return;
    // A replacement app-server may still be starting (not yet verified): never
    // hand it a turn — no await between this check and the request.
    if (!server.ready) throw Object.assign(new Error('The Codex app-server is restarting — try again in a moment.'), { httpStatus: 503 });
    const started = await server.request('thread/start', threadParams, { timeoutMs: 60000 });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error('Codex app-server did not return a thread id');
    // Ephemeral threads cannot be deleted; unsubscribing lets the server unload them.
    const release = () => { server.request('thread/unsubscribe', { threadId }, { timeoutMs: 5000 }).catch(() => {}); };

    // An empty or whitespace-only AGENTS.md injects nothing — only files with
    // content block the chat (an unreadable one counts as content: fail closed).
    const sources = (Array.isArray(started.instructionSources) ? started.instructionSources.filter(Boolean) : [])
        .filter((p) => { try { return readFileSync(String(p), 'utf8').trim().length > 0; } catch { return true; } });
    server.lastInstructionSources = sources;
    if (sources.length) {
        release();
        throw instructionSourcesError(sources);
    }
    if (started.model && String(started.model).toLowerCase() !== String(model).toLowerCase()) {
        release();
        throw Object.assign(new Error(`Codex would serve ${started.model} instead of the requested ${model}; the plugin never substitutes models, so the chat was refused. Pick ${started.model} yourself if you want it.`), { httpStatus: 422, noRetry: true });
    }
    if (signal?.aborted) { release(); return; }
    console.log(`${TAG} ${model} via app-server (provider ${started.modelProvider ?? started.thread?.modelProvider ?? modelProvider ?? 'config'}, effort ${effort ?? 'default'}, summary ${summary}, verbosity ${verbosity})`);

    let turnId = null;
    let usage = null;
    let lastError = null;
    let done = false;
    let aborted = false;
    let sawText = false;
    let interruptWanted = false;
    let interruptSent = false;
    const phases = new Map(); // agentMessage item id → 'commentary' | 'final_answer' | null
    const streamedItems = new Set(); // items that delivered deltas (undefined = a CLI without itemId)
    let lastVisibleItem = null;
    let resolveDone;
    const finished = new Promise((r) => { resolveDone = r; });
    const finish = () => { if (!done) { done = true; resolveDone(); } };

    const sendInterrupt = () => {
        if (interruptSent || !turnId) return;
        interruptSent = true;
        server.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }).catch(() => {});
    };
    // An interrupt asked for before turn/start answered is remembered and sent
    // as soon as the turn id is known (turn/started or the turn/start reply).
    const interrupt = () => {
        if (done) return;
        if (!interruptWanted) {
            interruptWanted = true;
            // If the server never reports completion after an interrupt, finish anyway.
            const t = setTimeout(finish, interruptGraceMs);
            t.unref?.();
        }
        sendInterrupt();
    };
    const fail = (err) => { lastError = lastError ?? err; interrupt(); };

    let idleTimer = null;
    const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        const ms = sawText ? idleMs : idleBeforeOutputMs;
        idleTimer = setTimeout(() => fail(Object.assign(new Error(sawText
            ? `Codex stopped streaming for ${Math.round(ms / 1000)}s in the middle of the reply`
            : `Codex produced no reply within ${Math.round(ms / 1000)}s`), { httpStatus: 504 })), ms);
        idleTimer.unref?.();
    };
    const deadline = setTimeout(() => fail(Object.assign(new Error(`Codex turn exceeded the ${Math.round(deadlineMs / 60000)} minute deadline`), { httpStatus: 504 })), deadlineMs);
    deadline.unref?.();

    /** Visible reply text; a new message item is separated from the previous one. */
    const pushVisible = (itemId, text) => {
        sawText = true;
        const key = itemId ?? null;
        const sep = lastVisibleItem !== null && key !== null && key !== lastVisibleItem ? '\n\n' : '';
        if (key !== null) lastVisibleItem = key;
        if (writer.pushText(sep + text)) interrupt();
    };

    // Client gone: interrupt upstream and stop at once — nothing more is written.
    // (An interrupt asked for before turn/start answered is still sent below.)
    const offAbort = onAbort(signal, () => { aborted = true; interrupt(); finish(); });

    const unsubscribe = server.subscribeThread(threadId, (msg) => {
        if (done) return;
        const p = msg.params ?? {};
        switch (msg.method) {
            case 'turn/started':
                if (!turnId && p.turn?.id) {
                    turnId = p.turn.id;
                    if (interruptWanted) sendInterrupt();
                }
                break;
            case 'item/started': {
                const item = p.item ?? {};
                if (TOOL_ITEM_TYPES.has(item.type)) {
                    // Defence in depth: the tools are switched off, so this should never happen.
                    fail(Object.assign(new Error(`Codex tried to use a tool (${item.type}) in a roleplay chat; the reply was stopped. Tools are disabled for roleplay.`), { httpStatus: 502, noRetry: true }));
                } else if (item.type === 'agentMessage' && item.id) {
                    phases.set(item.id, item.phase ?? null);
                }
                break;
            }
            case 'item/agentMessage/delta':
                if (!p.delta) break;
                streamedItems.add(p.itemId);
                // Interim "commentary" is narration, not the reply — it goes to the thoughts box.
                if (phases.get(p.itemId) === 'commentary') writer.pushReasoning(p.delta);
                else pushVisible(p.itemId, p.delta);
                break;
            case 'item/reasoning/summaryTextDelta':
            case 'item/reasoning/textDelta':
                writer.pushReasoning(p.delta);
                break;
            case 'item/reasoning/summaryPartAdded':
                if (writer.reasoning) writer.pushReasoning('\n\n');
                break;
            case 'item/completed': {
                const item = p.item ?? {};
                if (item.type === 'agentMessage' && item.text && !streamedItems.has(item.id) && !streamedItems.has(undefined)) {
                    const phase = item.phase ?? phases.get(item.id) ?? null;
                    if (phase === 'commentary') writer.pushReasoning(item.text);
                    else pushVisible(item.id ?? null, item.text);
                }
                if (item.type === 'reasoning' && !writer.reasoning && Array.isArray(item.summary) && item.summary.length) {
                    writer.pushReasoning(item.summary.join('\n\n'), { isDelta: false });
                }
                break;
            }
            case 'thread/tokenUsage/updated':
                usage = codexUsage(p.tokenUsage) ?? usage;
                break;
            case 'error': {
                const err = codexTurnError(p.error);
                if (err.refusal) fail(err); // final even if Codex would retry it
                else if (p.willRetry) console.warn(`${TAG} transient: ${p.error?.message}`);
                else lastError = lastError ?? err;
                break;
            }
            case 'model/rerouted':
                fail(Object.assign(new Error(
                    `Codex rerouted this reply from ${p.fromModel} to ${p.toModel} (${p.reason}). The plugin never serves a substituted model, ` +
                    'so the reply was stopped — pick another model yourself if you want to continue.',
                ), { httpStatus: 422, refusal: true, noRetry: true }));
                break;
            case 'turn/completed': {
                const turn = p.turn ?? {};
                if (turn.status === 'failed' || turn.error) lastError = lastError ?? (turn.error ? codexTurnError(turn.error) : Object.assign(new Error('Codex turn failed'), { httpStatus: 502 }));
                finish();
                break;
            }
            case 'st/exit':
                lastError = lastError ?? Object.assign(new Error(p.error?.message ?? 'Codex app-server exited mid-turn'), { httpStatus: 502 });
                finish();
                break;
            default:
                break;
        }
        if (!done) armIdle();
    });

    try {
        armIdle();
        const turnParams = { threadId, input: buildTurnInput(messages) };
        if (effort) turnParams.effort = effort;
        turnParams.summary = summary;
        if (serviceTier) turnParams.serviceTier = serviceTier;
        if (!server.ready) throw Object.assign(new Error('The Codex app-server is restarting — try again in a moment.'), { httpStatus: 503 });
        const turn = await server.request('turn/start', turnParams, { timeoutMs: 60000 });
        if (!turnId && turn?.turn?.id) turnId = turn.turn.id;
        if (interruptWanted) sendInterrupt();
        await finished;
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(deadline);
        unsubscribe();
        offAbort();
        release();
    }

    if (aborted) return; // client gone — nothing more to write
    if (lastError) {
        if (!writer.didYieldContent) throw lastError;
        // Part of the reply already streamed: end with an error, never a normal 'stop'.
        console.warn(`${TAG} turn ended with error after partial output: ${lastError.message}`);
        writer.flushTail();
        writer.fail(lastError, { status: lastError.httpStatus ?? 502, type: errorType(lastError) });
        return;
    }
    writer.flushTail();
    writer.finish({ usage });
}

async function runViaDirectApi({ messages, model, settings, writer, creds, signal }) {
    const info = codexModelInfo(model);
    const extraBody = {};
    const effort = resolveCodexEffort(model, settings.codex.effort);
    if (effort) extraBody.reasoning_effort = effort;
    const verbosity = codexVerbosity(settings);
    if (verbosity) extraBody.verbosity = verbosity;
    if (settings.maxTokens) extraBody.max_completion_tokens = settings.maxTokens;
    if (settings.stops.length) extraBody.stop = settings.stops.slice(0, 4);
    if (signal?.aborted) return;
    console.log(`${TAG} ${model} via direct API (${creds.source}, ${creds.baseUrl}, effort ${effort ?? 'default'})`);
    await runOpenAiCompat({ baseUrl: creds.baseUrl, apiKey: creds.key, model: info.id, messages, extraBody, writer, signal, tag: TAG });
}

export async function runCodexChat({ req, messages, model, settings, writer, signal }) {
    const backend = settings.codex.backend;
    const cliAvailable = !!codexLaunchSpec();
    const creds = discoverCodexApiCredentials(req);

    try {
        if (signal?.aborted) return;
        // Warm the catalog so effort clamping has real data (cheap after first call).
        await listCodexModels({ live: cliAvailable }).catch(() => {});
        if (signal?.aborted) return;

        if (backend === 'api') {
            if (creds) return await runViaDirectApi({ messages, model, settings, writer, creds, signal });
            if (cliAvailable) {
                const server = await getAppServer();
                const prov = overflowProviderOf(readCodexConfig(server.codexHome));
                if (!prov) throw Object.assign(new Error('Codex backend "api" selected but no API key is set and config.toml defines no non-OpenAI model provider. Set OPENAI_API_KEY (+ OPENAI_BASE_URL for a compatible relay), or put the key in SillyTavern\'s Custom API key field.'), { httpStatus: 400 });
                return await runAppServerTurn({ server, messages, model, settings, writer, modelProvider: prov, signal });
            }
            throw Object.assign(new Error('Codex backend "api" needs an API key (none found) — set OPENAI_API_KEY (+ OPENAI_BASE_URL for a compatible relay), or paste the key into SillyTavern\'s Custom API key field.'), { httpStatus: 400 });
        }

        if (backend === 'subscription') {
            if (!cliAvailable) throw Object.assign(new Error('Codex CLI not found — install it with `npm i -g @openai/codex` and run `codex login` (or switch the Codex backend to "api").'), { httpStatus: 400 });
            const server = await getAppServer();
            await assertChatgptLogin(server);
            assertOpenAiEndpoints(server.effectiveConfig, server.codexHome);
            if (signal?.aborted) return;
            return await runAppServerTurn({ server, messages, model, settings, writer, modelProvider: 'openai', signal });
        }

        // auto
        if (cliAvailable) {
            const server = await getAppServer();
            const cfg = readCodexConfig(server.codexHome);
            const usesOverflow = cfg.modelProvider && cfg.modelProvider !== 'openai';
            if (!usesOverflow) {
                const account = await readAccount(server);
                const signedIn = account ? !!account.type : readCodexAuthSummary(server.codexHome).present;
                if (!signedIn) {
                    if (creds) return await runViaDirectApi({ messages, model, settings, writer, creds, signal });
                    throw Object.assign(new Error(`Codex CLI is installed but not logged in (Codex home ${server.codexHome}) and no API key is set. Run \`codex login\`, or set OPENAI_API_KEY.`), { httpStatus: 400 });
                }
            }
            if (signal?.aborted) return;
            return await runAppServerTurn({ server, messages, model, settings, writer, modelProvider: null, signal });
        }
        if (creds) return await runViaDirectApi({ messages, model, settings, writer, creds, signal });
        throw Object.assign(new Error('Neither the Codex CLI nor an API key is available. Install Codex (`npm i -g @openai/codex` + `codex login`) or set OPENAI_API_KEY.'), { httpStatus: 400 });
    } catch (err) {
        if (signal?.aborted) return; // client gone or plugin stopping — the listener ends the response
        console.error(`${TAG} request failed:`, err instanceof Error ? err.message : err);
        writer.fail(err, { status: err.httpStatus ?? 500, type: errorType(err) });
    }
}
