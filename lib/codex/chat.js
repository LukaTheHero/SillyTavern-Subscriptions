// ──────────────────────────────────────────────
// Codex provider — chat runner
// ──────────────────────────────────────────────
//
// backend = subscription → app-server, modelProvider forced to "openai"
//                          (ChatGPT login in CODEX_HOME/auth.json).
// backend = api          → direct OpenAI-compatible HTTP with an API/LinkAPI
//                          key when one is available (clean messages[], no CLI
//                          needed); otherwise the app-server with the overflow
//                          provider from config.toml.
// backend = auto         → app-server exactly as the CLI is configured (so
//                          the LinkAPI overflow toggle is honoured); direct
//                          HTTP when no CLI exists but a key does.

import { getAppServer } from './app-server.js';
import { codexLaunchSpec } from './app-server.js';
import { readCodexConfig, overflowProviderOf, readCodexAuthSummary } from './config.js';
import { clampEffort, codexModelInfo, listCodexModels } from './models.js';
import { runOpenAiCompat } from '../common/openai-compat.js';
import { splitConversation, foldConversation, imagePartsOf, TEXT_ONLY_PREAMBLE } from '../common/messages.js';
import { toOpenAiUsage } from '../common/sse.js';
import { bearerFromRequest } from '../claude/env.js';
import { runtimeDir } from '../common/runtime.js';

const TAG = '[subscriptions/codex]';
const IDLE_MS = 120000;
const DEADLINE_MS = 15 * 60 * 1000;
const LINKAPI_DEFAULT_BASE = 'https://api.linkapi.ai/v1';

/** Direct-API credentials, if any (never spent here). */
export function discoverCodexApiCredentials(req) {
    const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim().length > 0)?.trim();
    const fromHeader = bearerFromRequest(req);
    const key = pick(fromHeader, process.env.ST_SUBSCRIPTIONS_CODEX_API_KEY, process.env.LINKAPI_CODEX_API_KEY, process.env.OPENAI_API_KEY);
    if (!key) return null;
    let source = 'process-env';
    if (key === fromHeader) source = 'api-key-field';
    else if (key === process.env.ST_SUBSCRIPTIONS_CODEX_API_KEY) source = 'ST_SUBSCRIPTIONS_CODEX_API_KEY';
    else if (key === process.env.LINKAPI_CODEX_API_KEY) source = 'LINKAPI_CODEX_API_KEY';
    else if (key === process.env.OPENAI_API_KEY) source = 'OPENAI_API_KEY';
    let baseUrl = pick(process.env.ST_SUBSCRIPTIONS_CODEX_BASE_URL, process.env.OPENAI_BASE_URL);
    if (!baseUrl) {
        // A LinkAPI-style key without a base URL → the relay; a real OpenAI key → api.openai.com.
        baseUrl = source === 'OPENAI_API_KEY' && /^sk-(proj-|svcacct-)?[A-Za-z0-9]/.test(key) && !/^sk-[A-Za-z0-9]{40,}$/.test(key)
            ? 'https://api.openai.com/v1'
            : (source === 'OPENAI_API_KEY' ? 'https://api.openai.com/v1' : LINKAPI_DEFAULT_BASE);
    }
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

/**
 * Run one turn through the app-server.
 */
async function runViaAppServer({ req, messages, model, settings, writer, modelProvider }) {
    const server = await getAppServer();
    const { system } = splitConversation(messages);
    const baseInstructions = (system ? `${system}\n\n${TEXT_ONLY_PREAMBLE}` : defaultBaseInstructions());
    const info = codexModelInfo(model);
    const effort = clampEffort(model, settings.codex.effort ?? settings.reasoningEffort) ?? undefined;
    const summary = settings.showReasoning ? (settings.codex.reasoningSummary === 'none' ? 'none' : settings.codex.reasoningSummary) : 'none';
    const serviceTier = settings.codex.serviceTier && settings.codex.serviceTier !== 'standard' && info.tiers?.includes(settings.codex.serviceTier)
        ? settings.codex.serviceTier
        : undefined;

    const threadParams = {
        model,
        cwd: runtimeDir('codex-cwd'),
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions,
        personality: 'none',
    };
    if (modelProvider) threadParams.modelProvider = modelProvider;

    const started = await server.request('thread/start', threadParams, { timeoutMs: 60000 });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error('Codex app-server did not return a thread id');
    console.log(`${TAG} ${model} via app-server (provider ${started.thread.modelProvider ?? modelProvider ?? 'config'}, effort ${effort ?? 'default'}, summary ${summary})`);

    let turnId = null;
    let usage = null;
    let sawDeltas = false;
    let lastError = null;
    let done = false;
    let resolveDone;
    const finished = new Promise((r) => { resolveDone = r; });
    let idleTimer = null;
    const deadline = setTimeout(() => { lastError = lastError ?? new Error('Codex turn exceeded the 15 minute deadline'); interrupt(); }, DEADLINE_MS);
    deadline.unref?.();
    const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { lastError = lastError ?? new Error(`Codex app-server idle for ${IDLE_MS}ms`); interrupt(); }, IDLE_MS);
        idleTimer.unref?.();
    };
    let interrupted = false;
    const interrupt = () => {
        if (interrupted || done) return;
        interrupted = true;
        if (turnId) server.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }).catch(() => {});
        // If the server never reports completion after an interrupt, finish anyway.
        const t = setTimeout(() => { if (!done) { done = true; resolveDone(); } }, 3000);
        t.unref?.();
    };
    const onClientClose = () => { if (!done) interrupt(); };
    req.on('close', onClientClose);

    const unsubscribe = server.subscribeThread(threadId, (msg) => {
        if (done) return;
        armIdle();
        const p = msg.params ?? {};
        switch (msg.method) {
            case 'item/agentMessage/delta':
                sawDeltas = true;
                if (writer.pushText(p.delta)) interrupt();
                break;
            case 'item/reasoning/summaryTextDelta':
            case 'item/reasoning/textDelta':
                writer.pushReasoning(p.delta);
                break;
            case 'item/reasoning/summaryPartAdded':
                if (writer.reasoning) writer.pushReasoning('\n\n');
                break;
            case 'item/completed':
                if (p.item?.type === 'agentMessage' && !sawDeltas && p.item.text) writer.pushText(p.item.text);
                if (p.item?.type === 'reasoning' && !writer.reasoning && Array.isArray(p.item.summary) && p.item.summary.length) {
                    writer.pushReasoning(p.item.summary.join('\n\n'), { isDelta: false });
                }
                break;
            case 'thread/tokenUsage/updated': {
                const u = p.tokenUsage?.last ?? p.tokenUsage?.total;
                if (u) usage = toOpenAiUsage({ input: (u.inputTokens ?? 0) - (u.cachedInputTokens ?? 0), output: u.outputTokens ?? 0, cacheRead: u.cachedInputTokens ?? 0, cacheCreate: u.cacheWriteInputTokens ?? 0, reasoning: u.reasoningOutputTokens ?? 0 });
                break;
            }
            case 'error':
                if (p.willRetry) console.warn(`${TAG} transient: ${p.error?.message}`);
                else lastError = new Error(p.error?.message ?? 'Codex error');
                break;
            case 'model/rerouted':
                console.warn(`${TAG} model rerouted ${p.fromModel} → ${p.toModel} (${p.reason})`);
                break;
            case 'turn/completed': {
                const turn = p.turn ?? {};
                if (turn.status === 'failed' || turn.error) lastError = lastError ?? new Error(turn.error?.message ?? 'Codex turn failed');
                done = true;
                resolveDone();
                break;
            }
            case 'st/exit':
                lastError = p.error ?? new Error('Codex app-server exited mid-turn');
                done = true;
                resolveDone();
                break;
            default:
                break;
        }
    });

    try {
        armIdle();
        const turnParams = { threadId, input: buildTurnInput(messages) };
        if (effort) turnParams.effort = effort;
        turnParams.summary = summary;
        if (serviceTier) turnParams.serviceTier = serviceTier;
        const turn = await server.request('turn/start', turnParams, { timeoutMs: 60000 });
        turnId = turn?.turn?.id ?? null;
        await finished;
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(deadline);
        unsubscribe();
        req.off('close', onClientClose);
        server.request('thread/delete', { threadId }, { timeoutMs: 5000 }).catch(() => {});
    }

    if (lastError && !writer.didYieldContent) throw lastError;
    if (lastError) console.warn(`${TAG} turn ended with error after partial output: ${lastError.message}`);
    writer.flushTail();
    writer.finish({ usage });
}

async function runViaDirectApi({ messages, model, settings, writer, creds, signal }) {
    const info = codexModelInfo(model);
    const extraBody = {};
    const effort = clampEffort(model, settings.codex.effort ?? settings.reasoningEffort);
    if (effort) extraBody.reasoning_effort = effort;
    if (settings.maxTokens) extraBody.max_completion_tokens = settings.maxTokens;
    if (settings.stops.length) extraBody.stop = settings.stops.slice(0, 4);
    console.log(`${TAG} ${model} via direct API (${creds.source}, ${creds.baseUrl}, effort ${effort ?? 'default'})`);
    await runOpenAiCompat({ baseUrl: creds.baseUrl, apiKey: creds.key, model: info.id, messages, extraBody, writer, signal, tag: TAG });
}

export async function runCodexChat({ req, messages, model, settings, writer }) {
    const backend = settings.codex.backend;
    const cliAvailable = !!codexLaunchSpec();
    const creds = discoverCodexApiCredentials(req);
    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.on('close', onClose);

    try {
        // Warm the catalog so effort clamping has real data (cheap after first call).
        await listCodexModels({ live: cliAvailable }).catch(() => {});

        if (backend === 'api') {
            if (creds) return await runViaDirectApi({ messages, model, settings, writer, creds, signal: ac.signal });
            if (cliAvailable) {
                const cfg = readCodexConfig();
                const prov = overflowProviderOf(cfg);
                if (!prov) throw Object.assign(new Error('Codex backend "api" selected but no API/LinkAPI key is set and config.toml defines no non-OpenAI model provider. Set LINKAPI_CODEX_API_KEY / OPENAI_API_KEY (or put the key in SillyTavern\'s Custom API key field).'), { httpStatus: 400 });
                return await runViaAppServer({ req, messages, model, settings, writer, modelProvider: prov });
            }
            throw Object.assign(new Error('Codex backend "api" needs an API/LinkAPI key (none found) — set LINKAPI_CODEX_API_KEY or OPENAI_API_KEY, or paste the key into SillyTavern\'s Custom API key field.'), { httpStatus: 400 });
        }

        if (backend === 'subscription') {
            if (!cliAvailable) throw Object.assign(new Error('Codex CLI not found — install it with `npm i -g @openai/codex` and run `codex login` (or switch the Codex backend to "api").'), { httpStatus: 400 });
            const auth = readCodexAuthSummary();
            if (!auth.present) {
                throw Object.assign(new Error(`No ChatGPT login for the Codex CLI (no auth.json in ${auth.path.replace(/[\\/]auth\.json$/, '')}). Run \`codex login\` on the SillyTavern host as the same user, or point ST_SUBSCRIPTIONS_CODEX_HOME at a Codex home that is logged in.`), { httpStatus: 400 });
            }
            return await runViaAppServer({ req, messages, model, settings, writer, modelProvider: 'openai' });
        }

        // auto
        if (cliAvailable) {
            const auth = readCodexAuthSummary();
            const cfg = readCodexConfig();
            const usesOverflow = cfg.modelProvider && cfg.modelProvider !== 'openai';
            if (!auth.present && !usesOverflow) {
                if (creds) return await runViaDirectApi({ messages, model, settings, writer, creds, signal: ac.signal });
                throw Object.assign(new Error(`Codex CLI is installed but not logged in (no auth.json in ${auth.path.replace(/[\\/]auth\.json$/, '')}) and no API key is set. Run \`codex login\`, or set LINKAPI_CODEX_API_KEY / OPENAI_API_KEY.`), { httpStatus: 400 });
            }
            return await runViaAppServer({ req, messages, model, settings, writer, modelProvider: null });
        }
        if (creds) return await runViaDirectApi({ messages, model, settings, writer, creds, signal: ac.signal });
        throw Object.assign(new Error('Neither the Codex CLI nor an API key is available. Install Codex (`npm i -g @openai/codex` + `codex login`) or set LINKAPI_CODEX_API_KEY / OPENAI_API_KEY.'), { httpStatus: 400 });
    } catch (err) {
        console.error(`${TAG} request failed:`, err instanceof Error ? err.message : err);
        writer.fail(err, { status: err.httpStatus ?? 500, type: err.httpStatus ? 'invalid_request_error' : 'server_error' });
    } finally {
        req.off('close', onClose);
    }
}
