# Audit 2026-07 — remediation specs

Technical specifications for the highest-priority findings of the July 2026
product/code audit (see `/AUDIT-2026-07.md` at the repo root for the full
audit). Scope calibrated for the priority scenario: **personal tool + instances
operated for friends**; each spec also moves the open-source readiness forward.

## Specs, in recommended order

| # | Spec | Fixes | Severity | Effort |
|---|------|-------|----------|--------|
| 1 | [tz-01-email-poll-crash-loop.md](tz-01-email-poll-crash-loop.md) | Onboarding «Не проверять почту» → `*/0` cron → systemd crash loop (reproduced) | 🔴 crash | 1 evening |
| 2 | [tz-02-send-email-confirm-button.md](tz-02-send-email-confirm-button.md) | `send_email` guarded only by a model-side `confirmed` flag → physical inline-button confirmation (the `update_bot` pattern) | 🔴 security | 1 evening |
| 3 | [tz-03-multi-account-oauth.md](tz-03-multi-account-oauth.md) | Second-Gmail OAuth clobbers main `token.json` + callback CSRF; fixed together via `state` parameter | 🔴 data-loss / security | 1–2 evenings |
| 4 | [tz-04-email-credentials-security.md](tz-04-email-credentials-security.md) | Plaintext IMAP passwords in SQLite replicated to Drive backups; `rejectUnauthorized: false` everywhere; file perms | 🔴 security | 2 evenings |
| 5 | [tz-05-history-persistence.md](tz-05-history-persistence.md) | Conversation amnesia on every restart/auto-update | 🟠 UX | 1 evening |
| 6 | [tz-06-test-scaffold.md](tz-06-test-scaffold.md) | Zero tests + auto-updating tenants; `node:test` scaffold + update.sh gate with rollback | 🟠 reliability | 2 evenings |
| 7 | [tz-07-bugfix-batch.md](tz-07-bugfix-batch.md) | Six small confirmed bugs: `get_emails` first-account-only, checklist index mismatch, >4096 send failures, Zhora not monitoring Max, briefing exact-match «да», slow leaks | 🟠/🟡 | 2 evenings |

## Dependencies between specs

- **TZ-01 first** — it's the only user-facing crash and the smallest diff.
- TZ-06 (tests) is most valuable **early**: TZ-01, TZ-07.3 and TZ-05 each add
  pure functions the scaffold covers; the update.sh gate then protects tenants
  during the rest of the rollout.
- TZ-07.3 (message splitting) shares the `splitMessage` extraction with TZ-06.
- TZ-04 touches every credentials read site; land it before or after TZ-03
  (both edit the `/auth2` path), not simultaneously.
- TZ-02 and TZ-05 are independent of everything else.

## Deliberately out of scope (from the audit, deferred)

- Claude-based email classification instead of regex `categorize()` — biggest
  perceived-intelligence win, but a feature, not a fix; write its own TZ when
  scheduled.
- i18n / removing hardcoded Russian; Docker / no-Google degraded mode
  (open-source blockers, scenario 2).
- Parent confirmation for `[QUEST_DONE]` prize codes (tutor bot) — same
  model-enforcement disease as TZ-02; port the TZ-02 pattern to the tutor in a
  follow-up.
- Anything SaaS-tier (multi-tenant process, KMS, billing) — per the audit,
  decide deliberately rather than drift.
