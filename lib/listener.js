// ──────────────────────────────────────────────
// Standalone HTTP listener (separate from SillyTavern's Express app)
// ──────────────────────────────────────────────
//
// SillyTavern wraps its entire Express app in CSRF protection. When its
// chat-completions backend issues a server-side fetch to the "Custom
// Endpoint" URL, that loopback request carries no CSRF token and is refused
// — so the OpenAI-compatible surface lives on its own port, outside ST's
// middleware stack.
//
// Routes (all also available under /claude, /codex and /gemini prefixes,
// which filter the model list to one provider):
//   GET  /status                 aggregate health (?deep=1 → account reads)
//   GET  /v1/models              unified model list
//   GET  /v1/usage/quota         Claude windows + Codex rate limits
//   POST /v1/chat/completions    chat (SSE + JSON) — routed by model id
//   POST /v1/embeddings          always 501
//
// GET routes carry loopback-only CORS so the companion UI extension can read
// them directly when SillyTavern is browsed on the same machine.

import express from 'express';

import { extractRequestSettings } from './settings.js';
import { resolveProvider, PROVIDERS, PROVIDER_LABELS } from './router.js';
import { CompletionWriter } from './common/completion.js';
import { splitConversation } from './common/messages.js';
import { unifiedModelList } from './models.js';
import { aggregateStatus, setListenerInfo } from './status.js';
import { runClaudeChat } from './claude/chat.js';
import { runCodexChat } from './codex/chat.js';
import { runGeminiChat } from './gemini/chat.js';
import { claudeQuota } from './claude/oauth.js';
import { codexRateLimits } from './codex/status.js';
import { claudeStatus } from './claude/status.js';
import { codexStatus } from './codex/status.js';
import { geminiStatus } from './gemini/status.js';

const TAG = '[subscriptions]';
let serverInstance = null;

function allowCorsGet(req, res, next) {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
}

const RUNNERS = { claude: runClaudeChat, codex: runCodexChat, gemini: runGeminiChat };
const STATUS = { claude: claudeStatus, codex: (o) => codexStatus(o), gemini: geminiStatus };

/** Shared chat handler; `pathProvider` comes from a /claude|codex|gemini prefix. */
export async function handleChatCompletions(req, res, pathProvider = null) {
    const body = req.body || {};
    const messages = body.messages;
    const model = body.model;
    if (!Array.isArray(messages) || messages.length === 0 || !model) {
        return res.status(400).json({ error: { message: 'messages[] (non-empty) and model are required', type: 'invalid_request_error' } });
    }

    const settings = extractRequestSettings(body);
    const { provider, reason } = resolveProvider({ model, pathProvider, settingsProvider: settings.provider });
    if (!provider) {
        return res.status(400).json({
            error: {
                message: `Cannot tell which subscription serves model "${model}". Use a model id from /v1/models ` +
                    '(claude-*, gpt-*/o*, gemini-*), connect through a provider prefix (/claude/v1, /codex/v1, /gemini/v1), ' +
                    'or send subscriptions.provider in the request body.',
                type: 'invalid_request_error',
            },
        });
    }

    const writer = new CompletionWriter({
        res,
        stream: body.stream === true,
        model: String(model),
        stops: settings.stops,
        showReasoning: settings.showReasoning,
        idPrefix: `chatcmpl-${provider}`,
    });
    const { prefill } = splitConversation(messages);
    if (prefill) writer.setPrefill(prefill);
    if (reason !== 'model') console.log(`${TAG} provider ${provider} chosen by ${reason} for model ${model}`);

    try {
        await RUNNERS[provider]({ req, messages, model: String(model), settings, writer });
    } catch (err) {
        console.error(`${TAG} unhandled ${provider} error:`, err);
        writer.fail(err instanceof Error ? err : new Error(String(err)));
    }
}

export function rejectEmbeddings(_req, res) {
    return res.status(501).json({
        error: {
            message: 'The Subscriptions proxy does not support embeddings. Configure a separate embedding source (OpenAI, Google, or local).',
            type: 'not_supported',
        },
    });
}

export async function handleStatus(req, res) {
    const deep = /^(1|true|yes)$/i.test(String(req.query?.deep ?? ''));
    res.json(await aggregateStatus({ deep }));
}

export async function handleQuota(req, res) {
    const deep = /^(1|true|yes)$/i.test(String(req.query?.deep ?? ''));
    const [claude, codex] = await Promise.all([
        claudeQuota().catch((e) => ({ ok: false, message: String(e?.message ?? e) })),
        codexRateLimits({ startServer: deep }).catch(() => null),
    ]);
    res.json({ ok: true, claude, codex, gemini: null, fetchedAt: Date.now() });
}

export async function handleModels(req, res, only = null) {
    try {
        const list = await unifiedModelList({ only });
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' } });
    }
}

export function buildApp() {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '100mb' }));

    app.get('/', allowCorsGet, (_req, res) => res.json({
        plugin: 'subscriptions',
        providers: PROVIDERS.map((p) => ({ id: p, label: PROVIDER_LABELS[p], endpoint: `/${p}/v1` })),
        endpoints: ['/status', '/v1/models', '/v1/usage/quota', '/v1/chat/completions'],
    }));
    app.get('/status', allowCorsGet, handleStatus);
    app.get('/v1/models', allowCorsGet, (req, res) => handleModels(req, res, null));
    app.get('/v1/usage/quota', allowCorsGet, handleQuota);
    app.options(['/status', '/v1/models', '/v1/usage/quota', '/:provider(claude|codex|gemini)/status', '/:provider(claude|codex|gemini)/v1/models'], allowCorsGet, (_req, res) => res.sendStatus(204));
    app.post('/v1/chat/completions', (req, res) => handleChatCompletions(req, res, null));
    app.post('/v1/embeddings', rejectEmbeddings);

    // Per-provider prefixes
    app.get('/:provider(claude|codex|gemini)/status', allowCorsGet, async (req, res) => {
        const deep = /^(1|true|yes)$/i.test(String(req.query?.deep ?? ''));
        res.json(await STATUS[req.params.provider]({ deep }));
    });
    app.get('/:provider(claude|codex|gemini)/v1/models', allowCorsGet, (req, res) => handleModels(req, res, req.params.provider));
    app.post('/:provider(claude|codex|gemini)/v1/chat/completions', (req, res) => handleChatCompletions(req, res, req.params.provider));
    app.post('/:provider(claude|codex|gemini)/v1/embeddings', rejectEmbeddings);

    return app;
}

export function startStandaloneListener({ port, host }) {
    if (serverInstance) return Promise.resolve(serverInstance);
    const app = buildApp();
    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            serverInstance = server;
            setListenerInfo({ host, port, running: true });
            console.log(`${TAG} standalone listener: http://${host}:${port}/v1 (per-provider: /claude/v1, /codex/v1, /gemini/v1)`);
            resolve(server);
        });
        server.on('error', (err) => {
            if (err && err.code === 'EADDRINUSE') {
                console.error(
                    `${TAG} port ${port} is already in use. If the old SillyTavern-ClaudeSubscription plugin is still installed in plugins/, ` +
                    'remove it (this plugin replaces it). Otherwise set ST_SUBSCRIPTIONS_PORT to a free port and update the Endpoint in the Subscriptions panel.',
                );
            } else {
                console.error(`${TAG} listener error:`, err);
            }
            reject(err);
        });
    });
}

export function stopStandaloneListener() {
    if (!serverInstance) return Promise.resolve();
    return new Promise((resolve) => {
        serverInstance.close(() => {
            serverInstance = null;
            setListenerInfo({ running: false });
            resolve();
        });
    });
}
