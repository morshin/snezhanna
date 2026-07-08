# TZ-05: Persist conversation history across restarts

**Source:** audit 2026-07, product weakness #1 for the "me + friends" scenario
("restart amnesia").
**Effort:** ~1 evening.

## Problem

The conversation history lives in a process-local array (`index.js:72`,
`let history = []`). Every restart wipes it — and restarts are *routine* in this
system: auto-updates (`update:run`), Zhora auto-restarts, deploys, crashes.
The user gets no signal that context was lost; the bot just stops remembering
the morning's conversation mid-day. For tenant instances this reads as "the bot
is dumb today", not "the service restarted".

Everything needed for persistence already exists: history entries are plain
JSON (`role`, `content`, optional `message_id` metadata), base64 photo payloads
are already replaced with lightweight placeholders after each turn
(`index.js:1010-1021`), and `sanitizeHistory()` (`index.js:77-117`) can repair
any half-written state on load.

## Solution

Persist the history array to SQLite as a single JSON blob; load + sanitize on
startup.

### 1. Storage

Reuse the existing key-value infrastructure — no new table needed if
`user_settings` is acceptable, but a dedicated table keeps the settings UI
clean and avoids size surprises:

```sql
CREATE TABLE IF NOT EXISTS conversation_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  history    TEXT NOT NULL,          -- JSON array
  updated_at TEXT DEFAULT (datetime('now'))
);
```

New module `lib/history-store.js`: `load()` → array (empty on missing/parse
error, never throws), `save(history)` → upsert row 1.

### 2. Save points (index.js)

Do **not** save on every push — one write per completed turn is enough:

- at the end of `_askClaude` after the final assistant reply is appended
  (`index.js:344`) and after the rollback path (`index.js:354`);
- after `message_id` back-fill on sent messages (`index.js:933,945,1024`) —
  or simply debounce: `saveSoon()` with a 2s timer, called from all mutation
  sites, flushed on `SIGTERM`/`SIGINT` (add handlers — systemd sends SIGTERM
  on stop, so a graceful flush covers the auto-update path).
- `/reset` (`index.js:695`) → clear the row too.

`better-sqlite3` is synchronous and the payload is bounded by
`history.max_messages` (40 messages, images already stripped) — a full-blob
write is a few ms; no need for per-row deltas.

### 3. Load on startup

```js
let history = sanitizeHistory(historyStore.load());
```

- `sanitizeHistory` already handles orphaned `tool_use`/`tool_result` from a
  mid-turn crash — this is why the blob approach is safe.
- Apply the existing trim rule (`history.max_messages`/`keep_last`) after load.
- Guard rail: if the stored blob exceeds a sanity cap (e.g. 2 MB), drop it and
  log — protects against a pathological tool_result that would then poison
  every future startup.

### 4. Staleness policy

Old context resurfacing after a long gap is worse than amnesia. On load, check
`updated_at`: if older than a threshold (suggest 24h, or reuse
`history.max_age_hours` as a new config key), start fresh and log. No user
notification needed — this matches the current behavior for long gaps.

### 5. Tutor bot — explicitly out of scope

`tutor/index.js` has its own in-memory session model with different semantics
(sessions auto-close after 30 min). Do not touch it here; file a follow-up if
desired.

## Acceptance criteria

1. Have a short conversation → `systemctl restart snezhanna` → ask a follow-up
   question that only makes sense with the prior context → the bot answers with
   full context.
2. Same test through the auto-update path (`update:run` button) — context
   survives update.sh's restart.
3. `/reset` clears history and the persisted row (verify via sqlite3).
4. Kill the process mid-tool-call (`kill -9` during a long tool round) →
   restart → no API 400s about orphaned tool_use; history was sanitized on load.
5. Stored history older than the staleness threshold is not loaded.
6. Photo-heavy conversations persist without base64 blobs in the DB
   (`SELECT length(history) FROM conversation_state` stays small).
