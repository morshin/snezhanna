'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeHistory, trimHistory } = require('../lib/history-utils');

test('sanitizeHistory: passes through a clean history unchanged', () => {
  const hist = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ];
  assert.deepEqual(sanitizeHistory(hist), hist);
});

test('sanitizeHistory: empty history stays empty', () => {
  assert.deepEqual(sanitizeHistory([]), []);
});

test('sanitizeHistory: drops a trailing orphaned tool_use (no matching tool_result)', () => {
  const hist = [
    { role: 'user', content: 'do a thing' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} }] }
  ];
  const out = sanitizeHistory(hist);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

test('sanitizeHistory: drops an orphaned tool_result with no preceding tool_use', () => {
  const hist = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] }
  ];
  const out = sanitizeHistory(hist);
  assert.equal(out.length, 2);
  assert.equal(out[1].content, 'hello');
});

test('sanitizeHistory: keeps a properly matched tool_use/tool_result pair', () => {
  const hist = [
    { role: 'user', content: 'do a thing' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
    { role: 'assistant', content: 'done' }
  ];
  assert.deepEqual(sanitizeHistory(hist), hist);
});

test('trimHistory: no-op when under the max', () => {
  const hist = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  assert.deepEqual(trimHistory(hist, 40, 30), hist);
});

test('trimHistory: never starts the trimmed slice on an assistant message', () => {
  const hist = [];
  for (let i = 0; i < 50; i++) {
    hist.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` });
  }
  const trimmed = trimHistory(hist, 40, 30);
  assert.equal(trimmed[0].role, 'user');
});

test('trimHistory: never starts the trimmed slice on an orphaned tool_result', () => {
  const hist = [];
  for (let i = 0; i < 45; i++) {
    hist.push({ role: 'user', content: `msg${i}` });
    hist.push({ role: 'assistant', content: `reply${i}` });
  }
  // Force the natural cut point onto a tool_result-shaped user message
  const cutIdx = hist.length - 30;
  hist[cutIdx] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] };
  const trimmed = trimHistory(hist, 40, 30);
  const first = trimmed[0];
  const firstIsToolResult = first.role === 'user' && Array.isArray(first.content) &&
    first.content.some(b => b.type === 'tool_result');
  assert.equal(firstIsToolResult, false);
});
