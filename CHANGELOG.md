# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [Semantic Versioning](https://semver.org/).

## [Unreleased]

<!-- Entries added here automatically by /gh-issue, /new-feature, /update-docs -->
<!-- Format: - <One-sentence description> (#<issue or branch ref>) -->
<!-- Categories: Added | Changed | Fixed | Security | Removed -->

## [1.3.21] — 2026-06-19

### Fixed

- **`deploy.sh` `[y/N]` prompts now work reliably over SSH:** re-disable bracketed paste mode before each confirmation read and strip non-alpha characters from input, fixing "Aborted." when the terminal injects `\e[200~y\e[201~` escape sequences around keystrokes

## [1.3.20] — 2026-06-19

### Changed

- **System prompt Layer 2 now includes user settings:** preferred name, formality, response style, persona, and character notes are merged into the cached IDENTITY block via `settings.getIdentityWithSettings()`; Layer 4 is now timestamp-only — reduces uncached tokens on every request

### Fixed

- **`preferred_name` with comma-separated variants** (e.g. `Вова, Вовик, Вов`) is now formatted as a list of alternatives in the prompt so Claude picks the right one by context; startup hardcoded messages now use only the first variant instead of the full string

## [1.3.19] — 2026-06-16

### Fixed

- **Migration 1.3.17:** `update.sh` now backs up `config/nanobot.json` to `/tmp` before any git operations; the migration reads from that backup when the original file has already been deleted by `git checkout` — previously the migration silently skipped on tenants upgrading from v1.3.16

## [1.3.18] — 2026-06-16

### Added

- **Migration system:** `update.sh` now runs `scripts/run-migrations.js` after `npm install`; pending migrations from `migrations/*.js` (named `{semver}-{description}.js`) are executed in semver order and tracked in `.nanobot/migrations.json` — structural changes between releases are applied automatically without manual intervention
- **Migration 1.3.17 — nanobot.json → .env:** first migration reads the tenant's `config/nanobot.json` (if present) and writes any non-default values into `.env`, ensuring nothing is lost when upgrading from a version that still used the JSON config file

## [1.3.17] — 2026-06-16

### Changed

- **`config/nanobot.json` removed:** all configuration now lives in environment variables with sane defaults; `lib/config.js` is the single source of truth. Tenant-specific values (`ASSISTANT_NAME`, `GDRIVE_ROOT_FOLDER`, `TIMEZONE`, `CLAUDE_MODEL`, `GITHUB_SELF_REPO`, etc.) go in `.env` — no per-tenant JSON file to manage or stash on updates.

## [1.3.16] — 2026-06-16

### Added

- **Update result in chat:** after restarting from an update the bot sends ✅ Обновился до vX.Y.Z or ❌ Обновление не прошло depending on whether the version actually changed
- **Update progress in Mini App:** version badge shows ⏳ обновляю... while the update runs, then ✅ обновлено до vX.Y.Z or ❌ не прошло — polls /api/system/version every 5 s and handles bot restart gaps gracefully

### Fixed

- **update.sh:** stashes local uncommitted changes (e.g. tenant config/nanobot.json) before git checkout and restores them after, so tenants with customised configs no longer get a checkout failure

## [1.3.15] — 2026-06-16

### Added

- **Self-update from chat:** new `update_bot` tool lets the bot check for a newer release and trigger `update.sh` via a Telegram button click — injection-safe because the actual exec requires a physical button press, not just a chat message
- **Startup update check:** bot checks GitHub for a newer release ~10 seconds after startup and sends the same update notification it would send after the morning briefing — covers tenants with briefing disabled or deployed mid-day

### Fixed

- **Cumulative release changelog:** update notification now summarises all versions between the installed version and latest, not just the latest release body — tenants several versions behind no longer miss intermediate changes

## [1.3.14] — 2026-06-15

### Fixed

- **User name resolution:** `{{USER_NAME}}` in identity prompts and all hardcoded bot messages now read `preferred_name` from settings (SQLite) instead of the `config.user.name` fallback — bot now correctly addresses the user by their onboarding name

## [1.3.13] — 2026-06-15

### Added

- **Release notifications:** bot checks GitHub for a new release during morning briefing and sends a human-readable summary (via Claude) with an inline «Обновить сейчас» button that runs `scripts/update.sh` — no more than once per day per version
- **GitHub issue creation:** new `create_github_issue` tool lets the bot file bug reports and feature requests in the bot's own GitHub repo directly from chat; attaches a Telegram screenshot (uploaded to `_screenshots/` in the repo) when the user sends a photo with the request
- **GitHub issue relay via Zhora:** tenant Snezhanna instances relay issue creation through a shared Telegram group — Zhora receives `/report_issue` commands and creates GitHub issues using its own `GITHUB_TOKEN`; no HTTP endpoints or shared secrets required; set `ZHORA_REPORT_CHAT` in all instances

### Changed

- Default user address changed from «хозяин» to «шеф» (`config/nanobot.json` `user.name`)

## [1.3.12] — 2026-06-14

### Fixed

- **Onboarding:** wizard now starts correctly for instances with an existing `chatId` but no completed onboarding — previously the bot silently dropped all messages in this state

## [1.3.11] — 2026-06-14

### Added

- **Mini App:** version badge next to «Обновить» button is now a clickable link — opens GitHub release notes when an update is available, or re-checks for updates when already up to date; hover tooltip on both states

### Fixed

- **Onboarding:** removed one-time migration that auto-completed the wizard for instances with existing state — new deployments with prior test state now correctly go through onboarding

## [1.3.10] — 2026-06-14

### Added

- **deploy.sh:** `--dev` flag to deploy from master instead of latest release tag

### Fixed

- **deploy.sh:** rollback on failed bot startup — directory preserved for debugging, reason logged
- **deploy.sh:** verification uses `--since` timestamp so old journal entries don't interfere with "Ready and listening" check
- **deploy.sh:** strip inline comments from `.env` after copying from `.env.example` — dotenv v16 was reading comment text as variable values (e.g. `GOOGLE_CREDENTIALS_FILE=# path to...`)
- **deploy.sh:** replace deprecated `urn:ietf:wg:oauth:2.0:oob` redirect URI with `http://localhost` — OOB flow blocked by Google for published OAuth apps
- **api.js, update.sh:** derive instance name from `__dirname` instead of hardcoding `snezhanna` — systemctl, journalctl, and update script path now work correctly for any instance name
- **update.sh:** detect whether running as root or as instance user (Mini App trigger) and skip `sudo -u` accordingly; use `sudo systemctl restart` in both cases

### Changed

- **docs/, skills/:** translated to English for token efficiency; identity and runtime prompts remain in Russian
- **Identity, prompts:** replaced all hardcoded user name references with `{{USER_NAME}}` / `{{ASSISTANT_NAME}}` placeholders; `workload.js` now resolves placeholders in scoring and overload prompts

## [1.3.9] — 2026-06-14

### Added

- **Skill Context:** новый модуль `lib/skill-context.js` — хранение поведенческих инструкций по доменам (email_poll, morning_briefing, evening_checkin, calendar_reminder, global) в SQLite `user_settings`.
- **Tools:** `get_skill_context` — показывает текущие инструкции по скиллам; `update_skill_context` — сохраняет инструкцию для домена через разговор с ботом.
- **Layer 3 (skills block):** `buildSkillsBlock` теперь принимает `skillContexts` и отображает `⚙️`-инструкции под каждым скиллом + мета-инструкция самопроверки («проверь инструмент и ⚙️-ограничения перед нестандартным запросом»).
- **Auto-decomposition:** `update_my_preferences` при изменении `character_notes` автоматически декомпозирует текст через Haiku и раскладывает правила в `skill_context:*`.

## [1.3.8] — 2026-06-13

### Fixed

- **Email:** письма категорий `info`/`update` (рассылки, уведомления) фильтруются молча — Claude и хард-алерты получают только `reply_needed`, `task`, `event` (claude/layer-2-email-filtering-73cqkb)
- **Email:** `looksLikeReplyRequest` проверяет no-reply паттерны отправителя ДО проверки `?` в теме — рассылки с вопросительным знаком больше не вызывают хард-алерт

## [1.3.7] — 2026-06-12

### Fixed

- **Deploy:** отключение bracketed paste и focus events (`\e[?2004l\e[?1004l`) предотвращает вставку escape-последовательностей в `read`
- **Deploy:** имя директории очищается от недопустимых символов после ввода; путь сразу отображается для проверки
- **Deploy:** API-ключи извлекаются по паттерну (`grep -oE`) вместо попытки вычистить мусор вокруг них
- **Deploy:** валидация timezone по `/usr/share/zoneinfo/` с примерами популярных значений
- **Deploy:** `TELEGRAM_ALLOWED_USER_ID` выводится в summary перед подтверждением
- **Deploy:** версия скрипта отображается при старте (`1.3.9`)

## [1.3.6] — 2026-06-12

### Fixed

- **Deploy:** добавлен ERR trap — при неожиданном выходе показывает номер строки и код ошибки вместо тихого падения
- **Deploy:** `|| true` в pipeline получения последнего тега — предотвращает выход из-за `pipefail` если `grep` не находит совпадений

## [1.3.5] — 2026-06-12

### Fixed

- **Deploy:** используется GitHub API вместо `git ls-remote` для получения последнего тега — устраняет зависание на новых серверах
- **Deploy:** при повторном запуске на уже существующую директорию скрипт предлагает удалить её и начать заново

## [1.3.4] — 2026-06-12

### Fixed

- **Deploy:** trim пробелов и escape-артефактов из вставленных API-ключей; при неверном формате показывает первые 10 символов для диагностики
- **Deploy:** подавлено сообщение о detached HEAD при клонировании тега (через `2>/dev/null`)

## [1.3.3] — 2026-06-12

### Fixed

- **Deploy:** подавлено git-сообщение о detached HEAD при клонировании тега — оно некорректно воспринималось как ошибка

### Security

- Очищены личные данные из публичных файлов репозитория: удалены Telegram chat_id и имена контактов из `config/nanobot.json`, реальные IP-адреса из документации, личный email и ссылки на личные репозитории

## [1.3.2] — 2026-06-12

### Added

- **Deploy:** `deploy.sh` — поддержка домена, автоустановка nginx и выпуск TLS-сертификата через Let's Encrypt в интерактивном setup
- **Docs:** `docs/deploy-new-server.md` — инструкция по настройке Mini App (nginx + BotFather) в рамках деплоя

## [1.3.1] — 2026-06-11

### Added

- **Snezhanna:** `lib/skills.js` — auto-generates a "Мои актуальные возможности" block from the live tools list and injects it as Layer 3 of the system prompt; bot now always knows its exact current capabilities and can answer "что ты умеешь?" accurately without manual maintenance
- **Snezhanna:** `/update-docs` skill now includes a mandatory step to keep `lib/skills.js` in sync whenever tools or always-on capabilities change

## [1.3.0] — 2026-06-11

### Added

- **Snezhanna:** Mini App СИСТЕМА — Start button (shown when service is down), Update button (git pull + npm install + restart via background scripts/update.sh); start/restart buttons toggle based on live service status
- **Snezhanna:** `scripts/update.sh` — self-update script for bot instances: git pull, npm install, systemctl restart
- **Snezhanna:** DB migration runner — `lib/db.js` scans `migrations/*.js` on startup, applies unapplied files in order inside transactions; crash on failure so Zhora catches it; `_migrations` tracking table in SQLite
- **Zhora:** skip monitoring for disabled (inactive) systemd services — avoids false restart attempts when tutor bot is intentionally stopped
- **Snezhanna:** `scripts/deploy-instance.sh` — automated same-VPS multi-tenant setup script; parameterised by instance name and port
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
