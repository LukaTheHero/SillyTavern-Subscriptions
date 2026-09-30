// ──────────────────────────────────────────────
// Gemini provider — chat runner
// ──────────────────────────────────────────────
//
// backend = subscription → agy print mode on the Google sign-in only. When
//                          agy's settings.json is set up for API-key billing
//                          (modelProvider, or a GOOGLE_GEMINI_BASE_URL) the
//                          request is refused, and agy always runs with every
//                          Gemini key / base-URL / gateway variable removed.
// backend = api          → direct OpenAI-compatible HTTP with a Gemini key to
//                          Google's OpenAI-compatible endpoint, or to the base
//                          URL that comes from the same place as the key.
// backend = auto         → agy when installed, following agy's own
//                          configuration (including its API-key mode); else
//                          the api backend when a key exists.
//
// agy turns run the isolated chat agent (see agy.js). The CLI takes one text
// prompt, so the conversation is folded into a transcript; images on the
// current turn are refused there (use the api backend), older ones become
// "[image omitted]".

import { agyLaunchSpec, runAgy, readAntigravitySettings, agyBilling } from './agy.js';
import { resolveGeminiModel, listGeminiModels, geminiCatalog, agyModelId } from './models.js';
import { runOpenAiCompat } from '../common/openai-compat.js';
import { foldConversation, splitConversation } from '../common/messages.js';
import { toOpenAiUsage } from '../common/sse.js';
import { abortError } from '../common/abort.js';
import { bearerFromRequest } from '../claude/env.js';

const TAG = '[subscriptions/gemini]';
const GOOGLE_OPENAI_COMPAT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GOOGLE_HOST = 'generativelanguage.googleapis.com';

/** Keys that clearly belong to another vendor (SillyTavern's Custom API key field is shared). */
export function isOtherVendorKey(key) {
    return /^sk-(ant|proj|svcacct)-/i.test(String(key ?? ''));
}

/**
 * Key + base URL for the direct API backend. The base URL is paired with the
 * key's source, so a key never travels to an endpoint configured for another
 * one:
 *   ST_SUBSCRIPTIONS_GEMINI_BASE_URL          explicit override, any key
 *   GEMINI_API_KEY / GOOGLE_API_KEY (env)     GOOGLE_GEMINI_BASE_URL (env)
 *   agy settings.json env block               GOOGLE_GEMINI_BASE_URL from the same block
 *   Custom API key field / plugin key         Google's endpoint (set the override for anything else)
 * @param {import('express').Request|null} req
 * @param {{ settings?: object|null, env?: Record<string,string|undefined> }} [opts] test seams
 */
export function discoverGeminiApiCredentials(req, { settings = readAntigravitySettings(), env = process.env } = {}) {
    const pick = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
    const header = pick(bearerFromRequest(req));
    const candidates = [
        [header && !isOtherVendorKey(header) ? header : null, 'api-key-field'],
        [pick(env.ST_SUBSCRIPTIONS_GEMINI_API_KEY), 'ST_SUBSCRIPTIONS_GEMINI_API_KEY'],
        [pick(env.GEMINI_API_KEY), 'GEMINI_API_KEY'],
        [pick(env.GOOGLE_API_KEY), 'GOOGLE_API_KEY'],
        [pick(settings?.env?.GEMINI_API_KEY), 'antigravity-settings'],
    ];
    const hit = candidates.find(([key]) => key);
    if (!hit) return null;
    const [key, source] = hit;
    let baseUrl = pick(env.ST_SUBSCRIPTIONS_GEMINI_BASE_URL);
    if (!baseUrl) {
        if (source === 'antigravity-settings') baseUrl = pick(settings?.env?.GOOGLE_GEMINI_BASE_URL);
        else if (source === 'GEMINI_API_KEY' || source === 'GOOGLE_API_KEY') baseUrl = pick(env.GOOGLE_GEMINI_BASE_URL);
    }
    return { key, baseUrl: baseUrl || GOOGLE_OPENAI_COMPAT_BASE, source };
}

function mapAgyUsage(u) {
    if (!u) return null;
    return toOpenAiUsage({
        input: Math.max(0, (u.input_tokens ?? 0) - (u.cache_read_tokens ?? 0)),
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_tokens ?? 0,
        reasoning: u.thinking_tokens ?? 0,
    });
}

const hasImage = (m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url');

function errorType(err) {
    if (err?.httpStatus === 429) return 'rate_limit_error';
    return err?.httpStatus && err.httpStatus < 500 ? 'invalid_request_error' : 'server_error';
}

async function runViaAgy({ messages, model, settings, writer, signal, allowApiKey }) {
    const { currentMessage } = splitConversation(messages);
    if (hasImage(currentMessage)) {
        throw Object.assign(new Error('Images are not supported through the Antigravity CLI (agy) backend. Switch the Gemini backend to "API" to send images, or remove the image.'), { httpStatus: 400 });
    }
    const omitted = (messages ?? []).filter(hasImage).length;
    if (omitted) console.warn(`${TAG} agy takes text only: ${omitted} earlier message(s) with images sent as "[image omitted]"`);

    await listGeminiModels({ live: false });
    const resolved = resolveGeminiModel(model, settings.gemini.effort, geminiCatalog());
    const prompt = foldConversation(messages, { includeSystem: true });
    const effortNote = resolved.agyEffort ? ` --effort ${resolved.agyEffort}` : (resolved.effort ? ` (effort ${resolved.effort})` : '');
    console.log(`${TAG} ${resolved.agyModel}${effortNote} via agy${allowApiKey ? ' (agy API-key mode)' : ''}`);

    const result = await runAgy({
        prompt,
        model: resolved.agyModel,
        effort: resolved.agyEffort,
        allowApiKey,
        signal,
        onText: (delta) => writer.pushText(delta),
        onReasoning: settings.showReasoning ? (delta) => writer.pushReasoning(delta) : undefined,
    });
    if (signal?.aborted) throw abortError();
    writer.flushTail();
    writer.finish({ usage: mapAgyUsage(result?.usage) });
}

async function runViaDirectApi({ messages, model, settings, writer, signal, creds }) {
    const resolved = resolveGeminiModel(model, settings.gemini.effort);
    const extraBody = {};
    if (resolved.effort) extraBody.reasoning_effort = resolved.effort;
    if (settings.maxTokens) extraBody.max_tokens = settings.maxTokens;
    if (settings.temperature !== undefined) extraBody.temperature = settings.temperature;
    if (settings.topP !== undefined) extraBody.top_p = settings.topP;
    if (settings.stops.length) extraBody.stop = settings.stops.slice(0, 4);
    let host = creds.baseUrl;
    try { host = new URL(creds.baseUrl).host; } catch { /* not a URL */ }
    // Google's endpoint knows bare ids only; other endpoints get the id as routed (google/… kept).
    const apiModel = host === GOOGLE_HOST ? agyModelId(resolved.apiModel) : resolved.apiModel;
    console.log(`${TAG} ${apiModel} via direct API (${creds.source} → ${host}${resolved.effort ? `, effort ${resolved.effort}` : ''})`);
    await runOpenAiCompat({ baseUrl: creds.baseUrl, apiKey: creds.key, model: apiModel, messages, extraBody, writer, signal, tag: TAG });
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
export async function runGeminiChat({ req, messages, model, settings, writer, signal }) {
    const backend = settings.gemini.backend;
    const cliAvailable = !!agyLaunchSpec();
    try {
        if (backend === 'api') {
            const creds = discoverGeminiApiCredentials(req);
            if (!creds) throw Object.assign(new Error('Gemini backend "API" selected but no key found: set GEMINI_API_KEY (plus GOOGLE_GEMINI_BASE_URL for a compatible endpoint), or paste the key into SillyTavern\'s Custom API key field (plus ST_SUBSCRIPTIONS_GEMINI_BASE_URL for a non-Google endpoint).'), { httpStatus: 400 });
            return await runViaDirectApi({ messages, model, settings, writer, signal, creds });
        }
        if (backend === 'subscription') {
            if (!cliAvailable) throw Object.assign(new Error('Antigravity CLI (agy) not found: install it from https://antigravity.google/cli and sign in by running `agy` once, or switch the Gemini backend to "API".'), { httpStatus: 400 });
            const billing = agyBilling();
            if (billing.subscriptionBlocked) throw Object.assign(new Error(billing.reason), { httpStatus: 400 });
            return await runViaAgy({ messages, model, settings, writer, signal, allowApiKey: false });
        }
        // auto: agy as it is configured; the API backend only without agy.
        if (cliAvailable) return await runViaAgy({ messages, model, settings, writer, signal, allowApiKey: agyBilling().apiKeyMode });
        const creds = discoverGeminiApiCredentials(req);
        if (creds) return await runViaDirectApi({ messages, model, settings, writer, signal, creds });
        throw Object.assign(new Error('Neither the Antigravity CLI (agy) nor a Gemini API key is available. Install agy and sign in, or set GEMINI_API_KEY.'), { httpStatus: 400 });
    } catch (err) {
        // Client gone or plugin stopping: nothing to send; the listener ends the response.
        if (signal?.aborted) return;
        console.error(`${TAG} request failed:`, err instanceof Error ? err.message : err);
        writer.fail(err, { status: err?.httpStatus ?? 500, type: errorType(err) });
    }
}
