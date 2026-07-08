'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Must run before any require that touches lib/db.js — points it at a
// throwaway file so this test never opens the live production database.
require('./helpers/temp-db').useTempDb();

const mailManager = require('../lib/mail-manager');
const imap = require('../lib/imap');

test('imap.needsReply: no-reply senders never need a reply, even with "?" in the subject', () => {
  assert.equal(imap.needsReply('newsletter@example.com', 'Any questions?'), false);
  assert.equal(imap.needsReply('no-reply@example.com', 'Verify your account?'), false);
});

test('imap.needsReply: a "?" in the subject from a real sender needs a reply', () => {
  assert.equal(imap.needsReply('maria@example.com', 'Are we still on for tomorrow?'), true);
});

test('imap.needsReply: no "?" anywhere means no reply needed', () => {
  assert.equal(imap.needsReply('maria@example.com', 'Meeting notes attached'), false);
});

test('imap.needsReply: empty from/subject does not throw', () => {
  assert.equal(imap.needsReply('', ''), false);
  assert.equal(imap.needsReply(undefined, undefined), false);
});

test('mail-manager.categorize: needsReply flag wins over subject keywords', () => {
  const account = { account_type: 'personal' };
  assert.equal(mailManager.categorize({ needsReply: true, subject: 'встреча завтра' }, account), 'reply_needed');
});

test('mail-manager.categorize: recognizes event/task/update keywords in Russian and English', () => {
  const account = { account_type: 'personal' };
  assert.equal(mailManager.categorize({ subject: 'Встреча в 15:00' }, account), 'event');
  assert.equal(mailManager.categorize({ subject: 'Zoom call tomorrow' }, account), 'event');
  assert.equal(mailManager.categorize({ subject: 'Задача: подготовить отчёт' }, account), 'task');
  assert.equal(mailManager.categorize({ subject: 'Weekly status update' }, account), 'update');
});

test('mail-manager.categorize: falls back to info for anything unrecognized', () => {
  const account = { account_type: 'personal' };
  assert.equal(mailManager.categorize({ subject: 'random subject line' }, account), 'info');
});
