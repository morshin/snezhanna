'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitMessage } = require('../lib/message-utils');

const LIMIT = 4096;

test('splitMessage: short text stays a single chunk', () => {
  const chunks = splitMessage('hello world');
  assert.deepEqual(chunks, ['hello world']);
});

test('splitMessage: text exactly at the limit stays a single chunk', () => {
  const text = 'a'.repeat(LIMIT);
  const chunks = splitMessage(text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, LIMIT);
});

test('splitMessage: never emits a chunk over the limit', () => {
  const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i} `.repeat(50)).join('\n\n');
  const chunks = splitMessage(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= LIMIT, `chunk of length ${chunk.length} exceeds limit`);
});

test('splitMessage: a single huge paragraph with no breaks is still hard-split (regression: used to ship unsplit and fail at the Telegram API)', () => {
  const text = 'x'.repeat(LIMIT * 2 + 500);
  const chunks = splitMessage(text);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) assert.ok(chunk.length <= LIMIT);
  assert.equal(chunks.join(''), text);
});

test('splitMessage: reassembling chunks (joined by the same separators) reconstructs readable content', () => {
  const paragraphs = ['first paragraph', 'second paragraph', 'c'.repeat(LIMIT + 100)];
  const text = paragraphs.join('\n\n');
  const chunks = splitMessage(text);
  for (const chunk of chunks) assert.ok(chunk.length <= LIMIT);
  // every piece of original content shows up somewhere in the output
  const joined = chunks.join('\n\n');
  assert.ok(joined.includes('first paragraph'));
  assert.ok(joined.includes('second paragraph'));
});

test('splitMessage: unicode (Cyrillic) text splits without breaking characters', () => {
  const para = 'Привет, это тестовое сообщение для проверки разбиения. '.repeat(100);
  const text = [para, para, para].join('\n\n');
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= LIMIT);
    assert.ok(!chunk.includes('�')); // no mangled characters
  }
});
