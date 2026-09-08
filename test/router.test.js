import test from 'node:test';
import assert from 'node:assert/strict';

import { providerForModel, resolveProvider } from '../lib/router.js';

test('providerForModel recognises each family', () => {
    assert.equal(providerForModel('claude-fable-5-1'), 'claude');
    assert.equal(providerForModel('claude-opus-5[1m]'), 'claude');
    assert.equal(providerForModel('fable[1m]'), 'claude');
    assert.equal(providerForModel('gpt-6-astra'), 'codex');
    assert.equal(providerForModel('gpt-5.5'), 'codex');
    assert.equal(providerForModel('o3'), 'codex');
    assert.equal(providerForModel('codex-auto-review'), 'codex');
    assert.equal(providerForModel('gemini-3.8-flash-high'), 'gemini');
    assert.equal(providerForModel('models/gemini-3.1-pro'), 'gemini');
    assert.equal(providerForModel('llama-3'), null);
    assert.equal(providerForModel(''), null);
});

test('resolveProvider precedence: model > settings > path', () => {
    assert.deepEqual(resolveProvider({ model: 'gpt-5.5', pathProvider: 'claude', settingsProvider: 'gemini' }), { provider: 'codex', reason: 'model' });
    assert.deepEqual(resolveProvider({ model: 'mystery', pathProvider: 'claude', settingsProvider: 'gemini' }), { provider: 'gemini', reason: 'settings' });
    assert.deepEqual(resolveProvider({ model: 'mystery', pathProvider: 'claude' }), { provider: 'claude', reason: 'path' });
    assert.deepEqual(resolveProvider({ model: 'mystery' }), { provider: null, reason: 'unknown' });
});
