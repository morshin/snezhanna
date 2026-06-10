# Snezhanna

Personal AI assistant running as a Telegram bot on a Linux VPS. Uses Claude as its brain, with integrations for Google Calendar, Gmail, Google Drive, and persistent memory.

## Architecture

Three independent processes:

- **Snezhanna** (`index.js`) — main Telegram bot with Claude tool use for Calendar, Gmail, Google Drive (search, memory, file storage, backups)
- **Max** (`tutor/index.js`) — study tutor bot for Vova's son (Spanish school, quest system, parent interface)
- **Zhora** (`watchdog/zhora.js`) — watchdog that monitors both bots and auto-restarts if needed

## Setup

1. Clone the repo to your VPS
2. Copy `.env.example` to `.env` and fill in values
3. Place Google OAuth2 credentials in `credentials.json` (Desktop-type client)
4. Install dependencies:
   ```bash
   npm install
   ```
5. Deploy systemd services:
   ```bash
   sudo bash setup.sh
   ```

## Running

```bash
node index.js          # production
node index.js --debug  # debug mode
```

## Google Authorization

On first run (or `/status`), Snezhanna sends a Google auth URL via Telegram. Visit the URL, authorize Calendar + Gmail + Drive, copy the code, and send `/auth <code>` to the bot.

## Configuration

`config/nanobot.json` — model, timezone, history window, Google Drive root folder, user name, enabled integrations.

Key settings for a new instance:
```json
{
  "user": { "name": "Вова", "assistant_name": "Снежанна" },
  "gdrive": { "root_folder": "Снежанна" },
  "mini_app": { "port": 3001 }
}
```

See `docs/new-instance-setup.md` for deploying a second instance on the same VPS.

## Bot Commands

- `/reset` — clear conversation history
- `/status` — show service status and Google auth state
- `/auth <code>` — complete Google OAuth flow

## Scheduled Tasks

- **08:00** — morning briefing (calendar + tasks + email)
- **19:00** — evening check-in (tomorrow's events + Google Drive activity log)
- **Sunday 09:30** — Strava sync
- **Sunday 10:00** — weekly digest
- **Monday 09:00** — workload & wellbeing check-in
- **Every 10 min** — calendar reminders (30 min before events)
- **03:30** — SQLite backup to Google Drive

All times are Europe/Madrid.
