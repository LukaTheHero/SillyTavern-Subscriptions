// ──────────────────────────────────────────────
// Gemini provider — chat runner
// ──────────────────────────────────────────────
//
// backend = subscription → agy print mode (whatever account/provider the CLI
//                          is signed in to — including the LinkAPI toggle).
// backend = api          → direct OpenAI-compatible HTTP to
//                          GOOGLE_GEMINI_BASE_URL (default LinkAPI) with
//                          GEMINI_API_KEY / LINKAPI_ANTIGRAVITY_API_KEY.
// backend = auto         → agy when installed, else api when a key exists.

import { agyLaunchSpec, runAgy, readAntigravitySettings } from './agy.js';
import { resolveGeminiModel, listGeminiModels } from './models.js';
import { runOpenAiCompat } from '../common/openai-compat.js';
import { foldConversation, TEXT_ONLY_PREAMBLE } from '../common/messages.js';
import { toOpenAiUsage } from '../common/sse.js';
import { bearerFromRequest } from '../claude/env.js';

const TAG = '[subscriptions/gemini]';
const LINKAPI_DEFAULT_BASE = 'https://api.linkapi.ai';

export function discoverGeminiApiCredentials(req) {
    const settings = readAntigravitySettings();
    const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim().length > 0)?.trim();
    const fromHeader = bearerFromRequest(req);
    const key = pick(fromHeader, process.env.ST_SUBSCRIPTIONS_GEMINI_API_KEY, process.env.LINKAPI_ANTIGRAVITY_API_KEY, process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY, settings?.env?.GEMINI_API_KEY);
    if (!key) return null;
    let source = 'antigravity-settings';
    if (key === fromHeader) source = 'api-key-field';
    else if (key === process.env.ST_SUBSCRIPTIONS_GEMINI_API_KEY) source = 'ST_SUBSCRIPTIONS_GEMINI_API_KEY';
    else if (key === process.env.LINKAPI_ANTIGRAVITY_API_KEY) source = 'LINKAPI_ANTIGRAVITY_API_KEY';
    else if (key === process.env.GEMINI_API_KEY) source = 'GEMINI_API_KEY';
    else if (key === process.env.GOOGLE_API_KEY) source = 'GOOGLE_API_KEY';
    const baseUrl = pick(process.env.ST_SUBSCRIPTIONS_GEMINI_BASE_URL, process.env.GOOGLE_GEMINI_BASE_URL, settings?.env?.GOOGLE_GEMINI_BASE_URL) || LINKAPI_DEFAULT_BASE;
    return { key, baseUrl, source };
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

async function runViaAgy({ req, messages, model, settings, writer }) {
    const resolved = resolveGeminiModel(model, settings.gemini.effort ?? (['low', 'medium', 'high'].includes(settings.reasoningEffort) ? settings.reasoningEffort : undefined));
    const prompt = foldConversation(messages, { includeSystem: true, preamble: TEXT_ONLY_PREAMBLE });
    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.on('close', onClose);
    console.log(`${TAG} ${resolved.agyModel} via agy${resolved.effort ? ` (effort ${resolved.effort})` : ''}`);
    try {
        const result = await runAgy({
            prompt,
            model: resolved.agyModel,
            effort: resolved.effort,
            signal: ac.signal,
            onText: (delta) => writer.pushText(delta),
            onReasoning: settings.showReasoning ? (delta) => writer.pushReasoning(delta) : undefined,
        });
        writer.flushTail();
        writer.finish({ usage: mapAgyUsage(result?.usage) });
    } finally {
        req.off('close', onClose);
    }
}

async function runViaDirectApi({ req, messages, model, settings, writer, creds }) {
    const resolved = resolveGeminiModel(model, settings.gemini.effort);
    const extraBody = {};
    if (resolved.effort) extraBody.reasoning_effort = resolved.effort;
    if (settings.maxTokens) extraBody.max_tokens = settings.maxTokens;
    if (settings.temperature !== undefined) extraBody.temperature = settings.temperature;
    if (settings.topP !== undefined) extraBody.top_p = settings.topP;
    if (settings.stops.length) extraBody.stop = settings.stops.slice(0, 4);
    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.on('close', onClose);
    console.log(`${TAG} ${resolved.apiModel} via direct API (${creds.source}, ${creds.baseUrl}${resolved.effort ? `, effort ${resolved.effort}` : ''})`);
    try {
        await runOpenAiCompat({ baseUrl: creds.baseUrl, apiKey: creds.key, model: resolved.apiModel, messages, extraBody, writer, signal: ac.signal, tag: TAG });
    } finally {
        req.off('close', onClose);
    }
}

export async function runGeminiChat({ req, messages, model, settings, writer }) {
    const backend = settings.gemini.backend;
    const cliAvailable = !!agyLaunchSpec();
    const creds = discoverGeminiApiCredentials(req);
    try {
        await listGeminiModels({ live: false }).catch(() => {});
        if (backend === 'api') {
            if (!creds) throw Object.assign(new Error('Gemini backend "api" selected but no key found — set LINKAPI_ANTIGRAVITY_API_KEY / GEMINI_API_KEY (+ optional GOOGLE_GEMINI_BASE_URL) or paste the key into SillyTavern\'s Custom API key field.'), { httpStatus: 400 });
            return await runViaDirectApi({ req, messages, model, settings, writer, creds });
        }
        if (backend === 'subscription') {
            if (!cliAvailable) throw Object.assign(new Error('Antigravity CLI (agy) not found — install it from https://antigravity.google/cli and sign in by running `agy` once, or switch the Gemini backend to "api".'), { httpStatus: 400 });
            return await runViaAgy({ req, messages, model, settings, writer });
        }
        if (cliAvailable) return await runViaAgy({ req, messages, model, settings, writer });
        if (creds) return await runViaDirectApi({ req, messages, model, settings, writer, creds });
        throw Object.assign(new Error('Neither the Antigravity CLI (agy) nor a Gemini/LinkAPI key is available. Install agy and sign in, or set LINKAPI_ANTIGRAVITY_API_KEY / GEMINI_API_KEY.'), { httpStatus: 400 });
    } catch (err) {
        console.error(`${TAG} request failed:`, err instanceof Error ? err.message : err);
        writer.fail(err, { status: err.httpStatus ?? 500, type: err.httpStatus ? 'invalid_request_error' : 'server_error' });
    }
}
