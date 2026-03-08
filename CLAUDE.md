# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Snezhanna is a personal AI assistant for Vova (Vladimir Morshin) that runs as a systemd service on a Linux VPS. It operates through Telegram and uses Claude (claude-sonnet-4-6) as its brain. The project has two processes: **Snezhanna** (main bot) and **Zhora** (watchdog).

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

# Watchdog
sudo systemctl start|stop|restart|status zhora
journalctl -u zhora -f

# Deploy service files after editing
sudo cp systemd/snezhanna.service /etc/systemd/system/
sudo cp watchdog/zhora.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## Yandex Disk indexer

```bash
node lib/indexer.js               # full index
node lib/indexer.js --incremental # incremental update
```

## Architecture

### Two-process design

**`index.js`** — Snezhanna main bot:
- Telegram polling with single-user access control (by numeric ID or username from `TELEGRAM_ALLOWED_USER_ID`)
- Sends all messages to Claude via `@anthropic-ai/sdk` with a rolling conversation history (window: 40 messages, keep 30)
- Anthropic native web search (`web_search_20250305`) enabled as a server-side tool — Claude can search the web for current info (rates, news, weather) without any local execution
- Auto-fetches Google Calendar / Gmail context when keywords are detected in user messages (Russian keywords: "календар", "встреч", "сегодня", "почт", etc.)
- On startup: calls `yadiskDirs.ensureDirs()` to create any missing agent subdirs (`index/`, `memory/`, `projects/`, `fitness/`, `drafts/`, `digests/`)
- Scheduled tasks via `node-cron`: morning briefing (08:00), evening check-in (19:00), weekly digest (Sunday 10:00), calendar reminders every 10 min (fires at 30-min mark)
- Evening check-in includes a summary of all Yandex Disk write operations logged during the day (via `lib/disk-log.js`); log is cleared after sending
- Bot commands: `/reset` (clear history), `/status`, `/auth <code>` (Google OAuth callback)
- Voice messages: downloaded from Telegram → transcribed via OpenAI Whisper → sent to Claude

**`watchdog/zhora.js`** — Zhora watchdog (separate systemd service):
- Checks every 5 minutes: snezhanna systemd status, Telegram API reachability, Yandex Disk WebDAV mount points, disk space (>85% threshold), recent error logs
- Auto-restarts Snezhanna if it's down; reports to Vova via its own Telegram bot (`WATCHDOG_BOT_TOKEN`)
- Morning report at 07:55 Madrid time
- Uses zero npm dependencies — pure Node.js `https` module for Telegram calls

### Key files

| File | Purpose |
|------|---------|
| `index.js` | Main bot entrypoint |
| `lib/google.js` | Google Calendar + Gmail via googleapis OAuth2 |
| `lib/whisper.js` | OpenAI Whisper transcription + TTS |
| `lib/state.js` | Persist chatId to `.nanobot/state.json` |
| `lib/indexer.js` | Walk Yandex Disk and build JSON file index |
| `lib/yadisk-dirs.js` | Ensure agent subdirs exist; project CRUD (`create_project`, `list_projects`, `read_project_file`, `write_project_file`) and project docs (`list_project_docs`, `read_project_doc`, `write_project_doc`) |
| `lib/disk-log.js` | In-memory log of Yandex Disk write operations; flushed after evening check-in |
| `identity/IDENTITY.md` | Snezhanna's system prompt (personality, capabilities, prompt injection defense) |
| `config/nanobot.json` | Model, token limits, timezone, history window, Yandex Disk mount paths and indexer rules |
| `schedules/heartbeats.json` | Documentation of all scheduled tasks (not loaded at runtime) |
| `docs/snezhanna-tz.md` | Technical specification (TZ) — infrastructure, integrations, architecture decisions |
| `skills/*.md` | Capability descriptions (documentation only, not loaded at runtime) |

### State & credentials

- **Runtime state** (chatId): `.nanobot/state.json` — gitignored, auto-created
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
```
