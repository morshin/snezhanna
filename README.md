# Snezhanna

Personal AI assistant for Vova, running as a Telegram bot on a Linux VPS. Uses Claude as its brain, with integrations for Google Calendar, Gmail, Yandex Disk, and persistent memory.

## Architecture

- **Snezhanna** (`index.js`) — main Telegram bot with Claude tool_use for Calendar CRUD, Gmail, Yandex Disk search, and memory
- **Zhora** (`watchdog/zhora.js`) — watchdog that monitors Snezhanna's health and auto-restarts if needed

## Setup

1. Clone the repo to your VPS
2. Copy `.env.example` to `.env` and fill in all values
3. Place Google OAuth2 credentials in `credentials.json` (Desktop-type client)
4. Install dependencies:
   ```bash
   npm install
   ```
5. Set up Yandex Disk WebDAV mounts (see `setup.sh`)
6. Deploy systemd services:
   ```bash
   sudo cp systemd/snezhanna.service /etc/systemd/system/
   sudo cp watchdog/zhora.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now snezhanna zhora
   ```

## Running

```bash
node index.js          # production
node index.js --debug  # debug mode
```

## Google Authorization

On first run, Snezhanna sends a Google auth URL via Telegram. Visit the URL, copy the code, and send `/auth <code>` to the bot.

## Bot Commands

- `/reset` — clear conversation history
- `/status` — show service status
- `/auth <code>` — complete Google OAuth flow

## Scheduled Tasks

- **08:00** — morning briefing (calendar + tasks)
- **19:00** — evening check-in (tomorrow's events)
- **Sunday 10:00** — weekly digest
- **Every 10 min** — calendar reminders (30 min before events)

All times are Europe/Madrid.
