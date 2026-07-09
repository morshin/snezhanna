'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Must run before any require that touches lib/db.js — points it at a
// throwaway file so this test never opens the live production database.
require('./helpers/temp-db').useTempDb();

const { parseClassifierResponse, buildClassifierInput, CATEGORIES } = require('../lib/email-classifier');
const briefing = require('../lib/briefing');

test('parseClassifierResponse: accepts a plain JSON array of valid categories', () => {
  assert.deepEqual(
    parseClassifierResponse('["info","reply_needed","task"]', 3),
    ['info', 'reply_needed', 'task']
  );
});

test('parseClassifierResponse: strips markdown fences', () => {
  assert.deepEqual(
    parseClassifierResponse('```json\n["event","update"]\n```', 2),
    ['event', 'update']
  );
});

test('parseClassifierResponse: rejects wrong length', () => {
  assert.equal(parseClassifierResponse('["info"]', 2), null);
  assert.equal(parseClassifierResponse('["info","info","info"]', 2), null);
});

test('parseClassifierResponse: rejects unknown categories', () => {
  assert.equal(parseClassifierResponse('["spam"]', 1), null);
  assert.equal(parseClassifierResponse('["INFO"]', 1), null);
});

test('parseClassifierResponse: rejects non-array JSON and garbage', () => {
  assert.equal(parseClassifierResponse('{"category":"info"}', 1), null);
  assert.equal(parseClassifierResponse('вот категории: info', 1), null);
  assert.equal(parseClassifierResponse('', 0), null);
  assert.equal(parseClassifierResponse(null, 0), null);
});

test('buildClassifierInput: numbers messages, collapses whitespace, truncates body', () => {
  const input = buildClassifierInput([
    { from: 'a@b.c', subject: 'Hi', body: 'line1\nline2   line3' },
    { from: '', subject: '', body: 'x'.repeat(1000) }
  ]);
  assert.match(input, /^1\. От: a@b\.c/);
  assert.match(input, /Текст: line1 line2 line3/);
  assert.match(input, /2\. От: \?/);
  assert.match(input, /Тема: \(без темы\)/);
  // body truncated to 400 chars
  assert.equal(input.includes('x'.repeat(401)), false);
  assert.equal(input.includes('x'.repeat(400)), true);
});

test('CATEGORIES matches the digest/actionable vocabulary', () => {
  assert.deepEqual(CATEGORIES, ['reply_needed', 'event', 'task', 'update', 'info']);
});

test('looksLikeReplyRequest: classifier verdict wins over the "?" heuristic', () => {
  // classified reply_needed without any "?" — heuristic alone would say false
  assert.equal(briefing.looksLikeReplyRequest({ classified: true, needsReply: true, subject: 'Re: договор' }), true);
  // classified info with "?" in subject — heuristic alone would say true
  assert.equal(briefing.looksLikeReplyRequest({ classified: true, needsReply: false, from: 'maria@x.com', subject: 'Вопрос?' }), false);
});

test('looksLikeReplyRequest: unclassified messages keep the old heuristic', () => {
  assert.equal(briefing.looksLikeReplyRequest({ from: 'maria@x.com', subject: 'Are we on for tomorrow?' }), true);
  assert.equal(briefing.looksLikeReplyRequest({ from: 'noreply@x.com', subject: 'Any questions?' }), false);
});
