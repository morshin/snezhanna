# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Snezhanna is a personal AI assistant for Vova (Vladimir Morshin) that runs as a systemd service on a Linux VPS. It operates through Telegram and uses Claude (claude-sonnet-4-6) as its brain. The project has three processes: **Snezhanna** (main bot), **Max** (tutor bot for Vova's son), and **Zhora** (watchdog monitoring both).

## Running the bot

```bash
node index.js          # production (also used by systemd)
node index.js --debug  # dev mode with debug flag
```

There are no automated tests. Verify behavior by watching journal logs.

## Service management

```bash
# Main bot
sudo systemctl start|stop|restart|status snezhanna
journalctl -u snezhanna -f          # live logs
journalctl -u snezhanna -n 100      # last 100 lines

# Tutor bot (Max)
sudo systemctl start|stop|restart|status tutor
journalctl -u tutor -f

# Watchdog
sudo systemctl start|stop|restart|status zhora
journalctl -u zhora -f

# Deploy service files after editing
sudo cp systemd/snezhanna.service /etc/systemd/system/
sudo cp tutor/systemd/tutor.service /etc/systemd/system/
sudo cp watchdog/zhora.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## Architecture

### Three-process design

**`index.js`** — Snezhanna main bot:
- Telegram polling with single-user access control (by numeric ID or username from `TELEGRAM_ALLOWED_USER_ID`)
- Sends all messages to Claude via `@anthropic-ai/sdk` with a rolling conversation history (window: 40 messages, keep 30)
- Prompt caching enabled (`betas: ['prompt-caching-2024-07-31']`): two cache breakpoints — CORE.md and IDENTITY both marked with `cache_control: { type: 'ephemeral' }`; cache hits logged as `[Cache] hit: N tokens cached`
- Anthropic native web search (`web_search_20250305`) enabled as a server-side tool — Claude can search the web for current info (rates, news, weather) without any local execution
- Auto-fetches Google Calendar / Gmail context when keywords are detected in user messages (Russian keywords: "календар", "встреч", "сегодня", "почт", etc.)
- **Four-layer system prompt** built by `buildSystemPrompt(nowStr)` in `index.js`: Layer 1 `identity/CORE.md` (locked, cached) → Layer 2 IDENTITY (user-configurable, stored in SQLite `identity` key, fallback to `identity/IDENTITY.md`, cached) → Layer 3 `lib/skills.js::buildSkillsBlock()` (auto-generated from the real tools list — always current, not cached) → Layer 4 `settings.getSystemPromptBlock()` (preferred name, formality, response style, freeform `character_notes`) → timestamp. User can change Layer 2 via Mini App Settings → «Личность бота» or by telling Snezhanna (→ `update_my_preferences` with `character_notes`).
- Morning briefing time is controlled by `settings.get('briefing_time')` (default 08:00); changing it via Mini App or chat calls `rescheduleBriefing(newTime)` which stops the old cron job and creates a new one.
- On startup: initialises SQLite DB (`lib/db.js`, creates `data/snezhanna.db` if missing), calls `gdrive.ensureDirs()` non-blocking to create required Google Drive folder structure (`memory/`, `fitness/weekly/`, `fitness/races/`, `drafts/`, `digests/`, `backups/`), then starts the Mini App HTTP API server (`lib/api.js`) on the port from `config.mini_app.port` (default 3001)
- Task and project storage: local SQLite (`data/snezhanna.db`) via `better-sqlite3` (synchronous). Tasks have subtasks (`parent_id`) and dependencies (`task_deps` table). New tools: `add_task_dependency`, `get_task_with_subtasks`. Daily DB backup to Google Drive `backups/snezhanna_YYYYMMDD.db` at 03:30 (keep 7).
- Scheduled tasks via `node-cron`: morning briefing gate (08:00), workload weekly check-in (Monday 09:00), evening check-in (19:00), weekly digest (Sunday 10:00), calendar reminders every 10 min (fires at 30-min mark), deadline alerts every 10 min, email poll (interval from `settings.email_poll_interval`, default 30 min, reschedules dynamically), DB backup (03:30)
- Conversational briefing (TZ-1): morning cron sends "Готов к брифингу?" only if `hasSomethingToSay()` returns true; waits for positive reply (up to 8 h) before sending full briefing; silence tracking (`silenceDaysCount` / `silenceLevel` 0–2) reduces frequency after 3+ ignored days; vacation mode via `/quiet [N]` command or `set_quiet_mode` tool (`quietUntil` ISO timestamp); comeback digest sent on first message after 3+ silent days; hard alerts (calendar reminders, deadline alerts, email reply-request alerts) bypass silence/vacation; evening check-in suppressed at silenceLevel ≥ 1
- Workload & Wellbeing scoring: weekly life-balance score (0–10) across 4 domains (work, family, health, personal). Monday 09:00 check-in collects self-reported data, then `lib/workload.js` aggregates Calendar/Gmail/Tasks/Strava data and runs a standalone Claude scoring call. Morning briefing appends an overload coach block when score ≤ 5. On-demand via phrases like "мой скор", "как я справляюсь". History persisted in SQLite `workload_history` table (last 12 weeks)
- Evening check-in includes a summary of all Google Drive write operations logged during the day (via `lib/disk-log.js`); log is cleared after sending
- Bot commands: `/reset` (clear history), `/status`, `/auth <code>` (Google OAuth callback)
- Voice messages: downloaded from Telegram → transcribed via OpenAI Whisper → sent to Claude
- Reply context: when user replies to a specific message, `lib/reply-chain.js` builds a context block from `msg.reply_to_message` (+ `msg.quote` if present) and walks the reply chain via `message_id` lookups in history; context is prepended to the user message before Claude sees it
- Identity templates: `identity/CORE.md` (Layer 1, locked) and `identity/IDENTITY.md` (Layer 2 default) both use `{{USER_NAME}}` and `{{ASSISTANT_NAME}}` placeholders resolved at startup via `resolveIdentityPlaceholders()`; Layer 3 skills block is generated at call time from the live tools list (no placeholders needed)
- **Onboarding wizard**: new users see a step-by-step setup on first message (`lib/onboarding.js`): integration check (Claude/Google/OpenAI) with animated ⏳→✅ edit, then questions for name, **bot persona** (friendly/business/neutral/custom → saves `character_notes`), communication style, briefing/check-in schedule, email poll interval, GitHub/Strava/chat-monitor toggles. State tracked via `onboarding_completed` / `onboarding_step` in `.nanobot/state.json`. Existing users are auto-migrated (skips wizard). `callback_query` handler in `index.js` routes inline-keyboard button presses to `onboarding.handleCallback()`. If Google is not yet authorized, wizard pauses at `waiting_google` step and resumes via `resumeAfterGoogleAuth()` after successful `/auth`.
- **Google auth UX**: `offerGoogleAuth()` sends an inline-keyboard URL button `🔗 Открыть Google →` with step-by-step instructions (MarkdownV2) instead of a raw link

**`tutor/index.js`** — Max tutor bot (separate systemd service):
- Telegram bot for Vova's son (13 y/o, Spanish school), access-controlled by `TUTOR_ALLOWED_USER_ID`
- **Two-actor model**: student (`TUTOR_ALLOWED_USER_ID`) and parent (`PARENT_CHAT_ID`). Parent messages are routed to a separate handler before the student flow — never forwarded to Claude's tutoring session
- Always responds in Spanish to student; understands Russian but redirects back to Spanish; responds in Russian to parent
- Pedagogical approach: never gives answers directly, asks guiding questions
- Onboarding flow: collects school timetable day by day → saves to `schedule.json`
- In-memory session tracking (subject, topics, stuck points, mood)
- Photo support via shared `lib/vision.js` (homework photos, textbook pages)
- Voice support via shared `lib/whisper.js` with `language='es'`
- Prompt caching enabled (same as Snezhanna): identity cached, cache hits logged
- Reply context support (same as Snezhanna): reply-to-message and quote context prepended to student messages via shared `lib/reply-chain.js`
- Homework tracking: afternoon checkin (15:00) asks "what homework?", next reply auto-parsed via `askMaxOneShot` and saved to `homework.json`; Claude marks completed homework with `[DONE:ID]` markers stripped before display
- **Quest system**: parent assigns quests via `/quest`; active quests injected into Claude context; Claude appends `[QUEST_DONE:id]` when objective met; index.js strips markers, calls `completeQuest()`, issues next unused prize code from `codes_DDMMYYYY.md`, sends code to son in Spanish + parent notification; updates HMAC-signed `balance.json`; warns parent when ≤10 codes remain
- **Prize code pool**: parent runs `/gencodes [N]` → generates N unique 10-char alphanumeric codes, writes `codes_DDMMYYYY.md` to `KIDS_DIR`, sends `prize_DDMMYYYY.txt` via `bot.sendDocument()` for import into Time Boss Cloud; `/codes` shows remaining count
- **Parent commands**: `/report` (today's session), `/week` (weekly digest), `/homework` (shows IDs for deletion), `/balance`, `/quests`, `/codes` (code pool status), `/gencodes [N]` (generate prize codes), `/assign <subject>: <task>` (saves immediately) or `/assign <free text>` (Claude parses into tasks with clarifying comments, waits for parent confirmation), `/delhw <id>` (delete homework task), `/quest <subject> "<desc>" +Nмин`, `/cancelquest <id>`, `/setday <day> <subjects>` (edit one day of schedule), `/resetschedule` (full 5-step schedule reset); parent can also send a **photo of homework** — Claude vision recognizes tasks and shows preview for confirmation before saving
- **Parent notifications**: post-session summary after every session end (student `/done`, auto-close), quest completion alert, subject avoidance flag (weekly), stuck-topic flag (repeated stuck points across sessions)
- Message processing mutex (`withLock`) prevents race conditions on rapid messages
- Startup message cooldown (4 hours) for both student and parent, to avoid spam on Zhora restarts
- Commands (student): `/start`, `/done` / `/стоп` (end session), `/schedule` (view/reset timetable), `/homework` (pending tasks), `/reset`, `/status`
- Scheduled tasks: afternoon checkin (15:00), **hourly homework reminder (16:00–20:00, Mon–Fri)** — sends short reminder to student if pending homework exists and no active session, evening reminder (21:00), daily summary (20:30), weekly digest (Sunday 18:00) + subject avoidance check, session auto-close (every 5 min, 30 min idle)
- Reports to `KIDS_DATA_DIR` (default: `/opt/snezhanna/data/kids`): daily sessions, progress.md, weekly digests, homework.json, quests.json, balance.json
- Uses `dotenv` with absolute path to `/opt/snezhanna/.env`

**`watchdog/zhora.js`** — Zhora watchdog (separate systemd service):
- Checks every 5 minutes: snezhanna + tutor systemd status, Telegram API reachability, disk space (>85% threshold), recent error logs
- Auto-restarts Snezhanna or Max if down; reports to Vova via its own Telegram bot (`WATCHDOG_BOT_TOKEN`)
- Morning report at 07:55 Madrid time shows status of both bots
- Commands: `/status` (all services), `/logs [snezhanna|max] [N]`, `/restart [snezhanna|max]` with confirmation, `/lang [ru|es]` (set Max's weekly language)
- Uses zero npm dependencies — pure Node.js `https` module for Telegram calls

### Key files

| File | Purpose |
|------|---------|
| `index.js` | Main bot entrypoint |
| `lib/google.js` | Google Calendar + Gmail + Drive OAuth2 (scopes: calendar, gmail.modify, drive); Gmail thin-wrappers delegate to `lib/gmail.js` |
| `lib/gdrive.js` | Google Drive abstraction: folder/file CRUD, search, binary uploads, backup pruning, `ensureDirs()` |
| `lib/gmail.js` | Gmail API adapter (credentials-based, no file I/O); unified message format; functions: `getMessages`, `getMessage`, `createDraft`, `sendMessage`, `markAsRead`, `getAttachment` |
| `lib/imap.js` | IMAP/SMTP adapter using `imap`, `mailparser`, `nodemailer`; auto-detects Office 365; functions: `getMessages`, `getMessage`, `createDraft` (IMAP APPEND), `sendMessage` (nodemailer), `markAsRead` |
| `lib/mail-manager.js` | Multi-account email coordinator; `pollAll()` dispatches to gmail/imap adapters, bootstraps new accounts (seeds seen IDs without digest on first poll), categorizes messages, detects subprojects; `buildEmailDigest()` formats per-account digest; seen tracking in SQLite `email_seen` table |
| `lib/whisper.js` | OpenAI Whisper transcription + TTS (language param: `'ru'` default, `'es'` for Max) |
| `lib/vision.js` | Shared photo handler: download from Telegram, base64 encode, build Claude image blocks |
| `lib/reply-chain.js` | Shared reply context builder: extracts `reply_to_message` / `quote` from Telegram messages, walks reply chains via `message_id` in history, formats context block prepended to user messages |
| `lib/state.js` | Persist chatId, businessConnectionId, awaitingWorkloadCheckin, briefing/silence/vacation state, and onboarding progress (`onboarding_completed`, `onboarding_step`) to `.nanobot/state.json` (path overrideable via `STATE_FILE` env var) |
| `lib/briefing.js` | `hasSomethingToSay()` (value check for morning gate), `computeSilenceLevel()`, `looksLikeReplyRequest()` (email hard-alert heuristic) |
| `lib/workload.js` | Workload & Wellbeing scoring: data collection, Claude scoring call, history persisted in SQLite `workload_history` table, weekly report and overload coach block |
| `lib/workload-scoring-prompt.md` | System prompt for the workload scoring Claude call (JSON output schema, domain weights, tone rules) |
| `lib/briefing-overload-prompt.md` | System prompt for the morning briefing overload coach block |
| `docs/snezhanna-workload-scoring-tz.md` | Technical specification for the Workload & Wellbeing Scoring feature |
| `lib/db.js` | better-sqlite3 init, WAL mode, schema (tasks, projects, project_log, project_notes, project_docs, task_deps, project_params, project_history, contacts, project_contacts, workload_history, memory, file_index, email_accounts, email_seen); exports `{ db, getProject, getProjectById, listProjects, upsertProjectParam, getProjectParam, backup }` |
| `lib/yadisk-dirs.js` | Project CRUD backed by SQLite (`create_project`, `list_projects`, `read_project_file`, `write_project_file`) and project docs (`list_project_docs`, `read_project_doc`, `write_project_doc`); `saveFile()` uploads to Google Drive via `lib/gdrive.js` |
| `lib/yadisk.js` | `search_files` and `read_file` tools — delegates to `lib/gdrive.js` for Google Drive search and content fetch |
| `lib/memory.js` | Memory CRUD backed by SQLite `memory` table |
| `lib/races.js` | Race folder creation in Google Drive `fitness/races/` |
| `lib/token-log.js` | Per-request token analytics — written to local `data/analytics/tokens-YYYY-MM.json` (NDJSON) |
| `lib/github.js` | GitHub Milestones: open milestones with `due_on` in the configured window (`github.milestone_due_within_days`, default 14 calendar days in `timezone`, including overdue); used in workload scoring, morning briefing, Mini App API |
| `scripts/migrate-to-sqlite.js` | One-time migration: tasks + projects from Yandex.Disk JSON → SQLite; `--dry-run` available |
| `scripts/migrate-memory-workload.js` | One-time migration: memory/*.md + workload-history.json → SQLite; `--dry-run` available |
| `scripts/migrate-yadisk-to-gdrive.js` | One-time migration: fitness/races, strava weekly data from Yandex.Disk → Google Drive; `--dry-run` available |
| `data/snezhanna.db` | SQLite database (gitignored) — tasks, projects, docs, logs |
| `data/analytics/` | Local token usage logs (gitignored) |
| `lib/settings.js` | Key-value user settings in SQLite `user_settings`; `get(key)`, `set(key,val)`, `getAll()`, `getSystemPromptBlock()` (Layer 3: name/formality/style/character_notes), `getIdentity(default)` (Layer 2: returns DB override or default) |
| `lib/api.js` | HTTP API server for Mini App; validates Telegram initData, serves static files from `mini-app/`, exposes task CRUD + calendar + settings/chats/projects/contacts/email-accounts CRUD + `GET /api/github/milestones` + `GET /api/system/status` + `POST /api/system/restart` |
| `lib/onboarding.js` | First-run onboarding wizard state machine; exports `start`, `handleMessage`, `handleCallback`, `resumeAfterGoogleAuth`; steps: check→name→identity→style→briefing→briefing_time→checkin→weekends→email→github→strava→chats |
| `mini-app/index.html` | Telegram Mini App frontend — Tasks + Calendar + Settings (gear icon → full-screen modal) single-file HTML/JS/CSS; Settings includes «Личность бота» section (character_notes textarea) and СИСТЕМА section with live service status and restart button |
| `lib/disk-log.js` | In-memory log of Google Drive write operations; flushed after evening check-in |
| `identity/CORE.md` | Layer 1 system prompt (locked): base rules, email safety, prompt injection defense; cannot be overridden by user settings; uses `{{USER_NAME}}` / `{{ASSISTANT_NAME}}` placeholders |
| `identity/IDENTITY.md` | Layer 2 system prompt default: personality, capabilities, tone; user can override via SQLite `identity` key (Mini App or chat); uses `{{USER_NAME}}` / `{{ASSISTANT_NAME}}` placeholders |
| `identity/IDENTITY.template.md` | Neutral starter template for new bot instances (without Vova-specific content) |
| `config/nanobot.json` | Model, token limits, timezone, history window, `gdrive.root_folder`, `user.name`/`user.assistant_name`, `integrations` flags, `database.path` |
| `schedules/heartbeats.json` | Documentation of all scheduled tasks (not loaded at runtime) |
| `docs/snezhanna-tz.md` | Technical specification (TZ) — infrastructure, integrations, architecture decisions |
| `docs/new-instance-setup.md` | Guide for deploying a second bot instance on the same VPS |
| `docs/deploy-new-server.md` | Step-by-step guide for deploying a Snezhanna tenant on a fresh server (no Zhora; service management via Mini App) |
| `systemd/snezhanna.service.template` | Systemd service template for new instances (parameterized WorkingDirectory + EnvironmentFile) |
| `lib/skills.js` | Auto-generates the "## Мои актуальные возможности" block injected as Layer 3 of the system prompt; groups tools by category + always-on capabilities; stays in sync with `lib/tools.js` via `/update-docs` |
| `skills/*.md` | Capability descriptions (documentation only, not loaded at runtime) |
| `tutor/index.js` | Max tutor bot entrypoint |
| `tutor/lib/storage.js` | File I/O for `KIDS_DATA_DIR` (default: `/opt/snezhanna/data/kids`); quest CRUD; prize code pool CRUD; HMAC-signed balance |
| `tutor/lib/session.js` | In-memory tutoring session state |
| `tutor/lib/claude.js` | Anthropic API wrapper for Max; injects active quests into system context; `askMaxOneShotWithImage()` for photo homework recognition |
| `tutor/lib/report.js` | Session/daily/weekly report generation; `checkSubjectAvoidance()`; `checkStuckTopic()` |
| `tutor/identity/IDENTITY.md` | Max's system prompt (personality, pedagogical rules, language policy, quest awareness) |
| `docs/tutor-bot-tz.md` | Technical specification for Max tutor bot |
| `docs/tutor-parent-interface-tz.md` | Technical specification for Max Parent Interface feature |
| `docs/tz-tasks-mini-app.md` | Technical specification for Tasks Mini App |
| `docs/tz-miniapp-calendar-tab.md` | Technical specification for Calendar tab in Mini App |

### State & credentials

- **Runtime state** (chatId): `.nanobot/state.json` — gitignored, auto-created
- **Tutor state** (chatId): `tutor/.tutor-state.json` — gitignored, auto-created
- **Google OAuth token**: `token.json` — gitignored; obtained via `/auth <code>` flow in Telegram
- **Google app credentials**: `credentials.json` — gitignored; must be a Desktop-type OAuth2 client
- **All secrets**: `.env` — gitignored; loaded by dotenv and referenced in `systemd/snezhanna.service` as `EnvironmentFile`

### Google OAuth flow

1. On startup (or on `/status`), if `token.json` is missing, Snezhanna sends Vova a Google auth URL
2. Vova visits the URL, copies the code, sends `/auth <code>` to the bot
3. `lib/google.js::saveToken()` exchanges the code and writes `token.json`
4. Scopes: `calendar` (read/write), `gmail.modify`, `drive` (full file storage)
5. Token file path overrideable via `GOOGLE_TOKEN_FILE` env var (for multi-instance deploys)

### Google Drive structure

All persistent data stored under a root folder (default `"Снежанна"`, set via `config.gdrive.root_folder`):

```
Снежанна/
  ├── memory/          — health.md, kids.md, finance.md, bureaucracy.md, decisions.md
  ├── fitness/
  │   ├── weekly/      — YYYY-WNN.json + YYYY-WNN-summary.md (Strava)
  │   └── races/       — {date}_{name}/README.md, plan.md, gear.md, result.md
  ├── drafts/          — file attachments saved from Telegram
  ├── digests/         — generated digests
  ├── inbox/           — default destination for save_file tool
  ├── analytics/       — not used (token analytics are local only)
  ├── backups/         — snezhanna_YYYYMMDD.db (SQLite backups, keep 7)
  └── workload-history.json
```

`lib/gdrive.js` caches folder and file IDs in memory to minimise Drive API calls.

Max (tutor bot) writes reports to local `KIDS_DATA_DIR` (`/opt/snezhanna/data/kids` by default). These files are not in Google Drive and are not accessible via the `search_files`/`read_file` tools.

### Timezone

All cron schedules use `Europe/Madrid`. Dates/times shown to Vova are localized to `Europe/Madrid` via `toLocaleString('ru-RU', { timeZone: config.timezone })`.

## Configuration

`config/nanobot.json` is the single source of truth for:
- `model`: Claude model ID
- `max_tokens`: per-response token limit
- `history.max_messages` / `history.keep_last`: conversation window
- `timezone`: Europe/Madrid
- `user.name`: owner's name for `{{USER_NAME}}` substitution in IDENTITY.md (default `"хозяин"`)
- `user.assistant_name`: bot's name for `{{ASSISTANT_NAME}}` substitution (default `"Ассистент"`)
- `gdrive.root_folder`: root folder name in Google Drive (default `"Snezhanna"`)
- `integrations.strava` / `integrations.github` / `integrations.chat_monitor`: enable/disable optional integrations
- `mini_app.port`: HTTP port for the Tasks Mini App API server (default 3001)
- `github.repos`: list of `{ repo: "owner/repo", project: "ProjectName" }` for GitHub Milestones; `project` is optional; `github.milestone_due_within_days`: show milestones due within this many days or already overdue (default 14)
- `database.path`: path to SQLite DB file (default `"data/snezhanna.db"`)

## Required environment variables

```
ANTHROPIC_API_KEY        # Claude API
TELEGRAM_BOT_TOKEN       # Snezhanna's Telegram bot
TELEGRAM_ALLOWED_USER_ID # Vova's numeric Telegram ID (or @username)
WATCHDOG_BOT_TOKEN       # Zhora's Telegram bot
OPENAI_API_KEY           # Whisper transcription + TTS
GOOGLE_CLIENT_ID         # Google OAuth2 (Calendar + Gmail + Drive)
GOOGLE_CLIENT_SECRET     # Google OAuth2
TUTOR_BOT_TOKEN          # Max tutor bot (from @BotFather)
TUTOR_ALLOWED_USER_ID    # Son's numeric Telegram ID
KIDS_DATA_DIR            # local kids data dir (default: /opt/snezhanna/data/kids)
PARENT_CHAT_ID           # Vova's numeric Telegram ID (same as TELEGRAM_ALLOWED_USER_ID); receives parent notifications via Max's bot
QUEST_HMAC_SECRET        # 64-char hex secret for HMAC-signing balance.json (shared with TimeGuard)
GITHUB_TOKEN             # (optional) GitHub personal access token; scopes: public_repo or repo
STRAVA_CLIENT_ID         # (optional) Strava API
STRAVA_CLIENT_SECRET     # (optional) Strava API
STRAVA_REFRESH_TOKEN     # (optional) Strava OAuth2

# Multi-instance overrides (optional — for running multiple instances on the same VPS)
GOOGLE_TOKEN_FILE        # path to OAuth token (default: ./token.json)
GOOGLE_CREDENTIALS_FILE  # path to credentials.json (default: ./credentials.json)
STATE_FILE               # path to state file (default: ./.nanobot/state.json)
```

See `docs/new-instance-setup.md` for a second instance on the **same VPS**; see `docs/deploy-new-server.md` for a tenant on a **fresh server** (includes sudoers rule for Mini App restart, onboarding flow).
