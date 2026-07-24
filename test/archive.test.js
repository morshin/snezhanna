'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Must run before any require that touches lib/db.js — points it at a
// throwaway file so this test never opens the live production database.
require('./helpers/temp-db').useTempDb();

const archive = require('../lib/archive');

test('buildMatchQuery: tokenizes and prefix-matches each word', () => {
  assert.equal(archive.buildMatchQuery('проект дедлайн'), '"проект"* OR "дедлайн"*');
});

test('buildMatchQuery: drops single-character tokens', () => {
  assert.equal(archive.buildMatchQuery('a bb c'), '"bb"*');
});

test('buildMatchQuery: empty or whitespace-only input returns null', () => {
  assert.equal(archive.buildMatchQuery(''), null);
  assert.equal(archive.buildMatchQuery('   '), null);
  assert.equal(archive.buildMatchQuery(undefined), null);
});

test('buildMatchQuery: strips quote characters so raw input cannot break FTS5 syntax', () => {
  assert.equal(archive.buildMatchQuery('test" OR 1=1--'), '"test"* OR "OR"* OR "1=1--"*');
});

test('buildMatchQuery: bare FTS5 keywords are quoted so they are treated as literal tokens', () => {
  assert.equal(archive.buildMatchQuery('OR AND NOT'), '"OR"* OR "AND"* OR "NOT"*');
});

test('archive.addEntry + search: round-trips content and matches by keyword', () => {
  archive.addEntry({
    source_type: 'owner_chat',
    from_name: 'шеф',
    content: 'Обсуждали проект Альфа-Ретейл и сроки сдачи',
    timestamp: new Date().toISOString()
  });
  archive.addEntry({
    source_type: 'email',
    chat_name: 'mail@example.com',
    from_name: 'Иван',
    subject: 'Проект Альфа-Ретейл',
    content: 'Договорились перенести дедлайн',
    timestamp: new Date(Date.now() - 86400000 * 60).toISOString()
  });

  const results = archive.search('альфа');
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.snippet.includes('Альфа')));
});

test('archive.addEntry: silently ignores empty content instead of throwing', () => {
  assert.equal(archive.addEntry({ source_type: 'owner_chat', content: '', timestamp: new Date().toISOString() }), null);
  assert.equal(archive.addEntry(null), null);
});

test('archive.search: source_type filter narrows results', () => {
  const emailOnly = archive.search('альфа', { source_type: 'email' });
  assert.ok(emailOnly.every(r => r.source_type === 'email'));
});

test('archive.search: no match returns an empty array, not an error', () => {
  assert.deepEqual(archive.search('этогоопределённонигденет'), []);
});

test('archive.search: empty/no query browses most recent entries instead of returning nothing', () => {
  archive.addEntry({
    source_type: 'monitored_chat',
    chat_name: 'Стройка',
    from_name: 'Прораб',
    content: 'Завтра привезут материалы',
    timestamp: new Date().toISOString()
  });

  const browsed = archive.search('', { source_type: 'monitored_chat', limit: 5 });
  assert.ok(browsed.length > 0);
  assert.ok(browsed.every(r => r.source_type === 'monitored_chat'));
  assert.ok(browsed[0].snippet.includes('Завтра привезут материалы'));
});

test('archive.search: browse mode (no query) still honors date_from filter', () => {
  const future = archive.search('', { date_from: '2999-01-01' });
  assert.deepEqual(future, []);
});

test('archive.search: bare-date date_to includes same-day entries with a time component', () => {
  const today = new Date().toISOString().slice(0, 10);
  archive.addEntry({
    source_type: 'monitored_chat',
    chat_name: 'SEALONG',
    from_name: 'Nan',
    content: 'Please advise the 2nd option',
    timestamp: new Date().toISOString()
  });

  // Regression: a bare "YYYY-MM-DD" date_to used to be compared lexically
  // against full ISO timestamps and lose to any same-day time-of-day,
  // silently excluding the entire current day from results.
  const results = archive.search('', { source_type: 'monitored_chat', date_to: today, limit: 50 });
  assert.ok(results.some(r => r.snippet.includes('Please advise the 2nd option')));
});

test('archive.search: bare-date date_from includes same-day entries', () => {
  const today = new Date().toISOString().slice(0, 10);
  const results = archive.search('', { source_type: 'monitored_chat', date_from: today, limit: 50 });
  assert.ok(results.some(r => r.snippet.includes('Please advise the 2nd option')));
});
