// ──────────────────────────────────────────────
// Claude provider — chat orchestrator (Agent SDK)
// ──────────────────────────────────────────────
//
// Pipeline per request:
//   1. Parse the model (catalog facts, [1m] variants → tier alias + env pin)
//      and settings; pick the backend (subscription / api / auto overflow).
//   2. The leading system messages → the SDK system prompt (a custom prompt,
//      never the coding preset). Later system messages stay in place as user
//      turns (Impersonate, quiet prompts, depth injections).
//   3. Prior turns → a synthetic Claude Code JSONL session replayed through a
//      one-shot SessionStore + `resume`, so the model sees REAL multi-turn
//      context (role fidelity + prompt caching). A trailing assistant prefill
//      becomes a continuation instruction. Falls back to a transcript fold.
//   4. Query with the roleplay isolation recipe: no tools / skills / MCP /
//      settings files, verbatim prompts (no @file expansion or slash
//      commands), a plugin-owned working directory, a fixed session title (no
//      title side call), no transcript persistence, and the env switches in
//      env.js (no model substitution, no attachments, no compaction).
//   5. Stream translation into the CompletionWriter: text deltas of text
//      blocks → content, thinking deltas → reasoning_content. The reply stops
//      at SillyTavern's max length (finish_reason "length") — the CLI would
//      otherwise keep generating up to three more times on its own.
//   6. Resilience ladder (retries only before any output): 1M needs usage
//      credits → base model + 1h cooldown; expired token → OAuth refresh (or
//      the CLI's own login store) + retry; transient rate limit → 2 backoff
//      retries; subscription exhausted → API-key overflow when armed (auto);
//      stale resume → fold.
//   7. Hard rules: a safety refusal is final (never retried, never moved to
//      another model), the served-model guard rejects any reply that comes
//      from a different model than the one requested, and on the
//      subscription backend the prompt is held back until the CLI proves it
//      authenticated with the subscription login (billing guard).

import { randomUUID } from 'node:crypto';
import { parse as parsePath } from 'node:path';
import { tmpdir } from 'node:os';

import { loadSdk, resolveClaudeExecutable, recordCliVersion, claudeCliSummary } from './sdk-loader.js';
import {
    parseClaudeModel, clampClaudeEffort, canonicalClaudeModelId,
    isExtendedContextKnownUnavailable, recordExtendedContextUnavailable,
} from './models.js';
import { buildSubprocessEnv } from './env.js';
import { buildSystemPrompt } from './system-prompt.js';
import { assembleEntries, splitHistoryForResume, currentToSdkUserMessage, singleMessageStream, SDK_VERSION } from './jsonl-entries.js';
import { ResumeSessionStore, sweepPluginTranscripts, sweepStaleResumeDirs, runtimeDir } from './session-store.js';
import { chooseClaudeAuth, prepareSubscriptionAuth } from './auth.js';
import {
    isExpiredTokenError, isRateLimitError, isExtraUsageRequiredError, isStaleSessionError, isQuotaExhaustedError,
    isCliTooOldError, isSafeguardError, refreshOAuthToken, recordRateLimitEvent,
} from './oauth.js';
import { extractSystemText, foldConversation } from '../common/messages.js';
import { toOpenAiUsage } from '../common/sse.js';
import { envFlag, envInt } from '../common/platform.js';
import { onAbort } from '../common/abort.js';

const TAG = '[subscriptions/claude]';
const MAX_RATE_LIMIT_RETRIES = 2;
// Before the first visible output a model may think silently for minutes
// (Opus 5.5 / Fable at high effort); once output flows, a long gap is a stall.
const FIRST_OUTPUT_IDLE_MS = 10 * 60 * 1000;
const BETWEEN_OUTPUT_IDLE_MS = 2 * 60 * 1000;
const SYNTHETIC_MODEL = '<synthetic>';
const SESSION_TITLE = 'SillyTavern';

/**
 * Subprocess working directory: a plugin-owned folder whose name says what it
 * is. The CLI shows the working directory to the model, and Opus 5.5's safety
 * classifier reads a bare path (the drive root, a nondescript folder) as an
 * agentic/system context — it refused plain roleplay lines there ("cyber")
 * while the same request from a SillyTavern-named folder went through
 * (verified live). Nothing is ever written into it.
 */
function neutralCwd() {
    try {
        return runtimeDir('SillyTavern-chat');
    } catch {
        return parsePath(tmpdir()).root || '/';
    }
}

function buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, env, resume }) {
    const c = settings.claude;
    const options = {
        abortController,
        model: oneMActive ? modelInfo.sdkModel : modelInfo.baseId,
        systemPrompt: buildSystemPrompt(systemText, c.identityMode, modelInfo),
        includePartialMessages: true,
        env,
        cwd: neutralCwd(),
        title: SESSION_TITLE,

        // Roleplay isolation recipe — nothing from the host machine may leak.
        tools: [],
        skills: [],
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        verbatimPrompts: true,
        permissionMode: 'dontAsk',
        maxTurns: envInt('ST_SUBSCRIPTIONS_CLAUDE_MAX_TURNS', 1) || 1,
    };

    const exe = resolveClaudeExecutable();
    if (exe) options.pathToClaudeCodeExecutable = exe.path;

    // Thinking. `display` only controls whether thinking TEXT is returned;
    // the CLI maps the request onto what each model accepts (adaptive vs a
    // budget, and it drops "disabled" for always-thinking models).
    const display = settings.showReasoning ? 'summarized' : 'omitted';
    if (modelInfo.thinking === 'always') {
        options.thinking = { type: 'adaptive', display };
    } else if (c.thinking === 'off') {
        options.thinking = { type: 'disabled' };
    } else if (c.thinking === 'on' && (modelInfo.thinking === 'budget' || modelInfo.thinking === 'hybrid')) {
        // A fixed budget: on hybrid models (Opus/Sonnet 4.6) the env sets
        // CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING, otherwise the CLI prefers
        // adaptive; without a budget the CLI derives one from the max length.
        options.thinking = c.thinkingBudget
            ? { type: 'enabled', budgetTokens: Math.max(1024, c.thinkingBudget), display }
            : { type: 'enabled', display };
    } else {
        options.thinking = { type: 'adaptive', display };
    }

    const effort = clampClaudeEffort(modelInfo, c.effort);
    if (effort) options.effort = effort;

    // Fast mode (the CLI's /fast) — Opus 4.8 / 5 / 5.5 only, draws usage
    // credits. The CLI reports the effective state on the init message.
    if (c.fastMode) options.settings = { fastMode: true };

    if (resume) {
        options.resume = resume.sessionId;
        options.sessionStore = resume.store;
    } else {
        options.persistSession = false; // (cannot be combined with sessionStore)
    }
    return options;
}

/** Build the query configuration: resume path, else a single streamed turn, else fold. */
function buildQueryConfig({ messages, modelInfo, oneMActive, settings, useResume, abortController, env }) {
    const systemText = extractSystemText(messages);
    const opts = { modelInfo, oneMActive, settings, systemText, abortController, env };

    if (useResume && envFlag('ST_SUBSCRIPTIONS_CLAUDE_USE_RESUME', true)) {
        try {
            const sessionId = randomUUID();
            const split = splitHistoryForResume(messages);
            const meta = { sessionId, cwd: neutralCwd(), version: SDK_VERSION, gitBranch: '', permissionMode: 'dontAsk' };
            const entries = assembleEntries(split.history, meta, modelInfo.baseId);
            const prompt = singleMessageStream(currentToSdkUserMessage(split.current));
            if (entries.length > 0) {
                const resume = { sessionId, store: new ResumeSessionStore(sessionId, entries) };
                return { prompt, options: buildSdkOptions({ ...opts, resume }), path: 'resume', shape: split.shape };
            }
            // No prior turns: send the single turn as a real user message (keeps images).
            return { prompt, options: buildSdkOptions({ ...opts, resume: null }), path: 'stream-input', shape: split.shape };
        } catch (err) {
            console.warn(`${TAG} resume path unavailable, folding transcript:`, err instanceof Error ? err.message : err);
        }
    }

    // Streamed like the other paths, so the prompt can be held back until the
    // CLI's authentication has been checked (see runQuery).
    const prompt = singleMessageStream({ type: 'user', message: { role: 'user', content: foldConversation(messages, { includeSystem: false }) }, parent_tool_use_id: null });
    return { prompt, options: buildSdkOptions({ ...opts, resume: null }), path: 'fold', shape: 'fold' };
}

/**
 * Billing guard for the subscription backend: the CLI resolves credentials
 * on its own (a /login-managed Console API key, an `ant` CLI profile or a
 * cloud provider can outrank the claude.ai login), so before the prompt is
 * released the auth it actually picked is checked. Anything that would bill
 * a key or another provider is refused.
 * @param {object|undefined} account AccountInfo from initializationResult() / the init message
 */
export function assertSubscriptionAuth(account) {
    if (!account || typeof account !== 'object') return;
    const keySource = account.apiKeySource;
    const provider = account.apiProvider;
    const keyOk = keySource === undefined || keySource === null || keySource === 'none' || keySource === 'oauth';
    const providerOk = provider === undefined || provider === null || provider === 'firstParty';
    if (keyOk && providerOk) return;
    const what = !providerOk ? `the ${provider} provider` : `an API key (${keySource})`;
    const err = new Error(
        `Billing guard: the Claude CLI would have used ${what} instead of your Claude subscription login, ` +
        'so the request was not sent. Remove that credential from the SillyTavern host (or pick the "API key" backend ' +
        'if you meant to pay per token), then retry.',
    );
    err.sdkErrorText = 'billing-guard';
    err.noRetry = true;
    err.httpStatus = 400;
    throw err;
}

/** Wrap a prompt iterable so nothing is sent before `gate` resolves. */
function gatedPrompt(prompt, gate) {
    return (async function* held() {
        await gate;
        yield* prompt;
    })();
}

/**
 * Served-model guard: never let a reply from another model through. Checked
 * on init, on message_start (before any output) and on every assistant
 * message. The CLI's own substitution paths are switched off in env.js; this
 * is the backstop. Alias echoes ("opus[1m]") and the CLI's locally generated
 * "<synthetic>" replies are not concrete models and are skipped.
 */
export function assertServedModel(requestedBaseId, servedModel) {
    const served = String(servedModel ?? '').trim();
    if (!served || served === SYNTHETIC_MODEL) return;
    const got = canonicalClaudeModelId(served);
    const want = canonicalClaudeModelId(requestedBaseId);
    if (!got.startsWith('claude-') || !want.startsWith('claude-') || got === want) return;
    const err = new Error(
        `Model substitution refused: you requested ${requestedBaseId} but the reply came from ${servedModel}. ` +
        'The model may be unavailable on your plan right now — pick another model explicitly instead of being ' +
        'silently switched. (served-model guard)',
    );
    err.sdkErrorText = 'served-model-guard';
    err.noRetry = true;
    throw err;
}

function refusalError(text, category, model) {
    const who = model || 'The model';
    const err = new Error(text || `${who} declined this request (safety classifier${category ? `: ${category}` : ''}).`);
    err.sdkErrorText = `refusal ${text ?? ''}`;
    err.refusal = true;
    err.noRetry = true;
    err.httpStatus = 422;
    return err;
}

function blocksText(blocks) {
    return (blocks ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join(' ');
}

/**
 * Run one SDK query attempt, normalising SDK messages into simple events:
 *   { kind:'text', text } { kind:'reasoning', text } { kind:'reasoning-block', text }
 *   { kind:'length', usage } { kind:'done', usage }
 * Throws Error with .sdkErrorText on failure (classified by the caller),
 * with .refusal/.noRetry for refusals and substitutions.
 */
async function* runQuery({ sdk, prompt, options, requestedBaseId, modelName, checkSubscription = false }) {
    const abort = options.abortController;
    let idleTimer = null;
    let outputStarted = false;
    const arm = () => {
        if (idleTimer) clearTimeout(idleTimer);
        const ms = outputStarted ? BETWEEN_OUTPUT_IDLE_MS : FIRST_OUTPUT_IDLE_MS;
        idleTimer = setTimeout(() => {
            console.warn(`${TAG} no progress from the CLI for ${Math.round(ms / 1000)}s — aborting query`);
            abort.idleAbort = ms;
            abort.abort();
        }, ms);
        idleTimer.unref?.();
    };

    const textStreamed = new Set();      // API message ids whose text arrived as deltas
    const thinkingStreamed = new Set();
    const blockTypes = new Map();        // content block index → type, for the current API message
    let currentId = null;
    let usage = null;

    arm();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    try {
        const handle = sdk.query({ prompt: gatedPrompt(prompt, gate), options });
        if (checkSubscription && typeof handle.initializationResult === 'function') {
            // Nothing has been sent yet: verify the credential the CLI picked.
            let init;
            try {
                init = await handle.initializationResult();
            } catch (err) {
                abort.abort();
                throw err;
            }
            try {
                assertSubscriptionAuth(init?.account);
            } catch (err) {
                abort.abort(); // the held prompt is never released
                throw err;
            }
        }
        release();
        for await (const message of handle) {
            arm();
            if (message.parent_tool_use_id) continue;

            if (message.type === 'system') {
                if (message.subtype === 'init') {
                    recordCliVersion(message.claude_code_version);
                    if (checkSubscription) assertSubscriptionAuth({ apiKeySource: message.apiKeySource });
                    assertServedModel(requestedBaseId, message.model);
                    if (message.fast_mode_state && message.fast_mode_state !== 'off') {
                        console.log(`${TAG} fast mode: ${message.fast_mode_state}`);
                    } else if (options.settings?.fastMode && message.fast_mode_disabled_reason) {
                        console.log(`${TAG} fast mode requested but off (${message.fast_mode_disabled_reason})`);
                    }
                } else if (message.subtype === 'model_refusal_no_fallback' || message.subtype === 'model_refusal_fallback') {
                    throw refusalError(message.content, message.api_refusal_category, modelName);
                }
                continue;
            }

            if (message.type === 'rate_limit_event') {
                recordRateLimitEvent(message.rate_limit_info);
                continue;
            }

            if (message.type === 'stream_event') {
                const event = message.event;
                if (event?.type === 'message_start') {
                    // Names the model that will produce THIS reply, before any delta.
                    assertServedModel(requestedBaseId, event.message?.model);
                    currentId = event.message?.id ?? null;
                    blockTypes.clear();
                } else if (event?.type === 'content_block_start') {
                    blockTypes.set(event.index, event.content_block?.type);
                } else if (event?.type === 'content_block_delta' && event.delta) {
                    const blockType = blockTypes.get(event.index);
                    if (event.delta.type === 'text_delta' && event.delta.text && (blockType === undefined || blockType === 'text')) {
                        outputStarted = true;
                        if (currentId) textStreamed.add(currentId);
                        yield { kind: 'text', text: event.delta.text };
                    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                        outputStarted = true;
                        if (currentId) thinkingStreamed.add(currentId);
                        yield { kind: 'reasoning', text: event.delta.thinking };
                    }
                } else if (event?.type === 'message_delta') {
                    if (event.usage) usage = { ...(usage ?? {}), ...event.usage };
                    const stop = event.delta?.stop_reason;
                    if (stop === 'max_tokens') {
                        // Stop here: the CLI would inject "resume" turns and keep going.
                        yield { kind: 'length', usage };
                        return;
                    }
                    if (stop === 'refusal') throw refusalError(null, event.delta?.stop_details?.category, modelName);
                }
                continue;
            }

            if (message.type === 'assistant') {
                const msg = message.message ?? {};
                // The CLI answers locally generated errors as a "<synthetic>"
                // assistant message whose text IS the error. Surface it.
                if (msg.model === SYNTHETIC_MODEL || message.error) {
                    const text = blocksText(msg.content);
                    if (message.error === 'max_output_tokens') { yield { kind: 'length', usage }; return; }
                    if (msg.stop_reason === 'refusal' || isSafeguardError(text)) throw refusalError(text, msg.stop_details?.category, modelName);
                    const err = new Error(text || `assistant error: ${message.error ?? 'unknown'}`);
                    err.sdkErrorText = `${message.error ?? ''} ${text}`;
                    err.assistantError = message.error ?? null;
                    throw err;
                }
                assertServedModel(requestedBaseId, msg.model);
                if (msg.stop_reason === 'refusal') throw refusalError(blocksText(msg.content), msg.stop_details?.category, modelName);
                // Complete blocks only when the deltas never arrived for this message.
                for (const block of msg.content ?? []) {
                    if (block.type === 'thinking' && block.thinking && !thinkingStreamed.has(msg.id)) {
                        yield { kind: 'reasoning-block', text: block.thinking };
                    }
                }
                if (!textStreamed.has(msg.id)) {
                    const text = blocksText(msg.content);
                    if (text) { outputStarted = true; if (msg.id) textStreamed.add(msg.id); yield { kind: 'text', text }; }
                }
                continue;
            }

            if (message.type === 'result') {
                if (message.subtype === 'success' && !message.is_error) {
                    if (message.stop_reason === 'max_tokens') { yield { kind: 'length', usage: message.usage ?? usage }; return; }
                    yield { kind: 'done', usage: message.usage ?? usage };
                    return;
                }
                const detail = [message.result, ...(message.errors ?? [])].filter(Boolean).join('; ');
                if (message.stop_reason === 'refusal' || isSafeguardError(detail)) throw refusalError(detail, null, modelName);
                const err = new Error(`Claude request failed (${message.subtype})${detail ? ' — ' + detail : ''}`);
                err.sdkErrorText = `${message.subtype} ${detail}`;
                throw err;
            }
        }
        yield { kind: 'done', usage };
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

function friendlyHint(err, text) {
    if (err?.refusal || isSafeguardError(text)) {
        return ' — the request was NOT retried or moved to another model. Reword or regenerate, go back a message, or pick another model yourself.';
    }
    if (isCliTooOldError(text)) {
        const cli = claudeCliSummary({ withVersion: false });
        if (cli.source && !cli.source.startsWith('sdk-bundle')) {
            return ` — the Claude CLI in use (${cli.source}: ${cli.path}) is too old for this model: update it (\`claude update\` or reinstall), or unset ST_SUBSCRIPTIONS_CLAUDE_PATH to use the one bundled with the plugin.`;
        }
        return ' — the Claude Code CLI bundled with the plugin\'s Agent SDK is too old for this model: run `npm install` inside plugins/SillyTavern-Subscriptions to update it, then restart SillyTavern.';
    }
    if (isExpiredTokenError(text)) return ' — run `claude auth login` on the SillyTavern host (same OS user), then retry.';
    if (isExtraUsageRequiredError(text)) return ' — 1M context needs usage credits on your plan; pick the model without "(1M context)".';
    if (isQuotaExhaustedError(text)) return ' — subscription window exhausted; wait for the reset, or set the Claude backend to "Auto"/"API" with an API key for pay-per-token overflow.';
    return '';
}

/**
 * @param {object} args
 * @param {import('express').Request} args.req
 * @param {object[]} args.messages
 * @param {string} args.model requested model id
 * @param {object} args.settings from extractRequestSettings()
 * @param {import('../common/completion.js').CompletionWriter} args.writer
 * @param {AbortSignal} [args.signal] aborted when the client disconnects or the plugin stops
 */
export async function runClaudeChat({ req, messages, model, settings, writer, signal }) {
    const modelInfo = parseClaudeModel(model);
    sweepStaleResumeDirs(neutralCwd());

    let sdk;
    try {
        sdk = await loadSdk();
    } catch (err) {
        writer.fail(err, { status: 500, type: 'sdk_unavailable' });
        return;
    }

    let plan;
    try {
        plan = chooseClaudeAuth(settings.claude.backend, req);
    } catch (err) {
        writer.fail(err, { status: err.httpStatus ?? 400, type: 'invalid_request_error' });
        return;
    }
    let auth;
    try {
        auth = plan.auth.mode === 'subscription' ? await prepareSubscriptionAuth() : plan.auth;
    } catch (err) {
        writer.fail(err, { status: err.httpStatus ?? 401, type: 'authentication_error' });
        return;
    }
    let overflowArmed = plan.fallback;

    const c = settings.claude;
    const notes = [];
    if (modelInfo.baseId !== modelInfo.requested) notes.push(`→ ${modelInfo.baseId}`);
    if (auth.isolated) notes.push('account-isolated');
    if (c.thinking === 'off' && modelInfo.thinking === 'always') notes.push('always thinks (Off ignored)');
    const effort = clampClaudeEffort(modelInfo, c.effort);
    if (c.effort && effort !== c.effort) notes.push(`effort ${c.effort}→${effort ?? 'n/a'}`);
    console.log(`${TAG} ${modelInfo.requested} via ${plan.chosen}${notes.length ? ` (${notes.join(', ')})` : ''}`);

    let abortController = null;
    let clientGone = false;
    const offAbort = onAbort(signal, () => { clientGone = true; abortController?.abort(); });

    let oneMActive = modelInfo.oneM && !isExtendedContextKnownUnavailable();
    let useResume = c.useResume;
    let triedTokenRecovery = false;
    let rateLimitRetries = 0;
    let usage = null;
    let finishReason = 'stop';

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (clientGone) return;
            abortController = new AbortController();
            const env = buildSubprocessEnv({
                envPins: modelInfo.envPins, maxTokens: settings.maxTokens, auth, fastMode: c.fastMode,
                forceBudgetThinking: c.thinking === 'on' && modelInfo.thinking === 'hybrid',
            });
            const cfg = buildQueryConfig({ messages, modelInfo, oneMActive, settings, useResume, abortController, env });
            writer.resetScanner(settings.stops);
            finishReason = 'stop';

            try {
                for await (const ev of runQuery({ sdk, prompt: cfg.prompt, options: cfg.options, requestedBaseId: modelInfo.baseId, modelName: modelInfo.name ?? modelInfo.baseId, checkSubscription: auth.mode === 'subscription' })) {
                    if (ev.kind === 'text') {
                        if (writer.pushText(ev.text)) { abortController.abort(); break; }
                    } else if (ev.kind === 'reasoning') {
                        writer.pushReasoning(ev.text);
                    } else if (ev.kind === 'reasoning-block') {
                        writer.pushReasoning(ev.text, { isDelta: false });
                    } else if (ev.kind === 'length') {
                        finishReason = 'length';
                        usage = ev.usage ?? usage;
                        abortController.abort();
                        break;
                    } else if (ev.kind === 'done') {
                        usage = ev.usage;
                    }
                }
                if (clientGone) return;
                writer.flushTail();
                break; // success
            } catch (err) {
                if (clientGone) return;
                if (abortController.idleAbort) {
                    const e = new Error(`Claude produced no progress for ${Math.round(abortController.idleAbort / 1000)} seconds — the request was aborted.`);
                    e.noRetry = true;
                    throw e;
                }
                const errText = err?.sdkErrorText ?? (err instanceof Error ? err.message : String(err));
                // A safety refusal is final: never re-sent, never re-routed.
                if (err?.noRetry || err?.refusal || isSafeguardError(errText)) throw err;

                if (!writer.didYieldContent) {
                    if (oneMActive && isExtraUsageRequiredError(errText)) {
                        console.warn(`${TAG} 1M context needs usage credits on this plan — retrying on the base model, cooldown 1h`);
                        recordExtendedContextUnavailable();
                        oneMActive = false;
                        continue;
                    }
                    if (auth.mode === 'subscription' && isExpiredTokenError(errText) && !triedTokenRecovery) {
                        triedTokenRecovery = true;
                        console.warn(`${TAG} auth rejected — attempting OAuth refresh + one retry`);
                        // An isolated subprocess cannot refresh its env token, and
                        // the CLI's own refresh can lose a race with another login:
                        // refresh out of band, then hand the fresh token over.
                        if (await refreshOAuthToken()) {
                            if (auth.isolated) auth = await prepareSubscriptionAuth(); // throws with instructions if still unusable
                            continue;
                        }
                    }
                    if (isRateLimitError(errText) && !isQuotaExhaustedError(errText) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                        rateLimitRetries += 1;
                        const delay = 1000 * rateLimitRetries;
                        console.warn(`${TAG} rate limited — retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`);
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    if (auth.mode === 'subscription' && overflowArmed && (isQuotaExhaustedError(errText) || isRateLimitError(errText))) {
                        console.warn(`${TAG} subscription limit hit — switching this request to the API-key backend (${overflowArmed.source})`);
                        auth = overflowArmed;
                        overflowArmed = null;
                        oneMActive = false;
                        continue;
                    }
                    if (isStaleSessionError(errText) && cfg.path === 'resume') {
                        console.warn(`${TAG} stale resume session — retrying via transcript fold`);
                        useResume = false;
                        continue;
                    }
                }
                throw err;
            }
        }
    } catch (err) {
        if (clientGone) return;
        const text = err instanceof Error ? err.message : String(err);
        console.error(`${TAG} query failed:`, text);
        writer.flushTail();
        writer.fail(new Error(`${text}${friendlyHint(err, err?.sdkErrorText ?? text)}`), { status: err?.httpStatus ?? 502 });
        return;
    } finally {
        offAbort();
        sweepPluginTranscripts();
    }

    writer.finish({ usage: mapUsage(usage), finishReason: writer.stopMatched ? 'stop' : finishReason });
}
