'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// google.js only touches the network inside async functions we don't call here;
// requiring it and calling the pure extractAuthCode() does no I/O.
const google = require('../lib/google');

test('extractAuthCode: bare code passes through', () => {
  assert.equal(google.extractAuthCode('4/0AY0e-g7abc123'), '4/0AY0e-g7abc123');
});

test('extractAuthCode: full redirect URL extracts the code param', () => {
  const url = 'https://bot.example.com/auth/google/callback?code=4%2F0AY0e-g7abc123&scope=foo';
  assert.equal(google.extractAuthCode(url), '4/0AY0e-g7abc123');
});

test('extractAuthCode: trims surrounding whitespace', () => {
  assert.equal(google.extractAuthCode('  somecode  '), 'somecode');
});

test('extractAuthCode: garbage input falls back to decoded raw string', () => {
  assert.equal(google.extractAuthCode('not a url just text'), 'not a url just text');
});
