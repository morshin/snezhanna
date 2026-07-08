'use strict';

// In-memory registry of emails prepared by Claude but not yet sent.
// A send only happens when the owner clicks the Telegram confirmation button
// (index.js callback_query handler) — nothing in the tool-call path can send.
// Restart drops all pending entries, which fails safe (nothing gets sent).

const crypto = require('crypto');

const TTL_MS = 15 * 60 * 1000;
const pending = new Map(); // id -> { account_id, to, subject, body, in_reply_to, createdAt }

function register(payload) {
  const id = crypto.randomBytes(6).toString('hex');
  pending.set(id, { ...payload, createdAt: Date.now() });
  return id;
}

// One-time use: returns the entry (and removes it) if present and not expired, else null.
function consume(id) {
  const entry = pending.get(id);
  if (!entry) return null;
  pending.delete(id);
  if (Date.now() - entry.createdAt > TTL_MS) return null;
  return entry;
}

module.exports = { register, consume };
