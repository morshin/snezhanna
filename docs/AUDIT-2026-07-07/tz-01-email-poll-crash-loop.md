# TZ-01: Fix crash loop on `email_poll_interval = 0`

**Source:** audit 2026-07 (`AUDIT-2026-07.md`), bug #1, severity 🔴 — **reproduced on a live runtime**.
**Effort:** ~1 evening.

## Problem

The onboarding wizard offers "📭 Не проверять" for email polling, which stores
`email_poll_interval = '0'` (`lib/onboarding.js:234`, `lib/onboarding.js:323`).
Nothing in the codebase handles a zero interval:

- `index.js:1724-1725` — `setupSchedules()` parses the setting and calls `scheduleEmailPoll(0)`.
- `index.js:479-483` — `scheduleEmailPoll()` builds the cron expression `*/0 * * * *`.
- node-cron **throws** on `*/0` ("`*/0` is a invalid expression for minute" — verified empirically).

The throw happens inside `main()` on startup → the process exits → systemd
(`Restart=always`, `RestartSec=10`) restarts it → it crashes again. Result:
a permanent crash loop starting from the **next restart after** the user picks
"Не проверять" (auto-update, Zhora restart, reboot — any of them triggers it).

Secondary exposure: `update_my_preferences` (`lib/tools.js:556`) constrains the
value with `enum: [15, 30, 60]`, but enum enforcement is model-side only — the
Anthropic API does not validate tool input against the schema, so a hallucinated
`0` (or `-5`, or a string) reaches `rescheduleEmailPoll()` unvalidated. The Mini
App settings API is a third write path with no validation.

## Solution

Make "0 = polling disabled" a first-class, valid state, and guard the scheduler
against all invalid input. Single choke point: `scheduleEmailPoll()`.

### 1. Guard in `scheduleEmailPoll()` (index.js)

```js
function scheduleEmailPoll(intervalMin) {
  if (emailCronJob) { emailCronJob.stop(); emailCronJob = null; }

  const interval = parseInt(intervalMin, 10);
  if (!Number.isInteger(interval) || interval <= 0) {
    console.log('[Schedule] Email poll disabled (interval:', intervalMin, ')');
    return;
  }
  // node-cron minute step must be 1..59; hourly+ intervals need a different expression
  const safe = Math.min(Math.max(interval, 5), 59);
  emailCronJob = cron.schedule(`*/${safe} * * * *`, runEmailPoll, { timezone: config.timezone });
  console.log(`[Schedule] Email poll scheduled every ${safe} min`);
}
```

Notes:
- Clamp lower bound to 5 min (protects API quota and token costs from a typo like `1`).
- `*/60` is also invalid in the minute field — clamp to 59 or special-case
  `interval >= 60` as `0 * * * *`. Either is acceptable; document the choice in code.
- `rescheduleEmailPoll()` needs no change (it delegates).

### 2. Reflect the disabled state in UX

- Onboarding summary (`lib/onboarding.js:347`): when interval is `0`, show
  «почта: не проверяется» instead of «каждые 0 мин».
- `update_my_preferences` handler (`lib/tools.js:1131-1132`): the truthiness
  check `if (input.email_poll_interval && ...)` silently ignores `0` — change to
  `if (input.email_poll_interval !== undefined)` so the user can *disable*
  polling conversationally, and update the tool description to state that `0`
  disables polling.
- Mini App settings API: validate on write (integer, `0` or `5..1440`), return
  400 otherwise.

### 3. Regression test

Add to the test scaffold (see TZ-06) — this bug is the canonical example of a
test that would have caught a release-blocking defect:

```js
test('scheduleEmailPoll tolerates 0, negative, NaN, string input', ...)
test('cron expression is never built with step < 1 or > 59', ...)
```

If TZ-06 is not implemented yet, at minimum add a startup self-check: wrap the
`setupSchedules()` call so one bad schedule logs an error instead of killing
`main()`.

## Acceptance criteria

1. Fresh onboarding, pick "📭 Не проверять", restart the service → bot starts
   cleanly, log shows `Email poll disabled`.
2. `journalctl -u snezhanna` shows no cron exceptions after restart with any
   stored value: `0`, `''`, `abc`, `-5`, `120`.
3. Telling the bot «не проверяй почту» disables polling without restart;
   «проверяй каждые 15 минут» re-enables it.
4. Existing instances with a stored `0` recover on next update without manual
   DB surgery.
