# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [Semantic Versioning](https://semver.org/).

## [Unreleased]

<!-- Entries added here automatically by /gh-issue, /new-feature, /update-docs -->
<!-- Format: - <One-sentence description> (#<issue or branch ref>) -->
<!-- Categories: Added | Changed | Fixed | Security | Removed -->

### Added

- **Snezhanna:** Settings Mini App — step-by-step Gmail OAuth guide in email account editor; new API endpoints /api/google/auth-url and /api/google/auth-code; auto-expand new Gmail account after adding (fixes #11)
- **Snezhanna:** Settings Mini App — toggle to skip briefing and check-in on weekends (fixes #10)
- **Snezhanna:** Settings Mini App — toggles to enable/disable morning briefing and evening check-in (fixes #9)
- **Snezhanna:** Multi-account email (TZ-4) — unified inbox across Gmail OAuth and IMAP/Office365 accounts; accounts stored in SQLite `email_accounts`; seen-message tracking via `email_seen` table; bootstrap on first poll; per-account digest with category sections; new tools: `get_email_accounts`, `get_emails`, `read_email`, `read_email_attachment`, `mark_email_read`, `create_draft`, `send_email` (confirmed guard); Mini App ПОЧТА section; dynamic email poll reschedule via `update_my_preferences`
- **Snezhanna:** Settings Mini App — gear icon in tab bar opens full-screen settings modal with sections: Profile (name, tone, style), Schedule (briefing time, vacation mode), Integrations (GitHub, Strava, email interval), Chats (add/remove monitored chats), Projects, Contacts; all settings persist to SQLite `user_settings` table; injected into Claude system prompt via `settings.getSystemPromptBlock()`; `update_my_preferences` tool lets Claude update settings from conversation; `rescheduleBriefing()` applies new briefing time to running cron (TZ-3)
- **Snezhanna:** SQLite migration complete — memory, workload history, and file index now stored in SQLite; new tables: workload_history, memory, file_index, project_params, project_history, contacts, project_contacts; migration script scripts/migrate-memory-workload.js (TZ-2)
- **Snezhanna:** conversational briefing gate — morning cron asks "Готов к брифингу?" and sends full briefing only on positive reply; silence adaptation (3 levels) reduces/stops prompts when ignored; vacation mode via `/quiet [N]` command and `set_quiet_mode` tool; comeback digest after 3+ days of silence; deadline hard-alerts (10-min cron) and email reply-request hard-alerts bypass silence/vacation; evening check-in suppressed at silence level ≥ 1 (TZ-1)

## [1.2.0] — 2026-04-06

### Added

- **Snezhanna + Max:** reply context support — when replying to a specific message in Telegram, Claude receives the parent message (and full reply chain if applicable) as prepended context; supports `msg.reply_to_message`, `msg.quote` (selected text), and in-memory history chain walking; shared utility `lib/reply-chain.js`
- **Max:** parent schedule editing — `/setday` (single day) and `/resetschedule` (full guided 5-step reset) commands; day names accepted in Russian and Spanish
- **Max:** parent can submit homework via photo — Claude vision recognizes tasks from photos with confirmation flow before saving
- **Max:** improved `/assign` with free-form text parsing and confirmation flow — Claude breaks text into concrete tasks with clarifying comments (ambiguities, missing details); parent reviews, corrects if needed, and confirms before saving
- **Max:** `/delhw <id>` command for parent to delete homework tasks; `/homework` now shows task IDs for easy deletion
- **Max:** hourly homework reminders to student (16:00–20:00 weekdays) when pending tasks exist and no active session; anti-spam guard (55 min cooldown)
- **Max:** `askMaxOneShotWithImage()` in `tutor/lib/claude.js` for one-shot Claude calls with image input

### Changed

- **GitHub:** integration now surfaces **milestones** with a set due date only—open milestones that are overdue or due within `github.milestone_due_within_days` (default 14, in `config.timezone`), instead of all open issues; merged into tasks / Mini App as `github_kind: "milestone"`.
- **API:** `GET /api/github/milestones` added; `GET /api/github/issues` kept as a legacy alias and returns `{ milestones }` (no `issues` key).
- **Tools:** `list_github_issues` replaced by `list_github_milestones` (returns `milestones`, `count`).
- **Workload scoring:** payload field `github_issues` replaced by `github_milestones` (count, by repo, per-milestone due metadata); scoring prompt updated accordingly.
- **Morning briefing** uses `getTodayTasksWithGithub(2, { wideGithubWindow: true })` so local tasks stay on a 2-day horizon while milestones use the full configured window; Mini App `filter=today` keeps milestones within the same `daysAhead` as local tasks.

## [1.1.0] — 2026-04-04

### Added

- Migrate task and project storage from JSON files on Yandex.Disk to local SQLite (`data/snezhanna.db`); adds subtasks (`parent_id`), task dependencies (`task_deps`), daily DB backup to Yandex.Disk at 03:30, and new tools `add_task_dependency` / `get_task_with_subtasks`
- GitHub Issues integration: Snezhanna reads open issues from configured repos, includes them in morning briefings, workload scoring, and exposes `GET /api/github/issues` for the Mini App; `list_github_issues` tool added for on-demand queries (#7)
- Max Parent Interface: prize code pool (`/gencodes`, `/codes`), code issuance on quest completion with Time Boss Cloud integration, and low-codes warning to parent

### Changed

- `/quest` command now starts a guided dialog: subject → description → Claude-refined proposal with confirmation loop → reward time; old one-liner format still works as a fast path (closes #5)

### Fixed

- Fix domain scores showing "undefined" in weekly workload report when Claude returns flat numbers instead of nested objects (fixes #6)
- Max now accepts voice messages in Russian, Spanish, and English via Whisper auto-detection (fixes #8)
- Max now immediately messages the student when a new quest is assigned outside an active session (fixes #3)
- Max now detects likely AI/copy-paste answers and gently suggests completing the task on paper with a photo (fixes #4)
- Max now announces a new quest immediately when it is created mid-session, and always responds about active quests when the student explicitly asks, regardless of current subject (fixes #2)
- Serialise askClaude calls with a mutex to prevent concurrent requests from corrupting history with orphaned tool_use blocks (fixes #1)

## [1.0.0] — 2026-03-28

### Added

- Snezhanna main bot with Claude claude-sonnet-4-6, rolling conversation history, and prompt caching
- Google Calendar and Gmail integration with OAuth2 and auto-context injection
- Yandex Disk indexer and WebDAV mount management
- Anthropic native web search tool
- Voice message transcription via OpenAI Whisper
- Workload & Wellbeing scoring (weekly life-balance score across 4 domains)
- Morning briefing, evening check-in, and weekly digest scheduled tasks
- Tasks Mini App (Telegram WebApp) with HTTP API
- Calendar tab in Mini App
- Max tutor bot with two-actor model (student + parent), quest system, and homework tracking
- Parent interface: post-session summaries, quest completion alerts, subject avoidance flags
- Zhora watchdog: monitors both bots, auto-restarts, morning health report
- Photo/vision support via shared `lib/vision.js`
- Strava integration: weekly sync, fitness digest, race management
- Token usage analytics for Snezhanna and Max
