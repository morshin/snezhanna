# TZ-1: Conversational Briefing + Silence Adaptation + Vacation Mode

## Goal

Replace the current one-way morning push with a value-gated consent dialogue.
Snezhanna checks whether there is anything worth saying → if yes, asks → waits for confirmation → sends the full briefing.
Silence is tracked and frequency is reduced automatically.
Hard alerts always break through regardless of silence state.

---

## 1. New appState Fields

Add to `DEFAULT_STATE` in `lib/state.js`:

```js
lastUserMessageAt: null,      // ISO timestamp — updated on every incoming user message
briefingPending: false,       // true = "Ready for briefing?" was sent, awaiting reply
briefingPendingAt: null,      // ISO timestamp when the pending question was sent
silenceLevel: 0,              // 0 | 1 | 2 — current throttle tier
silenceDaysCount: 0,          // consecutive days briefing question was ignored
quietUntil: null              // ISO timestamp — vacation mode end, null = not active
```

Update `lastUserMessageAt` in the existing user message handler in `index.js`, immediately after `isAllowed(msg)` check passes and before any other processing. Persist with `state.save(appState)`.

---

## 2. Value Check — `lib/briefing.js`

Add a new exported function `hasSomethingToSay()` that returns `true` if at least one of the following is found:

- **Calendar events today** — `google.getCalendarEvents(1)` returns ≥ 1 event with start date = today
- **Deadlines today or tomorrow** — `tasks.getTodayTasks(2)` returns ≥ 1 task where `due_date` ≤ tomorrow and status is `todo` or `in_progress`
- **Overdue Q1 tasks** — any task where `urgent=true`, `important=true`, `status` not done/cancelled, `due_date` < today
- **Emails needing a reply** — `google.getGmailMessages(20, true)` returns ≥ 1 message where subject or snippet contains a direct question mark or known reply-request patterns (simple heuristic: `?` in subject, or sender is not noreply/newsletter domain)

If none of the above: return `false`. All data fetches in `hasSomethingToSay()` must be wrapped in individual try/catch — a single source failure must not block the check; treat that source as empty on error.

---

## 3. Silence Level Calculation — `lib/briefing.js`

Add exported function `computeSilenceLevel(silenceDaysCount)`:

```
0–2 days  → level 0 (normal)
3–6 days  → level 1 (every other day)
7+ days   → level 2 (full silence, hard alerts only)
```

---

## 4. Morning Briefing Cron — `index.js`

Replace the existing `cron.schedule('0 8 * * *', ...)` handler body with the following logic:

### Step 1 — Vacation mode check
If `appState.quietUntil` is set and `new Date() < new Date(appState.quietUntil)`:
- Skip entirely. No message sent.
- Return.

If `appState.quietUntil` is set and has expired: clear it (`appState.quietUntil = null`), persist state, continue normally.

### Step 2 — Silence level check
Recompute: `appState.silenceLevel = computeSilenceLevel(appState.silenceDaysCount)`

If `silenceLevel === 2`: skip entirely, no message sent.

If `silenceLevel === 1`: only proceed on odd calendar days (use `new Date().getDate() % 2 === 1`).

### Step 3 — Pending flag check
If `appState.briefingPending === true` from yesterday:
- The question was ignored. Increment `appState.silenceDaysCount` by 1.
- Clear `appState.briefingPending = false`, `appState.briefingPendingAt = null`.
- Persist state.

### Step 4 — Value check
Call `hasSomethingToSay()`. If it returns `false`: skip, no message sent.

### Step 5 — Send the prompt question
Send to Vova:
```
Доброе утро! Как дела? Готов к брифингу? 🌅
```

Set `appState.briefingPending = true`, `appState.briefingPendingAt = new Date().toISOString()`. Persist state.

**Do not send the full briefing yet. Do not retry. No timeout.**

---

## 5. Briefing Reply Detection — `index.js` message handler

In the existing user message handler, add a check **before** the workload check-in intercept:

```
if appState.briefingPending === true:
    elapsed = now - new Date(appState.briefingPendingAt)
    if elapsed < 8 hours:
        if message looks like a positive reply (see below):
            clear briefingPending + briefingPendingAt
            reset silenceDaysCount = 0
            recompute silenceLevel = 0
            persist state
            send full briefing (existing briefing generation logic)
            return   ← do not pass to Claude
```

**Positive reply detection** — treat as "yes" if the message (lowercased, trimmed) matches any of:
`да`, `ага`, `го`, `давай`, `готов`, `yes`, `yep`, `ok`, `ок`, `конечно`, `погнали`, `+`, `👍`

If the message does not match positive reply patterns and `briefingPending` is true — do **not** clear the flag, pass the message to Claude as normal conversation.

If elapsed ≥ 8 hours: clear the flag silently (expired), treat as normal message.

---

## 6. Hard Alerts — Always Send

Hard alerts bypass all silence level and vacation checks. They are sent unconditionally.

### 6a. Calendar reminder (already exists — no change needed)
The existing `*/10 * * * *` cron that fires at the 28–32 minute mark before an event continues to work as-is. It is already unconditional.

### 6b. Deadline alert (new)
Add inside the existing `*/10 * * * *` cron handler, after the calendar reminder block:

Check once per day (use a `Set` stored in memory as `const alertedDeadlines = new Set()` at module scope, cleared at midnight via a `0 0 * * *` cron):

```
tasks = getTodayTasks(0)  ← due_date = today only, status todo/in_progress
for each task not in alertedDeadlines:
    alertedDeadlines.add(task.id)
    send: "📋 Вов, сегодня дедлайн: *{task.title}*" (Markdown)
```

Fire this check only once per day per task. Do not fire if the task was already completed.

### 6c. Email requiring reply (new)
In the existing `*/30 * * * *` email cron, after the existing new-message detection:

For each new message where the subject contains `?` or the snippet matches reply-request heuristic (same logic as `hasSomethingToSay`):
- Send immediately regardless of silence level:
  ```
  📬 Вов, похоже нужен ответ: *{subject}* — от {from}
  ```
- Mark as seen in `emailDigestSeenIds`.

Non-urgent new emails: only send digest if `silenceLevel === 0`. At `silenceLevel ≥ 1`: suppress email digest entirely; only hard-alert emails break through.

---

## 7. Evening Check-in — Disable Automatically

In the existing `cron.schedule('0 19 * * *', ...)` handler, add at the top:

```
if silenceLevel >= 1 → return immediately, no message sent
if quietUntil is active → return immediately
```

No other changes to check-in logic.

---

## 8. Return After Silence

In the user message handler, after updating `lastUserMessageAt`, add:

```
if appState.silenceDaysCount >= 3:
    was_silent = true
    days_away = appState.silenceDaysCount
    appState.silenceDaysCount = 0
    appState.silenceLevel = 0
    persist state

    if was_silent:
        build comeback digest (see below)
        send comeback digest
        ← then continue to normal Claude processing of the message
```

**Comeback digest** — assemble and send as a single message before Claude responds:

```
Вов, тебя не было {N} дней. Вот что накопилось:

📋 Просроченные задачи:
• {list of overdue tasks — title + due_date}

📅 Пропущенные события:
• {calendar events from the past N days}
```

If both lists are empty: skip the digest entirely (do not send a "nothing happened" message).
Fetch data with existing `tasks.getTodayTasks(0)` filtered to overdue, and `google.getCalendarEvents()` for past N days.

---

## 9. Vacation Mode — `/quiet` Command

In the user message handler, add a new command handler before the workload check-in intercept:

**Syntax:** `/quiet` or `/quiet N` where N is number of days (integer 1–30).

```
/quiet       → vacation for 3 days (default)
/quiet 7     → vacation for 7 days
/quiet 0     → cancel vacation mode immediately
```

**On `/quiet N`:**
- Set `appState.quietUntil = new Date(Date.now() + N * 86400000).toISOString()`
- Set `appState.silenceDaysCount = 0`, `appState.silenceLevel = 0`
- Persist state
- Reply: "Ок, ухожу в тишину до {date}. Хард-алерты (встречи, дедлайны) продолжу слать 🤫"

**On `/quiet 0`:**
- Clear `appState.quietUntil = null`
- Persist state
- Reply: "Вернулась! 👋"

Hard alerts (calendar reminders, deadline alerts, email reply alerts) are **not** suppressed during vacation mode.

---

## 10. Natural Language Vacation via Claude

In `IDENTITY.md` (or the system prompt), add to the tools/behavior section:

When Vova says something like "уйди на неделю", "не беспокой меня 3 дня", "тихий режим", "каникулы" — Snezhanna should call a new tool `set_quiet_mode` with `{ days: N }`.

Add to `lib/tools.js`:

```js
{
  name: 'set_quiet_mode',
  description: 'Set or cancel vacation/quiet mode. Use when Vova asks to be left alone for a period.',
  input_schema: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        description: 'Number of days for quiet mode. 0 = cancel quiet mode.',
        minimum: 0,
        maximum: 30
      }
    },
    required: ['days']
  }
}
```

Handler in `executeTool()`:
```js
case 'set_quiet_mode': {
  const days = input.days;
  if (days === 0) {
    appState.quietUntil = null;
    state.save(appState);
    return { success: true, message: 'Quiet mode cancelled' };
  }
  appState.quietUntil = new Date(Date.now() + days * 86400000).toISOString();
  appState.silenceDaysCount = 0;
  appState.silenceLevel = 0;
  state.save(appState);
  const until = new Date(appState.quietUntil).toLocaleDateString('ru-RU', { timeZone: config.timezone });
  return { success: true, message: `Quiet mode active until ${until}` };
}
```

---

## 11. Files Modified

| File | Changes |
|------|---------|
| `lib/state.js` | Add 5 new fields to `DEFAULT_STATE` |
| `lib/briefing.js` | Add `hasSomethingToSay()`, `computeSilenceLevel()` |
| `lib/tools.js` | Add `set_quiet_mode` tool definition and handler |
| `index.js` | Morning cron rewrite, message handler additions (lastUserMessageAt, briefing reply, comeback digest, /quiet command), evening cron guard, deadline alert in 10-min cron, email hard-alert in 30-min cron |
| `IDENTITY.md` | Add note: use `set_quiet_mode` when Vova asks for silence/vacation |

No new files required.

---

## Out of Scope (future TZs)

- Mini App settings UI for silence/vacation
- Per-source enable/disable (GitHub, Strava) in briefing
- SQLite migration of tasks
- Multi-mailbox support
