'use strict';

// Persists the main conversation history across restarts (schema in lib/db.js:
// conversation_state, a single JSON blob row). Restarts are routine here — auto-
// updates, Zhora restarts, deploys — and without this the bot "forgets" the
// conversation every time one happens, with no signal to the user that it did.

const { db } = require('./db');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

// Returns [] on any missing/corrupt/oversized/stale state — never throws, so a
// bad row can never block startup.
function load() {
  try {
    const row = db.prepare('SELECT history, updated_at FROM conversation_state WHERE id = 1').get();
    if (!row) return [];

    const age = Date.now() - new Date(row.updated_at).getTime();
    if (!Number.isFinite(age) || age > MAX_AGE_MS) {
      console.log('[HistoryStore] Stored history is stale — starting fresh');
      return [];
    }

    const parsed = JSON.parse(row.history);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('[HistoryStore] Failed to load history:', e.message);
    return [];
  }
}

function save(history) {
  try {
    const json = JSON.stringify(history);
    if (json.length > MAX_BLOB_BYTES) {
      console.error(`[HistoryStore] History too large to persist (${json.length} bytes) — skipping save`);
      return;
    }
    db.prepare(`
      INSERT INTO conversation_state (id, history, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at
    `).run(json, new Date().toISOString());
  } catch (e) {
    console.error('[HistoryStore] Failed to save history:', e.message);
  }
}

function clear() {
  try {
    db.prepare('DELETE FROM conversation_state WHERE id = 1').run();
  } catch (e) {
    console.error('[HistoryStore] Failed to clear history:', e.message);
  }
}

module.exports = { load, save, clear };
