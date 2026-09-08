// ──────────────────────────────────────────────
// Claude provider — chat orchestrator (Agent SDK)
// ──────────────────────────────────────────────
//
// Pipeline per request:
//   1. Parse model ([1m] variants → tier alias + env pin) and settings.
//   2. System messages → SDK systemPrompt (plain client string = the roleplay
//      path; optional claude_code-preset "identity mode").
//   3. Prior turns → synthetic Claude Code JSONL session replayed through a
//      one-shot SessionStore + `resume`, so the model sees REAL multi-turn
//      context (role fidelity + prompt caching). Trailing-assistant prefill
//      becomes a continuation instruction. Falls back to a transcript fold.
//   4. Query with the roleplay isolation recipe: tools:[], skills:[],
//      settingSources:[], bypassPermissions, no MCP, scrubbed env.
//   5. Stream translation into the CompletionWriter (stop sequences, thinking
//      → reasoning_content).
//   6. Resilience ladder (retries only before first output): expired token →
//      OAuth refresh + retry; [1m] Extra-Usage failure → base model + 1h
//      cooldown; rate limit → 2 retries; quota exhausted → API/LinkAPI
//      overflow when armed; stale resume → fold.
//   7. Privacy sweep of the live-turn transcript the CLI wrote.
//
// v3 fixes over the standalone Claude plugin:
//   • `<synthetic>` assistant messages (the CLI's locally generated error
//     replies — "does not support this model", "hit your limit", "run
//     /login") are surfaced as the real error instead of tripping the
//     served-model guard with a meaningless "resolved to <synthetic>".
//   • rate_limit_event messages feed the quota meter live.
//   • CLI-too-old errors tell the user to update the plugin's SDK.

import { randomUUID } from 'node:crypto';

import { loadSdk, resolveClaudeExecutable } from './sdk-loader.js';
import { parseClaudeModel, isExtendedContextKnownUnavailable, recordExtendedContextUnavailable } from './models.js';
import { buildSubprocessEnv } from './env.js';
import { buildSystemPrompt } from './system-prompt.js';
import { assembleEntries, splitHistoryForResume, currentToSdkUserMessage, singleMessageStream, SDK_VERSION } from './jsonl-entries.js';
import { ResumeSessionStore, resumeScratchCwd, sweepSessionTranscript } from './session-store.js';
import { chooseClaudeAuth } from './auth.js';
import {
    isExpiredTokenError, isRateLimitError, isExtraUsageRequiredError, isStaleSessionError, isQuotaExhaustedError,
    isCliTooOldError, isSafeguardError, refreshOAuthToken, recordRateLimitEvent,
} from './oauth.js';
import { extractSystemText, foldConversation } from '../common/messages.js';
import { toOpenAiUsage } from '../common/sse.js';
import { envFlag } from '../common/platform.js';

const TAG = '[subscriptions/claude]';
const MAX_RATE_LIMIT_RETRIES = 2;
// Below this max_tokens the CLI's derived thinking budget violates the API's
// >= 1024 floor on non-adaptive models (verified live).
const MIN_MAX_TOKENS_FOR_THINKING = 2048;
const NONSTREAM_DEADLINE_MS = 10 * 60 * 1000;
const UPSTREAM_IDLE_MS = 90000;
const SYNTHETIC_MODEL = '<synthetic>';

function buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume }) {
    const c = settings.claude;
    const options = {
        abortController,
        model: oneMActive ? modelInfo.sdkModel : modelInfo.baseId,
        systemPrompt: buildSystemPrompt(systemText, c.identityMode),
        includePartialMessages: stream,
        env,

        // Roleplay isolation recipe — nothing from the host machine may leak.
        tools: [],
        skills: [],
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: Number(process.env.ST_SUBSCRIPTIONS_CLAUDE_MAX_TURNS) || 1,
    };

    const exe = resolveClaudeExecutable();
    if (exe) options.pathToClaudeCodeExecutable = exe.path;

    // Thinking / effort. ALWAYS set thinking explicitly — omitting it lets the
    // CLI auto-enable thinking with a budget derived from
    // CLAUDE_CODE_MAX_OUTPUT_TOKENS, which 400s below ~2048 max tokens.
    // `display` controls whether thinking CONTENT is emitted at all.
    const display = settings.showReasoning ? 'summarized' : 'omitted';
    if (modelInfo.adaptiveOnly) {
        options.thinking = { type: 'adaptive', display };
    } else {
        const wantsThinking = c.thinking === 'adaptive' || c.thinking === 'on';
        const roomForThinking = !settings.maxTokens || settings.maxTokens >= MIN_MAX_TOKENS_FOR_THINKING;
        if (wantsThinking && roomForThinking) {
            if (c.thinking === 'on') {
                const budget = c.thinkingBudget
                    ? Math.max(1024, Math.min(c.thinkingBudget, (settings.maxTokens ?? Infinity) - 512))
                    : undefined;
                options.thinking = budget ? { type: 'enabled', budgetTokens: budget, display } : { type: 'enabled', display };
            } else {
                options.thinking = { type: 'adaptive', display };
            }
        } else {
            if (wantsThinking && !roomForThinking) {
                console.log(`${TAG} thinking disabled: max_tokens ${settings.maxTokens} < ${MIN_MAX_TOKENS_FOR_THINKING} (raise Max response length in SillyTavern to enable thinking on ${modelInfo.baseId})`);
            }
            options.thinking = { type: 'disabled' };
        }
    }
    if (c.effort) options.effort = c.effort;

    // Fast mode (the CLI's /fast). Passed through the settings channel; the CLI
    // reports the effective state on the init message — logged, never assumed.
    if (c.fastMode) {
        options.settings = { ...(options.settings || {}), fastMode: true };
    }

    // Always run the subprocess in the plugin's scratch bucket.
    try {
        options.cwd = resume ? resume.cwd : resumeScratchCwd();
    } catch { /* unwritable scratch dir — fall back to process cwd */ }

    if (resume) {
        options.resume = resume.sessionId;
        options.sessionStore = resume.store;
    }

    return options;
}

/** Build the query configuration: resume path, else stream-input (images), else fold. */
function buildQueryConfig({ messages, modelInfo, oneMActive, settings, abortController, stream, env }) {
    const systemText = extractSystemText(messages);

    if (settings.claude.useResume && envFlag('ST_SUBSCRIPTIONS_CLAUDE_USE_RESUME', true)) {
        try {
            const cwd = resumeScratchCwd();
            const sessionId = randomUUID();
            const split = splitHistoryForResume(messages);
            const meta = { sessionId, cwd, version: SDK_VERSION, gitBranch: '', permissionMode: 'bypassPermissions' };
            const entries = assembleEntries(split.history, meta, modelInfo.baseId);
            if (entries.length > 0) {
                const prompt = singleMessageStream(currentToSdkUserMessage(split.current));
                const resume = { sessionId, store: new ResumeSessionStore(sessionId, entries), cwd };
                const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume });
                return { prompt, options, path: 'resume', sessionId, shape: split.shape };
            }
            const hasImages = Array.isArray(split.current?.content) && split.current.content.some((p) => p?.type === 'image_url');
            if (hasImages) {
                const prompt = singleMessageStream(currentToSdkUserMessage(split.current));
                const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume: null });
                return { prompt, options, path: 'stream-input', sessionId: null, shape: split.shape };
            }
        } catch (err) {
            console.warn(`${TAG} resume path unavailable, folding transcript:`, err instanceof Error ? err.message : err);
        }
    }

    const prompt = foldConversation(messages, { includeSystem: false });
    const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume: null });
    return { prompt, options, path: 'fold', sessionId: null, shape: 'fold' };
}

/**
 * Served-model guard: never silently substitute another model for an explicit
 * Fable request. Checked on init, on message_start (before any output) and on
 * every main-thread assistant message. A refusal must reach the user as an
 * error — an Opus-written "fallback" reply is exactly what must not happen.
 */
export function assertServedModel(guardTier, servedModel, requestedModel) {
    if (guardTier !== 'fable') return;
    const served = String(servedModel ?? '').toLowerCase();
    if (!served || served === SYNTHETIC_MODEL) return; // synthetic = local error reply, handled elsewhere
    if (!served.includes('fable') && !served.includes('mythos')) {
        const err = new Error(
            `Model substitution refused: you requested ${requestedModel} but the upstream resolved to ` +
            `${servedModel}. Fable may be temporarily unavailable on your plan — pick another model ` +
            'explicitly instead of being silently switched. (served-model guard)',
        );
        err.sdkErrorText = 'served-model-guard';
        err.noRetry = true;
        throw err;
    }
}

function blocksText(blocks) {
    return (blocks ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join(' ');
}

/**
 * Run one SDK query attempt, normalising SDK messages into simple events:
 *   { kind:'session', id } { kind:'text', text } { kind:'reasoning', text }
 *   { kind:'reasoning-block', text } { kind:'blocks', blocks } { kind:'done', usage }
 * Throws Error with .sdkErrorText on failure (classified by the caller).
 */
async function* runQuery({ sdk, prompt, options, stream, guardTier, requestedModel }) {
    let idleTimer = null;
    const abort = options.abortController;
    const idleMs = stream ? UPSTREAM_IDLE_MS : NONSTREAM_DEADLINE_MS;
    const fireIdleAbort = () => {
        console.warn(`${TAG} upstream ${stream ? 'idle' : 'deadline exceeded'} after ${idleMs}ms — aborting query`);
        abort.idleAbort = true;
        abort.abort();
    };
    const armIdleGuard = () => {
        if (!stream) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(fireIdleAbort, idleMs);
        idleTimer.unref?.();
    };

    idleTimer = setTimeout(fireIdleAbort, idleMs);
    idleTimer.unref?.();
    try {
        const handle = sdk.query({ prompt, options });
        for await (const message of handle) {
            armIdleGuard();

            if (message.type === 'system' && message.subtype === 'init') {
                assertServedModel(guardTier, message.model, requestedModel);
                if (message.fast_mode_state && message.fast_mode_state !== 'off') {
                    console.log(`${TAG} fast mode: ${message.fast_mode_state}`);
                } else if (options.settings?.fastMode && message.fast_mode_disabled_reason) {
                    console.log(`${TAG} fast mode requested but off (${message.fast_mode_disabled_reason})`);
                }
                if (message.session_id) yield { kind: 'session', id: message.session_id };
            } else if (message.type === 'rate_limit_event') {
                recordRateLimitEvent(message.rate_limit_info);
            } else if (message.type === 'stream_event') {
                const event = message.event;
                if (message.parent_tool_use_id) continue;
                // message_start names the model that will produce THIS reply —
                // it arrives before any text delta, so a CLI-side fallback
                // (e.g. Fable → Opus after a refusal) dies with zero output.
                if (event?.type === 'message_start') {
                    assertServedModel(guardTier, event.message?.model, requestedModel);
                }
                if (event?.type === 'content_block_delta' && event.delta) {
                    if (event.delta.type === 'text_delta' && event.delta.text) yield { kind: 'text', text: event.delta.text };
                    else if (event.delta.type === 'thinking_delta' && event.delta.thinking) yield { kind: 'reasoning', text: event.delta.thinking };
                }
            } else if (message.type === 'assistant') {
                if (message.parent_tool_use_id) continue;
                const model = message.message?.model;
                // The CLI answers locally generated errors as a "<synthetic>"
                // assistant message whose text IS the error. Surface it.
                if (model === SYNTHETIC_MODEL || message.error) {
                    const text = blocksText(message.message?.content);
                    const err = new Error(text || `assistant error: ${message.error ?? 'unknown'}`);
                    err.sdkErrorText = `${message.error ?? ''} ${text}`;
                    throw err;
                }
                assertServedModel(guardTier, model, requestedModel);
                if (!stream) {
                    yield { kind: 'blocks', blocks: message.message?.content ?? [] };
                } else {
                    // Streamed thinking may arrive as a COMPLETE block on the
                    // assistant message rather than thinking_delta events.
                    for (const block of message.message?.content ?? []) {
                        if (block.type === 'thinking' && block.thinking) yield { kind: 'reasoning-block', text: block.thinking };
                    }
                }
            } else if (message.type === 'result') {
                if (message.subtype === 'success' && !message.is_error) {
                    yield { kind: 'done', usage: message.usage ?? null };
                    return;
                }
                const detail = [message.result, ...(message.errors ?? [])].filter(Boolean).join('; ');
                const err = new Error(`Claude request failed (${message.subtype})${detail ? ' — ' + detail : ''}`);
                err.sdkErrorText = `${message.subtype} ${detail}`;
                throw err;
            }
        }
        yield { kind: 'done', usage: null };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

function mapUsage(usage) {
    if (!usage) return null;
    return toOpenAiUsage({
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreate: usage.cache_creation_input_tokens ?? 0,
        reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
    });
}

function friendlyHint(text) {
    if (isSafeguardError(text)) {
        return ' — the request was NOT retried or moved to another model. Reword or regenerate, go back a message, or switch the model to Opus yourself.';
    }
    if (isCliTooOldError(text)) {
        return ' — the Claude Code CLI bundled with the plugin\'s Agent SDK is too old for this model: run `npm install` inside plugins/SillyTavern-Subscriptions to update it, then restart SillyTavern.';
    }
    if (isExpiredTokenError(text)) return ' — run `claude login` on the SillyTavern host (same OS user), then retry.';
    if (isQuotaExhaustedError(text)) return ' — subscription window exhausted; wait for the reset, or set Claude backend to "api" with a LinkAPI/API key for pay-per-token overflow.';
    return '';
}

/**
 * @param {object} args
 * @param {import('express').Request} args.req
 * @param {object[]} args.messages
 * @param {string} args.model requested model id
 * @param {object} args.settings from extractRequestSettings()
 * @param {import('../common/completion.js').CompletionWriter} args.writer
 */
export async function runClaudeChat({ req, messages, model, settings, writer }) {
    const modelInfo = parseClaudeModel(model);
    const wantStream = writer.stream;

    let sdk;
    try {
        sdk = await loadSdk();
    } catch (err) {
        writer.fail(err, { status: 500, type: 'sdk_unavailable' });
        return;
    }

    let authPlan;
    try {
        authPlan = chooseClaudeAuth(settings.claude.backend, req);
    } catch (err) {
        writer.fail(err, { status: err.httpStatus ?? 400, type: 'invalid_request_error' });
        return;
    }
    let auth = authPlan.auth;
    let overflowArmed = authPlan.fallback;
    console.log(`${TAG} ${modelInfo.requested} via ${authPlan.chosen}`);

    const sweepIds = [];
    let abortController = null;
    let clientClosed = false;
    const onClientClose = () => { clientClosed = true; abortController?.abort(); };
    req.on('close', onClientClose);

    let oneMActive = modelInfo.oneM && !isExtendedContextKnownUnavailable();
    let didTokenRefresh = false;
    let rateLimitRetries = 0;
    let usage = null;

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (clientClosed) break;
            abortController = new AbortController();
            const env = buildSubprocessEnv({ envPins: modelInfo.envPins, maxTokens: settings.maxTokens, auth });
            const cfg = buildQueryConfig({ messages, modelInfo, oneMActive, settings, abortController, stream: wantStream, env });
            if (cfg.sessionId) sweepIds.push(cfg.sessionId);
            writer.resetScanner(settings.stops);

            try {
                for await (const ev of runQuery({ sdk, prompt: cfg.prompt, options: cfg.options, stream: wantStream, guardTier: modelInfo.tier, requestedModel: modelInfo.requested })) {
                    if (ev.kind === 'session') {
                        if (!sweepIds.includes(ev.id)) sweepIds.push(ev.id);
                    } else if (ev.kind === 'text') {
                        if (writer.pushText(ev.text)) { abortController.abort(); break; }
                    } else if (ev.kind === 'reasoning') {
                        writer.pushReasoning(ev.text);
                    } else if (ev.kind === 'reasoning-block') {
                        writer.pushReasoning(ev.text, { isDelta: false });
                    } else if (ev.kind === 'blocks') {
                        for (const block of ev.blocks) {
                            if (block.type === 'thinking' && block.thinking) writer.pushReasoning(block.thinking, { isDelta: false });
                        }
                        for (const block of ev.blocks) {
                            if (block.type === 'text' && block.text && writer.pushText(block.text)) break;
                        }
                    } else if (ev.kind === 'done') {
                        usage = ev.usage;
                    }
                }
                writer.flushTail();
                break; // success
            } catch (err) {
                const errText = err?.sdkErrorText ?? (err instanceof Error ? err.message : String(err));
                if (err?.noRetry) throw err;
                // A safeguard refusal is final: never re-sent, never re-routed
                // to another model. The user decides (reword, step back, or
                // pick Opus explicitly).
                if (isSafeguardError(errText)) throw err;
                if (abortController.signal.aborted && writer.didYieldContent && !abortController.idleAbort) break;
                if (clientClosed) break;

                if (!writer.didYieldContent) {
                    if (oneMActive && isExtraUsageRequiredError(errText)) {
                        console.warn(`${TAG} 1M context unavailable (Extra Usage) — retrying on base model, cooldown 1h`);
                        recordExtendedContextUnavailable();
                        oneMActive = false;
                        continue;
                    }
                    if (auth.mode === 'subscription' && isExpiredTokenError(errText) && !didTokenRefresh) {
                        didTokenRefresh = true;
                        console.warn(`${TAG} auth expired — attempting OAuth refresh + one retry`);
                        if (await refreshOAuthToken()) continue;
                    }
                    if (auth.mode === 'subscription' && overflowArmed && (isQuotaExhaustedError(errText) || isRateLimitError(errText))) {
                        console.warn(`${TAG} subscription limit hit — switching this request to the API/LinkAPI backend (${overflowArmed.source})`);
                        auth = overflowArmed;
                        overflowArmed = null;
                        oneMActive = false;
                        continue;
                    }
                    if (isRateLimitError(errText) && !isQuotaExhaustedError(errText) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                        rateLimitRetries += 1;
                        if (oneMActive) oneMActive = false;
                        const delay = 1000 * rateLimitRetries;
                        console.warn(`${TAG} rate limited — retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`);
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    if (isStaleSessionError(errText) && cfg.path === 'resume') {
                        console.warn(`${TAG} stale resume session — retrying via transcript fold`);
                        settings.claude.useResume = false;
                        continue;
                    }
                }
                throw err;
            }
        }
    } catch (err) {
        const friendly = err instanceof Error ? err.message : String(err);
        console.error(`${TAG} query failed:`, friendly);
        writer.fail(new Error(`${friendly}${friendlyHint(friendly)}`));
        return;
    } finally {
        req.off('close', onClientClose);
        for (const id of sweepIds) sweepSessionTranscript(loadSdk, id);
    }

    if (clientClosed && !writer.ended) {
        // Client went away mid-stream: nothing more to send.
        try { writer.finish({ usage: mapUsage(usage) }); } catch { /* socket gone */ }
        return;
    }
    writer.finish({ usage: mapUsage(usage), finishReason: writer.stopMatched ? 'stop' : 'stop' });
}
