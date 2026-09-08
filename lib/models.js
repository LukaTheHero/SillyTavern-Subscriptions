// ──────────────────────────────────────────────
// Unified /v1/models
// ──────────────────────────────────────────────
//
// One list, three subscriptions. A provider's models appear when that
// provider is *usable* on this host (its CLI is installed, or an API key for
// its overflow relay exists), so a machine without Codex does not advertise
// GPT models that would only error. The per-provider prefixes (/claude/v1 …)
// always list their own provider regardless — that is how the panel's
// "Connect: Claude only" scope works.

import { listClaudeModels } from './claude/models.js';
import { claudeCliSummary } from './claude/sdk-loader.js';
import { credentialSummary } from './claude/oauth.js';
import { apiCredentialSummary } from './claude/auth.js';
import { codexModelEntries } from './codex/models.js';
import { codexLaunchSpec } from './codex/app-server.js';
import { discoverCodexApiCredentials } from './codex/chat.js';
import { geminiModelEntries } from './gemini/models.js';
import { agyLaunchSpec } from './gemini/agy.js';
import { discoverGeminiApiCredentials } from './gemini/chat.js';
import { envFlag } from './common/platform.js';

const TAG = '[subscriptions]';

/** Cheap usability checks (no subprocesses, no network). */
export function providerUsability() {
    const claudeCli = claudeCliSummary();
    return {
        claude: !!claudeCli.path && (credentialSummary().present || apiCredentialSummary().available),
        codex: !!codexLaunchSpec() || !!discoverCodexApiCredentials(null),
        gemini: !!agyLaunchSpec() || !!discoverGeminiApiCredentials(null),
    };
}

/**
 * @param {object} [opts]
 * @param {'claude'|'codex'|'gemini'|null} [opts.only] restrict to one provider (path prefix)
 * @param {boolean} [opts.live] allow live catalog refreshes (spawns CLIs) — default true
 */
export async function unifiedModelList({ only = null, live = true } = {}) {
    const usable = providerUsability();
    const forceAll = envFlag('ST_SUBSCRIPTIONS_LIST_ALL_MODELS', false);
    const want = (p) => only ? only === p : (forceAll || usable[p]);
    const data = [];

    if (want('claude')) data.push(...listClaudeModels());

    if (want('codex')) {
        try {
            data.push(...await codexModelEntries({ live: live && !!codexLaunchSpec() }));
        } catch (err) {
            console.warn(`${TAG} codex model list failed: ${err instanceof Error ? err.message : err}`);
        }
    }

    if (want('gemini')) {
        try {
            data.push(...await geminiModelEntries({ live: live && !!agyLaunchSpec() }));
        } catch (err) {
            console.warn(`${TAG} gemini model list failed: ${err instanceof Error ? err.message : err}`);
        }
    }

    return { object: 'list', data, providers: usable };
}
