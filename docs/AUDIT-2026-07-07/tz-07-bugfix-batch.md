# TZ-07: Confirmed-bug fix batch (small fixes, one release)

**Source:** audit 2026-07, bugs #2, #4, #5, #6, #7, #9. Each fix is small and
independent; batching them into one release keeps tenant updates cheap.
**Effort:** ~2 evenings total.

---

## 7.1 `get_emails` without `account_id` reads only the first mailbox

**Where:** `lib/tools.js:757-765`. The tool description promises "all
mailboxes", the code takes `LIMIT 1` — Claude confidently reports "no new mail"
for every other account.

**Fix:** loop over all enabled accounts, aggregate with account attribution:

```js
const accounts = db.prepare("SELECT id, label FROM email_accounts WHERE enabled = 1").all();
if (!accounts.length) return { messages: [], note: 'No email accounts configured' };
const perAccount = Math.max(5, Math.floor((input.max_results || 20) / accounts.length));
const results = [];
for (const acc of accounts) {
  try {
    const msgs = await mailManager.getMessages(acc.id, perAccount, true);
    for (const m of (msgs.messages || msgs)) results.push({ ...m, account_id: acc.id, account: acc.label });
  } catch (e) {
    results.push({ account_id: acc.id, account: acc.label, error: e.message });
  }
}
return { messages: results };
```

One failing account must not hide the others (per-account try/catch, error
surfaced in the result). Every returned message must carry `account_id` so
follow-up `read_email`/`mark_email_read` calls have it.

**Acceptance:** two accounts configured, unread mail only in the second →
«что нового в почте?» reports it.

---

## 7.2 Telegram checklist completes the wrong task

**Where:** `index.js:1042-1064`. `checklist_tasks_done` positions are mapped to
`tasks.getTodayTasks()` **at click time**; if the task list changed since the
checklist was sent (task added/completed/deleted), the index points at a
different task.

**Fix:** snapshot the mapping at send time. Where the evening checklist is
built, store `checklistTaskMap = { [position]: taskId }` (in `appState` via
`lib/state.js`, keyed by the checklist `message_id` if available, so stale
checklists resolve correctly). The `checklist_tasks_done` handler resolves
`position → taskId` from the snapshot and calls
`tasks.completeTask({ id })`; unknown position → log and skip. Completing an
already-completed/deleted task must be a no-op, not an error.

**Acceptance:** send checklist → complete task #2 via chat → tick item #3 in
the checklist → the task that was #3 *when the checklist was sent* is completed.

---

## 7.3 Message sending fails at >4096 chars

**Where:** `index.js:518` — `if (Object.keys(options).length > 0 || text.length <= 4096)`
sends oversized text in one `sendMessage` whenever *any* option is present
(e.g. `disable_notification` added at `index.js:516` for off-hours urgent
messages) → Telegram 400. Also `sendLongMessage` (`index.js:1213-1243`) splits
by paragraph but never hard-splits a single paragraph >4096.

**Fix:**
- Extract pure `splitMessage(text, limit = 4096)` (see TZ-06 §1): split on
  `\n\n`, then `\n`, then hard-cut — never emit a chunk over the limit.
- `sendToUser`: always split when `text.length > 4096`; apply `options` to the
  **last** chunk (buttons belong at the end; `disable_notification` can go on
  all chunks).

**Acceptance:** unit tests from TZ-06 §4.4 pass; a >4096-char urgent message
off-hours (options path) is delivered as multiple messages, no 400 in logs.

---

## 7.4 Zhora doesn't actually monitor Max

**Where:** `watchdog/zhora.js:96` — `{ name: 'Макс', unit: 'tutor', disabled: true }`
hardcoded, while README/CLAUDE.md promise monitoring of both bots.

**Fix:** drive it from env instead of a hardcode: `WATCHDOG_UNITS` (comma list,
default `snezhanna,tutor`) or a simple `TUTOR_DISABLED=1` opt-out. Instances
without the tutor bot set the opt-out in `.env` (deploy.sh asks). Remove
`disabled: true`. Update docs to match reality either way.

**Acceptance:** `systemctl stop tutor` → within 5 min Zhora restarts it and
reports; morning report lists both services.

---

## 7.5 Briefing "yes" detection is exact-match

**Where:** `index.js:743-754`. «да, давай», «го, только кофе налью» don't match
`POSITIVE_REPLIES`, the message falls through to normal Claude processing, and
`briefingPending` keeps hanging.

**Fix (two layers, no extra API call in the common case):**
1. Token match instead of whole-string match: normalize (lowercase, strip
   punctuation), split into words, positive if **any** of the first ~3 tokens is
   in `POSITIVE_REPLIES`. Add a small negative list («нет», «не», «потом»,
   «позже», «не сейчас») checked first — a negative clears
   `briefingPending` politely («ок, без брифинга») instead of leaving it armed.
2. Fallback for everything else while `briefingPending`: prepend a note to the
   Claude message («пользователю предложен утренний брифинг; если это ответ-согласие —
   вызови инструмент `start_briefing`») and add a trivial `start_briefing` tool
   that flips the same state and triggers `sendMorningBriefingFull`. This makes
   the LLM the intent classifier — the pattern the audit recommends over
   substring heuristics generally (same disease as the workload intercept at
   `index.js:805-839`; fixing that one the same way is optional stretch scope).

**Acceptance:** «да, давай», «ну го», «давай через 5 минут» (→ briefing or a
sensible reply, not a dangling state), «нет, не сейчас» (→ pending cleared).

---

## 7.6 Slow leaks

**Where / fix:**

1. `notifiedEvents` Set (`index.js:1677`) grows forever → on each reminder
   tick, drop entries whose event start time is in the past (store
   `eventId → startTs` in a Map instead of a bare Set), or simply
   `clear()` once a day at 03:30 alongside the backup job.
2. `email_seen` table grows forever (`lib/mail-manager.js`) → in the daily
   backup job: `DELETE FROM email_seen WHERE seen_at < datetime('now', '-90 days')`
   (add `seen_at` column if missing; default `datetime('now')` for new rows,
   backfill old rows with today's date — worst case a 90-day-old message
   re-digests once).
3. Refreshed Google access tokens are never persisted (`lib/google.js:28-34`) —
   every call after expiry pays a refresh round-trip. In `getAuth()`:

   ```js
   auth.on('tokens', (tokens) => {
     const current = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
     fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...current, ...tokens }), { mode: 0o600 });
   });
   ```

   (Keep the existing `refresh_token` — Google omits it on refresh responses.)

**Acceptance:** after 24h of uptime, `notifiedEvents` size ≤ today's event
count; `email_seen` row count stable week-over-week; journal shows at most one
token refresh per hour, not one per call.

---

## Ordering & release

Suggested order within the batch: 7.3 (prereq shared with TZ-06) → 7.1 → 7.2 →
7.5 → 7.4 → 7.6. Ship as one minor release; each item gets a CHANGELOG line
referencing the audit bug number.
