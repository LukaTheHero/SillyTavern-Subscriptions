import test from 'node:test';
import assert from 'node:assert/strict';

import { extractRequestSettings } from '../lib/settings.js';

test('defaults when nothing is sent', () => {
    const s = extractRequestSettings({});
    assert.equal(s.provider, undefined);
    assert.equal(s.showReasoning, true);
    assert.equal(s.claude.backend, 'subscription');
    assert.equal(s.claude.thinking, 'adaptive');
    assert.equal(s.claude.useResume, true);
    assert.equal(s.claude.fastMode, false);
    assert.equal(s.codex.backend, 'subscription');
    assert.equal(s.codex.serviceTier, 'standard');
    assert.equal(s.codex.reasoningSummary, 'auto');
    assert.equal(s.gemini.backend, 'subscription');
    assert.deepEqual(s.stops, []);
});

test('reads the unified subscriptions namespace', () => {
    const s = extractRequestSettings({
        max_tokens: 1234,
        stop: ['\nUser:', '\n{{user}}:'],
        subscriptions: {
            provider: 'codex',
            show_reasoning: false,
            claude: { backend: 'api', effort: 'max', thinking: 'on', thinking_budget: 5000, identity_mode: true, use_resume: false, fast_mode: true },
            codex: { backend: 'subscription', effort: 'ultra', service_tier: 'priority', reasoning_summary: 'detailed' },
            gemini: { backend: 'api', effort: 'low' },
        },
    });
    assert.equal(s.provider, 'codex');
    assert.equal(s.showReasoning, false);
    assert.equal(s.maxTokens, 1234);
    assert.deepEqual(s.stops, ['\nUser:', '\n{{user}}:']);
    assert.equal(s.claude.backend, 'api');
    assert.equal(s.claude.effort, 'max');
    assert.equal(s.claude.thinking, 'on');
    assert.equal(s.claude.thinkingBudget, 5000);
    assert.equal(s.claude.identityMode, true);
    assert.equal(s.claude.useResume, false);
    assert.equal(s.claude.fastMode, true);
    assert.equal(s.codex.backend, 'subscription');
    assert.equal(s.codex.effort, 'ultra');
    assert.equal(s.codex.serviceTier, 'priority');
    assert.equal(s.codex.reasoningSummary, 'detailed');
    assert.equal(s.gemini.backend, 'api');
    assert.equal(s.gemini.effort, 'low');
});

test('legacy namespaces from the old panels still work', () => {
    const s = extractRequestSettings({
        claude_subscription: { effort: 'xhigh', thinking: 'off', show_reasoning: false, identity_mode: true },
        codex_subscription: { effort: 'high', backend: 'cli' },
        gemini_subscription: { effort: 'medium', backend: 'agy' },
    });
    assert.equal(s.claude.effort, 'xhigh');
    assert.equal(s.claude.thinking, 'off');
    assert.equal(s.claude.identityMode, true);
    assert.equal(s.showReasoning, false);
    assert.equal(s.codex.effort, 'high');
    assert.equal(s.codex.backend, 'subscription');
    assert.equal(s.gemini.effort, 'medium');
    assert.equal(s.gemini.backend, 'subscription');
});

test('generic reasoning_effort feeds every provider where valid', () => {
    const s = extractRequestSettings({ reasoning_effort: 'high' });
    assert.equal(s.claude.effort, 'high');
    assert.equal(s.codex.effort, 'high');
    assert.equal(s.gemini.effort, 'high');
    const t = extractRequestSettings({ reasoning_effort: 'ultra' });
    assert.equal(t.claude.effort, undefined);
    assert.equal(t.codex.effort, 'ultra');
    assert.equal(t.gemini.effort, undefined);
});

test('invalid values fall back instead of erroring', () => {
    const s = extractRequestSettings({ subscriptions: { provider: 'bing', claude: { effort: 'turbo', thinking: 'maybe', backend: 'cloud' }, codex: { service_tier: 'warp' } } });
    assert.equal(s.provider, undefined);
    assert.equal(s.claude.effort, undefined);
    assert.equal(s.claude.thinking, 'adaptive');
    assert.equal(s.claude.backend, 'subscription');
    assert.equal(s.codex.serviceTier, 'standard');
});
