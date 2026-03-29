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

## Yandex Disk indexer

```bash
node lib/indexer.js               # full index
node lib/indexer.js --incremental # incremental update
```

## Architecture

### Three-process design

**`index.js`** — Snezhanna main bot:
- Telegram polling with single-user access control (by numeric ID or username from `TELEGRAM_ALLOWED_USER_ID`)
- Sends all messages to Claude via `@anthropic-ai/sdk` with a rolling conversation history (window: 40 messages, keep 30)
- Prompt caching enabled (`betas: ['prompt-caching-2024-07-31']`): identity block marked with `cache_control: { type: 'ephemeral' }` to reduce input token usage and avoid rate limits; cache hits logged as `[Cache] hit: N tokens cached`
- Anthropic native web search (`web_search_20250305`) enabled as a server-side tool — Claude can search the web for current info (rates, news, weather) without any local execution
- Auto-fetches Google Calendar / Gmail context when keywords are detected in user messages (Russian keywords: "календар", "встреч", "сегодня", "почт", etc.)
- On startup: calls `yadiskDirs.ensureDirs()` to create any missing agent subdirs (`index/`, `memory/`, `projects/`, `fitness/`, `drafts/`, `digests/`), then starts the Mini App HTTP API server (`lib/api.js`) on the port from `config.mini_app.port` (default 3001)
- Scheduled tasks via `node-cron`: morning briefing (08:00), workload weekly check-in (Monday 09:00), evening check-in (19:00), weekly digest (Sunday 10:00), calendar reminders every 10 min (fires at 30-min mark)
- Workload & Wellbeing scoring: weekly life-balance score (0–10) across 4 domains (work, family, health, personal). Monday 09:00 check-in collects self-reported data, then `lib/workload.js` aggregates Calendar/Gmail/Tasks/Strava data and runs a standalone Claude scoring call. Morning briefing appends an overload coach block when score ≤ 5. On-demand via phrases like "мой скор", "как я справляюсь". History persisted to `/mnt/yadisk-agent/workload-history.json` (last 12 weeks)
- Evening check-in includes a summary of all Yandex Disk write operations logged during the day (via `lib/disk-log.js`); log is cleared after sending
- Bot commands: `/reset` (clear history), `/status`, `/auth <code>` (Google OAuth callback)
- Voice messages: downloaded from Telegram → transcribed via OpenAI Whisper → sent to Claude

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
- Homework tracking: afternoon checkin (15:00) asks "what homework?", next reply auto-parsed via `askMaxOneShot` and saved to `homework.json`; Claude marks completed homework with `[DONE:ID]` markers stripped before display
- **Quest system**: parent assigns quests via `/quest`; active quests injected into Claude context; Claude appends `[QUEST_DONE:id]` when objective met; index.js strips markers, calls `completeQuest()`, issues next unused prize code from `codes_DDMMYYYY.md`, sends code to son in Spanish + parent notification; updates HMAC-signed `balance.json`; warns parent when ≤10 codes remain
- **Prize code pool**: parent runs `/gencodes [N]` → generates N unique 10-char alphanumeric codes, writes `codes_DDMMYYYY.md` to `KIDS_DIR`, sends `prize_DDMMYYYY.txt` via `bot.sendDocument()` for import into Time Boss Cloud; `/codes` shows remaining count
- **Parent commands**: `/report` (today's session), `/week` (weekly digest), `/homework`, `/balance`, `/quests`, `/codes` (code pool status), `/gencodes [N]` (generate prize codes), `/assign <subject>: <task>`, `/quest <subject> "<desc>" +Nмин`, `/cancelquest <id>`
- **Parent notifications**: post-session summary after every session end (student `/done`, auto-close), quest completion alert, subject avoidance flag (weekly), stuck-topic flag (repeated stuck points across sessions)
- Message processing mutex (`withLock`) prevents race conditions on rapid messages
- Startup message cooldown (4 hours) for both student and parent, to avoid spam on Zhora restarts
- Commands (student): `/start`, `/done` / `/стоп` (end session), `/schedule` (view/reset timetable), `/homework` (pending tasks), `/reset`, `/status`
- Scheduled tasks: afternoon checkin (15:00), evening reminder (21:00), daily summary (20:30), weekly digest (Sunday 18:00) + subject avoidance check, session auto-close (every 5 min, 30 min idle)
- Reports to `/mnt/yadisk-agent/kids/`: daily sessions, progress.md, weekly digests, homework.json, quests.json, balance.json
- Uses `dotenv` with absolute path to `/opt/snezhanna/.env`

**`watchdog/zhora.js`** — Zhora watchdog (separate systemd service):
- Checks every 5 minutes: snezhanna + tutor systemd status, Telegram API reachability, Yandex Disk WebDAV mount points, disk space (>85% threshold), recent error logs
- Auto-restarts Snezhanna or Max if down; reports to Vova via its own Telegram bot (`WATCHDOG_BOT_TOKEN`)
- Morning report at 07:55 Madrid time shows status of both bots
- Commands: `/status` (all services), `/logs [N]`, `/restart [snezhanna|max]` with confirmation
- Uses zero npm dependencies — pure Node.js `https` module for Telegram calls

### Key files

| File | Purpose |
|------|---------|
| `index.js` | Main bot entrypoint |
| `lib/google.js` | Google Calendar + Gmail via googleapis OAuth2 |
| `lib/whisper.js` | OpenAI Whisper transcription + TTS (language param: `'ru'` default, `'es'` for Max) |
| `lib/vision.js` | Shared photo handler: download from Telegram, base64 encode, build Claude image blocks |
| `lib/state.js` | Persist chatId, businessConnectionId, awaitingWorkloadCheckin to `.nanobot/state.json` |
| `lib/workload.js` | Workload & Wellbeing scoring: data collection, Claude scoring call, history persistence, weekly report and overload coach block |
| `lib/workload-scoring-prompt.md` | System prompt for the workload scoring Claude call (JSON output schema, domain weights, tone rules) |
| `lib/briefing-overload-prompt.md` | System prompt for the morning briefing overload coach block |
| `docs/snezhanna-workload-scoring-tz.md` | Technical specification for the Workload & Wellbeing Scoring feature |
| `lib/indexer.js` | Walk Yandex Disk and build JSON file index |
| `lib/yadisk-dirs.js` | Ensure agent subdirs exist; project CRUD (`create_project`, `list_projects`, `read_project_file`, `write_project_file`) and project docs (`list_project_docs`, `read_project_doc`, `write_project_doc`) |
| `lib/api.js` | HTTP API server for Mini App; validates Telegram initData, serves static files from `mini-app/`, exposes task CRUD + calendar endpoints |
| `mini-app/index.html` | Telegram Mini App frontend — two-tab (Tasks + Calendar) single-file HTML/JS/CSS |
| `lib/disk-log.js` | In-memory log of Yandex Disk write operations; flushed after evening check-in |
| `identity/IDENTITY.md` | Snezhanna's system prompt (personality, capabilities, prompt injection defense) |
| `config/nanobot.json` | Model, token limits, timezone, history window, Yandex Disk mount paths and indexer rules |
| `schedules/heartbeats.json` | Documentation of all scheduled tasks (not loaded at runtime) |
| `docs/snezhanna-tz.md` | Technical specification (TZ) — infrastructure, integrations, architecture decisions |
| `skills/*.md` | Capability descriptions (documentation only, not loaded at runtime) |
| `tutor/index.js` | Max tutor bot entrypoint |
| `tutor/lib/storage.js` | Yandex Disk I/O for `/mnt/yadisk-agent/kids/`; quest CRUD; prize code pool CRUD (`codes_DDMMYYYY.md`); HMAC-signed balance |
| `tutor/lib/session.js` | In-memory tutoring session state |
| `tutor/lib/claude.js` | Anthropic API wrapper for Max; injects active quests into system context |
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
4. Scopes: `calendar` (read/write) and `gmail.modify`

### Yandex Disk mounts

Two WebDAV mounts managed via davfs2 (set up by `setup.sh`, run as root):
- `/mnt/yadisk-readonly` — full Yandex Disk, read-only
- `/mnt/yadisk-agent` — Snezhanna's write area (`/mnt/yadisk-agent/memory/`, `/mnt/yadisk-agent/index/`)

Zhora monitors both mount points and re-mounts if they go down.

Max writes reports to `/mnt/yadisk-agent/kids/` (sessions, progress, weekly digests, homework.json, schedule.json, quests.json, balance.json).

### Timezone

All cron schedules use `Europe/Madrid`. Dates/times shown to Vova are localized to `Europe/Madrid` via `toLocaleString('ru-RU', { timeZone: config.timezone })`.

## Configuration

`config/nanobot.json` is the single source of truth for:
- `model`: Claude model ID
- `max_tokens`: per-response token limit
- `history.max_messages` / `history.keep_last`: conversation window
- `timezone`: Europe/Madrid
- `yadisk.*`: mount paths and index file location
- `index.*`: which folders/extensions to include/exclude when indexing Yandex Disk
- `mini_app.port`: HTTP port for the Tasks Mini App API server (default 3001)

## Required environment variables

```
ANTHROPIC_API_KEY        # Claude API
TELEGRAM_BOT_TOKEN       # Snezhanna's Telegram bot
TELEGRAM_ALLOWED_USER_ID # Vova's numeric Telegram ID (or @username)
WATCHDOG_BOT_TOKEN       # Zhora's Telegram bot
OPENAI_API_KEY           # Whisper transcription + TTS
GOOGLE_CLIENT_ID         # Google OAuth2
GOOGLE_CLIENT_SECRET     # Google OAuth2
YANDEX_WEBDAV_LOGIN      # Yandex Disk WebDAV credentials
YANDEX_WEBDAV_PASSWORD
TUTOR_BOT_TOKEN          # Max tutor bot (from @BotFather)
TUTOR_ALLOWED_USER_ID    # Son's numeric Telegram ID
KIDS_DATA_DIR            # /mnt/yadisk-agent/kids (default if unset)
PARENT_CHAT_ID           # Vova's numeric Telegram ID (same as TELEGRAM_ALLOWED_USER_ID); receives parent notifications via Max's bot
QUEST_HMAC_SECRET        # 64-char hex secret for HMAC-signing balance.json (shared with TimeGuard)
```
