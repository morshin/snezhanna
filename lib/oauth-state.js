'use strict';

// Opaque, single-use tokens threaded through the Google OAuth redirect flow.
// Solves two problems at once:
// 1. Anti-CSRF — the callback (lib/api.js, /auth/google/callback) refuses any
//    request whose `state` isn't one we handed out ourselves.
// 2. Routing — the callback is shared by every OAuth purpose (main account,
//    per-mailbox account linking); `state` tells it which one this code is for,
//    so linking a second Gmail account can no longer overwrite the main
//    token.json.

const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const pending = new Map(); // state -> { purpose: 'main' | 'account', accountId, createdAt }

// Abandoned states (auth flow never completed) would otherwise live until restart.
function pruneExpired() {
  const now = Date.now();
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) pending.delete(state);
  }
}

function createAuthState(purpose, accountId = null) {
  pruneExpired();
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { purpose, accountId, createdAt: Date.now() });
  return state;
}

// One-time use: returns { purpose, accountId } if the state is known and not
// expired, else null. Always deletes on lookup so a state can't be replayed.
function consumeAuthState(state) {
  if (!state) return null;
  const entry = pending.get(state);
  if (!entry) return null;
  pending.delete(state);
  if (Date.now() - entry.createdAt > TTL_MS) return null;
  return entry;
}

module.exports = { createAuthState, consumeAuthState };
