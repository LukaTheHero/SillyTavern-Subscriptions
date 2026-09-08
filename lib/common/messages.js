// ──────────────────────────────────────────────
// OpenAI messages[] helpers shared by every provider
// ──────────────────────────────────────────────
//
// Claude gets real multi-turn context through the Agent SDK's session resume
// (lib/claude/jsonl-entries.js). Codex and Gemini run through CLIs that take a
// single prompt per turn, so their history is *folded* into one labelled
// transcript. The fold is deliberately plain — clear speaker labels, the
// system prompt kept separate where the backend allows it (Codex
// baseInstructions), and a trailing-assistant "prefill" turned into an
// explicit continuation instruction (the closest CLI-side approximation of
// Messages-API prefill).

/** Flatten OpenAI content (string or multi-part array) to plain text. */
export function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n');
    }
    return '';
}

/** Extract and join system-role messages. */
export function extractSystemText(messages) {
    const parts = [];
    for (const m of messages ?? []) {
        if (m?.role !== 'system') continue;
        const text = contentToText(m.content);
        if (text.trim()) parts.push(text);
    }
    return parts.length ? parts.join('\n\n') : undefined;
}

/** True when any message carries image parts. */
export function hasImages(messages) {
    return (messages ?? []).some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url'));
}

/** Data-URL image parts of one message → [{ mediaType, data, url }]. */
export function imagePartsOf(content) {
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const p of content) {
        if (!p || p.type !== 'image_url') continue;
        const url = p.image_url?.url ?? '';
        const m = url.match(/^data:(image\/[^;]+);base64,([A-Za-z0-9+/]+=*)$/);
        if (m) out.push({ mediaType: m[1], data: m[2], url });
        else if (/^https?:\/\//i.test(url)) out.push({ mediaType: null, data: null, url });
    }
    return out;
}

/**
 * Closest CLI-side approximation of Messages-API assistant prefill. The
 * prefill text stays client-side (SillyTavern keeps it), so the synthetic turn
 * tells the model to continue after it rather than repeat it. The closing tag
 * inside the prefill is escaped to prevent tag breakout.
 */
export function buildPrefillContinuation(prefill) {
    const normalized = String(prefill ?? '').trimEnd();
    if (!normalized.trim()) return "Continue the assistant's reply.";
    const safe = normalized.replaceAll('</assistant_prefill>', '&lt;/assistant_prefill&gt;');
    return [
        "Continue the assistant's reply as if it already began with the prefill below.",
        'The prefill is already part of the assistant message, so do not repeat it.',
        'Start with the very next text that should follow it, preserving the same voice, format, and momentum.',
        '',
        '<assistant_prefill>',
        safe,
        '</assistant_prefill>',
    ].join('\n');
}

/**
 * Split messages into { system, history, current, prefill }:
 *  - system: joined system text (or undefined)
 *  - history: prior non-system turns (excluding the current one)
 *  - current: the final user/tool message text, or a continuation instruction
 *    when the conversation ends on an assistant turn (prefill / "continue")
 *  - prefill: the trailing assistant text when that case applies
 */
export function splitConversation(messages) {
    const system = extractSystemText(messages);
    const turns = (messages ?? []).filter((m) => m && m.role !== 'system');
    if (turns.length === 0) {
        return { system, history: [], current: '[Start]', prefill: null, currentMessage: null };
    }
    const last = turns[turns.length - 1];
    if (last.role === 'assistant') {
        const prefill = contentToText(last.content);
        return { system, history: turns.slice(0, -1), current: buildPrefillContinuation(prefill), prefill, currentMessage: null };
    }
    return { system, history: turns.slice(0, -1), current: contentToText(last.content) || '[Start]', prefill: null, currentMessage: last };
}

/**
 * Fold a conversation into a single prompt string for one-shot CLIs.
 *
 * @param {object[]} messages OpenAI messages
 * @param {object} [opts]
 * @param {boolean} [opts.includeSystem=true] inline the system prompt (false when the backend takes it separately)
 * @param {string}  [opts.preamble] extra instruction placed first (e.g. "text-only, no tools")
 * @param {string}  [opts.userLabel='User'] label for user turns
 * @param {string}  [opts.assistantLabel='Assistant'] label for assistant turns
 */
export function foldConversation(messages, opts = {}) {
    const { includeSystem = true, preamble, userLabel = 'User', assistantLabel = 'Assistant' } = opts;
    const { system, history, current, prefill } = splitConversation(messages);
    const sections = [];
    if (preamble) sections.push(preamble.trim());
    if (includeSystem && system) sections.push(`<system_instructions>\n${system}\n</system_instructions>`);

    const lines = [];
    for (const m of history) {
        const text = contentToText(m.content).trim();
        if (!text) continue;
        if (m.role === 'user' || m.role === 'tool') lines.push(`${userLabel}: ${text}`);
        else if (m.role === 'assistant') lines.push(`${assistantLabel}: ${text}`);
    }
    if (lines.length) sections.push(`<conversation_history>\n${lines.join('\n\n')}\n</conversation_history>`);

    if (prefill !== null) {
        sections.push(current);
    } else {
        sections.push(`${userLabel}: ${current}`);
        sections.push(`Reply as ${assistantLabel} only — one reply, in character, without speaking for ${userLabel}.`);
    }
    return sections.join('\n\n');
}

/** Roleplay-safe default instruction for CLIs that would otherwise use a coding preamble. */
export const TEXT_ONLY_PREAMBLE =
    'You are a conversational assistant inside a chat application. Reply with plain prose in the requested style. ' +
    'Do not use tools, do not run commands, do not browse, and do not create files — there is nothing to execute; ' +
    'just write the reply.';
