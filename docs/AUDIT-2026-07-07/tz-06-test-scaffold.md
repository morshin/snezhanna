# TZ-06: Minimal test scaffold + update gate

**Source:** audit 2026-07, product weakness #2 ("no tests + auto-updates at
tenants = a regression ships to everyone at once").
**Effort:** ~2 evenings for the scaffold + first ~20 tests; then incremental.

## Problem

248 commits, releases every few days, tenants on auto-update — and zero
automated tests. The blast radius of a regression is every instance at once,
and debugging a friend's VPS is far more expensive than your own. Bug #1 of the
audit (crash loop on `email_poll_interval = 0`, TZ-01) is exactly the class a
trivial unit test catches.

The obstacle is structural, not tooling: most pure logic lives inside
`index.js` (1849 lines) where it can't be imported without side effects
(Telegram polling starts on require).

## Solution

`node:test` + `node:assert` — zero new dependencies, ships with Node ≥ 18.

### 1. Extract testable pure functions

Move (not rewrite) out of `index.js` into small modules; `index.js` requires
them back. Candidates, in value order:

| Function | From | To |
|---|---|---|
| `sanitizeHistory()` | `index.js:77-117` | `lib/history-utils.js` (shared with TZ-05) |
| history trim logic (`sliceAt` loop) | `index.js:216-229` | `lib/history-utils.js` |
| `scheduleEmailPoll` interval validation | `index.js:479` | extract `normalizePollInterval(raw)` → `lib/schedule-utils.js` |
| `sendLongMessage` splitting | `index.js:1213-1243` | extract pure `splitMessage(text, limit)` |
| `extractGoogleCode()` | `index.js` | `lib/google.js` or utils |
| `isWithinWorkHours` core (given now + bounds) | `index.js:496-503` | pure function taking `nowStr` |

Already-importable pure logic to cover without refactoring:
`lib/briefing.js` (`computeSilenceLevel`, `looksLikeReplyRequest`),
`lib/mail-manager.js` `categorize()`, `lib/imap.js` `needsReply()`,
`lib/settings.js` settings-block building (with an in-memory DB),
`lib/skills.js` `buildSkillsBlock()`, `lib/reply-chain.js`.

Rule of thumb: **no mocks, no network, no Telegram** — if a test needs them,
it's out of scope for this scaffold.

### 2. Layout & runner

```
test/
  history-utils.test.js
  schedule-utils.test.js
  split-message.test.js
  briefing.test.js
  mail-categorize.test.js
  ...
```

`package.json`:

```json
"scripts": { "test": "node --test test/" }
```

DB-touching tests (settings) use `better-sqlite3` `:memory:` via the existing
`database.path` config override or a `DB_PATH` env var — check what `lib/db.js`
allows and add an env override if needed.

### 3. Gate update.sh on tests

The point of the scaffold is protecting tenants from bad releases:

- `scripts/update.sh`: after `git pull`/checkout + `npm ci`, run `npm test`.
  Non-zero exit → **abort the update and roll back** to the previous version
  (update.sh already has the re-exec/rollback machinery — wire into it), and
  report «обновление отменено: тесты не прошли» to the owner via the existing
  post-update Telegram report path.
- `deploy.sh`: run `npm test` after install, warn (not abort) on failure.
- Optional but cheap: GitHub Actions workflow running `npm test` on push —
  catches it before a release is even cut. `/release` skill should refuse to
  cut a release with failing tests.

### 4. Seed test list (~20)

1. `normalizePollInterval`: `0`, `'0'`, `-5`, `NaN`, `'abc'`, `15`, `'30'`, `120` (TZ-01 regression).
2. `sanitizeHistory`: orphaned tool_use at tail; orphaned tool_result at head; empty; already-clean.
3. Trim logic: never starts on assistant; never orphans tool_result; respects keep_last.
4. `splitMessage`: text > 4096 with no paragraph breaks; single 10k-char paragraph; exact-4096; unicode.
5. `categorize` / `needsReply`: noreply senders, `?` in subject, empty fields.
6. `computeSilenceLevel` boundaries (0/3/7 days).
7. `looksLikeReplyRequest` positive/negative samples.
8. `extractGoogleCode`: bare code, full redirect URL, garbage.
9. Work-hours: normal range, overnight range (`22:00–06:00`), boundary minutes.

## Acceptance criteria

1. `npm test` runs green in < 10 s with no network, no Telegram token, no
   Google token, on a fresh clone.
2. Reverting the TZ-01 fix makes a test fail (proves the regression net works).
3. `update.sh` with an intentionally failing test aborts, rolls back, and the
   owner receives a Telegram message about it; the service stays on the old
   version and running.
4. `index.js` behavior is unchanged (pure extraction refactor) — verify by
   running the bot and exercising briefing, long-message send, email poll.
