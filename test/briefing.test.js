'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Must run before any require that touches lib/db.js (briefing.js -> tasks.js -> db.js)
require('./helpers/temp-db').useTempDb();

const briefing = require('../lib/briefing');

test('computeSilenceLevel: 0-2 days is normal (level 0)', () => {
  assert.equal(briefing.computeSilenceLevel(0), 0);
  assert.equal(briefing.computeSilenceLevel(2), 0);
});

test('computeSilenceLevel: 3-6 days is reduced frequency (level 1)', () => {
  assert.equal(briefing.computeSilenceLevel(3), 1);
  assert.equal(briefing.computeSilenceLevel(6), 1);
});

test('computeSilenceLevel: 7+ days is full silence (level 2)', () => {
  assert.equal(briefing.computeSilenceLevel(7), 2);
  assert.equal(briefing.computeSilenceLevel(30), 2);
});

test('looksLikeReplyRequest: "?" in subject from a real sender is a reply request', () => {
  assert.equal(briefing.looksLikeReplyRequest({ from: 'maria@example.com', subject: 'Are you free Friday?' }), true);
});

test('looksLikeReplyRequest: "?" in snippet also counts', () => {
  assert.equal(briefing.looksLikeReplyRequest({ from: 'maria@example.com', snippet: 'Quick question?' }), true);
});

test('looksLikeReplyRequest: no-reply/newsletter senders are never a reply request, even with "?"', () => {
  assert.equal(briefing.looksLikeReplyRequest({ from: 'newsletter@example.com', subject: 'Enjoying our service?' }), false);
  assert.equal(briefing.looksLikeReplyRequest({ from: 'bounce@mailer.example.com', subject: 'Delivery failed?' }), false);
});

test('looksLikeReplyRequest: no "?" anywhere is not a reply request', () => {
  assert.equal(briefing.looksLikeReplyRequest({ from: 'maria@example.com', subject: 'Meeting notes' }), false);
});

test('looksLikeReplyRequest: null/undefined message is handled without throwing', () => {
  assert.equal(briefing.looksLikeReplyRequest(null), false);
  assert.equal(briefing.looksLikeReplyRequest(undefined), false);
});
