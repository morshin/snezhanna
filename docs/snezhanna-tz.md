# Technical Specification: Personal AI Assistant «Snezhanna»

> **Version:** 2.0 (updated 2026-03-16)
> This document reflects the **actual current state** of the project.

---

## Overview

Personal AI assistant running on an Ubuntu VM inside Proxmox on a Hetzner dedicated server.
The assistant communicates via **Telegram** (text + voice + photos), runs 24/7, and proactively messages the owner on schedule.

The project consists of **three independent processes**:

| Process | File | Description |
|---------|------|-------------|
| **Snezhanna** | `index.js` | Main assistant bot |
| **Max** | `tutor/index.js` | Tutor bot for Vova's son |
| **Zhora** | `watchdog/zhora.js` | Watchdog monitoring both bots |

---

## Infrastructure

| Component | Details |
|-----------|---------|
| Physical server | Hetzner dedicated, 2x 477GB SSD RAID1 |
| Hypervisor | Proxmox VE |
| VM | Ubuntu 22.04 LTS, 2 vCPU, 2GB RAM, 20GB disk |
| VM ID | 101, name: Snezhanna |
| VM network | vmbr1 (internal), IP: `<VM_IP>` |
| Proxmox host | `<SERVER_IP>` (vmbr0, external) |
| SSH access | Via Jump Host: `ssh -J root@<SERVER_IP> vova@<VM_IP>` |
| VS Code / Cursor | Remote SSH profile: `snezhanna` (via ProxyJump) |
| Project path | `/opt/snezhanna` |
| System user | `snezhanna` (runs all agent processes) |

### SSH config (Windows `~/.ssh/config`)

```
Host proxmox
    HostName <SERVER_IP>
    User root

Host snezhanna
    HostName <VM_IP>
    User vova
    ProxyJump proxmox
    IdentityFile ~/.ssh/id_ed25519
```

---

## Personality & Communication Style

- **Name:** Snezhanna (she/her)
- **Owner:** Vova (variations by context/mood: Володя, Вовик, Вов, Вовена, Влади)
- **Language:** Russian always, unless Vova switches to another
- **Style:** warm, lively, with humor, informal. Not a robot — a smart assistant with character.
- **Timezone:** Europe/Madrid

Examples:
- Morning: "Доброе утро, Вовик! Вот твой план на сегодня..."
- Task done: "Готово, Вова 🎉"
- Something wrong: "Вовик, тут небольшая проблема..."

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Agent | Custom Node.js (`index.js`) — **not nanobot** |
| Channel | Telegram Bot API (`node-telegram-bot-api`) |
| Brain | Anthropic Claude (`claude-sonnet-4-6`) via `@anthropic-ai/sdk` |
| Voice transcription | OpenAI Whisper API (`whisper-1`) |
| Voice responses | OpenAI TTS API (`tts-1`, voice: `nova`) |
| Photo/vision | Telegram photo download → base64 → Claude vision |
| Web search | Anthropic native web search (`web_search_20250305`, server-side) |
| Email attachments | PDF (`pdf-parse`), XLSX (`xlsx`), DOCX (`mammoth`) |
| File storage | Google Drive API v3 via `googleapis` |
| Scheduled tasks | `node-cron` |
| HTTP client | `axios` |
| HTTP server (Mini App) | Node.js built-in `http` module — serves Mini App API + static files |
| Process manager | systemd |
| Runtime | Node.js 22.x |
| Package manager | npm 10.x |
| Repository | GitHub: `github.com/morshin/snezhanna` |

---

## GitHub Repository

Private repo `snezhanna` — all custom code lives here.

### Structure

```
snezhanna/
  ├── .env.example
  ├── .env                  # ← gitignored
  ├── .gitignore
  ├── package.json
  ├── package-lock.json
  ├── README.md
  ├── CLAUDE.md             # AI assistant guidance
  ├── index.js              # Snezhanna main entrypoint
  ├── setup.sh              # Initial server setup script
  ├── config/
  │   └── nanobot.json      # Config: model, tokens, timezone, gdrive, user, integrations
  ├── identity/
  │   ├── IDENTITY.md             # Snezhanna's system prompt ({{USER_NAME}}/{{ASSISTANT_NAME}} placeholders)
  │   └── IDENTITY.template.md   # Neutral starter template for new instances
  ├── lib/
  │   ├── attachments.js    # Email attachment parsing (PDF/XLSX/DOCX)
  │   ├── api.js            # HTTP API server for Mini App (task/calendar/settings/chats/projects/contacts CRUD + GET /api/system/status + POST /api/system/restart)
  │   ├── chat-monitor.js   # Telegram chat monitor — reads from SQLite monitored_chats; addChat/removeChat
  │   ├── db.js             # SQLite init (better-sqlite3), all table schemas, helper exports
  │   ├── disk-log.js       # In-memory Google Drive write operation log
  │   ├── file-cache.js     # File content cache
  │   ├── gdrive.js         # Google Drive API: folder/file CRUD, search, uploads, backups
  │   ├── google.js         # Google Calendar + Gmail + Drive OAuth2
  │   ├── memory.js         # Memory CRUD backed by SQLite memory table
  │   ├── races.js          # Strava race management (Google Drive)
  │   ├── settings.js       # Key-value user settings (SQLite user_settings); getSystemPromptBlock()
  │   ├── state.js          # Persist chatId + briefing/silence/vacation state + onboarding progress to .nanobot/state.json (overrideable via STATE_FILE)
  │   ├── onboarding.js     # First-run onboarding wizard state machine (check→name→style→briefing…chats)
  │   ├── strava.js         # Strava API: weekly sync, fitness digest (Google Drive)
  │   ├── tasks.js          # Task tracking (Eisenhower matrix, SQLite)
  │   ├── tools.js          # All Claude tool definitions + executeTool dispatcher
  │   ├── reply-chain.js    # Shared reply context builder for Telegram replies
  │   ├── vision.js         # Photo: download from Telegram, base64, image blocks
  │   ├── whisper.js        # OpenAI Whisper transcription + TTS
  │   ├── workload.js       # Workload & Wellbeing scoring; history in SQLite workload_history
  │   ├── yadisk-dirs.js    # Project/doc CRUD (SQLite); saveFile uploads to Google Drive
  │   └── yadisk.js         # search_files/read_file tools — delegates to gdrive.js
  ├── mini-app/
  │   └── index.html        # Telegram Mini App frontend — Tasks + Calendar + Settings modal
  ├── docs/
  │   ├── snezhanna-tz.md           # This document
  │   ├── new-instance-setup.md     # Guide for deploying a second instance on the same VPS
  │   ├── deploy-new-server.md      # Guide for deploying a tenant on a fresh server (no Zhora; Mini App status/restart)
  │   ├── tutor-bot-tz.md           # Max tutor bot spec
  │   ├── tz-strava.md              # Strava integration spec
  │   ├── tz-task-tracking.md       # Task tracking spec
  │   ├── tz-tasks-mini-app.md     # Tasks Mini App spec
  │   ├── tz-miniapp-calendar-tab.md  # Calendar tab spec
  │   ├── tz-calendar-metadata.md   # Calendar metadata spec
  │   ├── snezhanna-workload-scoring-tz.md  # Workload scoring spec
  │   ├── tz-1-conversational-briefing.md   # TZ-1: conversational briefing gate
  │   ├── tz-2-sqlite-migration.md          # TZ-2: SQLite migration spec
  │   ├── tz-3-settings-miniapp.md          # TZ-3: Settings Mini App spec
  │   └── backlog.md                # Future improvements backlog
  ├── skills/
  │   ├── google-calendar.md
  │   ├── gmail.md
  │   ├── gdrive.md                 # Google Drive storage skill
  │   ├── memory.md
  │   ├── strava.md
  │   └── kids.md
  ├── systemd/
  │   ├── snezhanna.service
  │   └── snezhanna.service.template   # Template for multi-instance deploys
  ├── schedules/
  │   └── heartbeats.json   # Documentation of all cron jobs (not loaded at runtime)
  ├── tutor/
  │   ├── index.js          # Max tutor bot entrypoint
  │   ├── schedules/
  │   │   └── crons.js
  │   ├── lib/
  │   │   ├── claude.js     # Anthropic API wrapper for Max
  │   │   ├── lang-week.js  # Weekly language topic rotation
  │   │   ├── report.js     # Session/daily/weekly report generation
  │   │   ├── session.js    # In-memory tutoring session state
  │   │   ├── storage.js    # Local file I/O for KIDS_DATA_DIR (/opt/snezhanna/data/kids)
  │   │   └── telegram.js   # Telegram helpers for tutor bot
  │   ├── identity/
  │   │   └── IDENTITY.md   # Max's system prompt
  │   └── systemd/
  │       └── tutor.service
  ├── watchdog/
  │   ├── zhora.js
  │   └── zhora.service
  └── systemd/
      └── snezhanna.service
```

### .gitignore

```
.env
credentials.json
node_modules/
*.log
.nanobot/
token.json
*.key
*.pem
```

### package.json

```json
{
  "name": "snezhanna",
  "version": "1.0.0",
  "description": "Personal AI assistant Snezhanna",
  "private": true,
  "main": "index.js",
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "axios": "^1.7.9",
    "dotenv": "^16.4.7",
    "form-data": "^4.0.1",
    "googleapis": "^144.0.0",
    "mammoth": "^1.11.0",
    "node-cron": "^3.0.3",
    "node-telegram-bot-api": "^0.67.0",
    "pdf-parse": "^2.4.5",
    "xlsx": "^0.18.5"
  },
  "scripts": {
    "start": "node index.js",
    "dev": "node index.js --debug"
  }
}
```

---

## Environment Variables

```bash
# Anthropic (Claude — Snezhanna's brain)
ANTHROPIC_API_KEY=

# Telegram — Snezhanna bot
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_ID=

# Telegram — Zhora watchdog bot (separate bot!)
WATCHDOG_BOT_TOKEN=

# OpenAI (Whisper transcription + TTS voice responses)
OPENAI_API_KEY=

# Google OAuth (created under personal Google account)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Strava (optional — fitness tracking)
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REFRESH_TOKEN=

# Tutor bot — Max (son's study assistant)
TUTOR_BOT_TOKEN=           # bot token from @BotFather
TUTOR_ALLOWED_USER_ID=     # son's numeric Telegram ID
KIDS_DATA_DIR=             # kids data dir (default: /opt/snezhanna/data/kids)

# Multi-instance overrides (optional)
GOOGLE_TOKEN_FILE=         # path to OAuth token (default: ./token.json)
GOOGLE_CREDENTIALS_FILE=   # path to credentials.json (default: ./credentials.json)
STATE_FILE=                # path to state file (default: ./.nanobot/state.json)
```

---

## Integrations

### 1. Telegram (main channel)

- Accept text messages
- Accept voice messages → transcribe via Whisper → process as text
- Accept photos → download → base64 encode → send to Claude as vision message
- Accept document/file attachments → parse (PDF, XLSX, DOCX) → forward content to Claude
- Optionally respond with voice via TTS
- Telegram checklist support — Vova can check off tasks directly in the app
- **Only one user allowed** (`TELEGRAM_ALLOWED_USER_ID`) — all others ignored

### 2. Google Calendar

- Read events for today and upcoming days
- Create events (including recurring via RRULE)
- Update events by ID
- Delete events (single instance or entire series)
- OAuth2 via `credentials.json` (Desktop-type OAuth2 client)
- Google Cloud project under personal Google account
- APIs enabled: Google Calendar API, Gmail API, Google Drive API
- Scopes: `calendar`, `gmail.modify`, `drive`

### 3. Gmail

- Dedicated email for Snezhanna (configured per instance)
- Vova's work mail is auto-forwarded here
- Read inbox (last N unread emails, metadata)
- Read full email content by ID
- Read attachments (PDF, XLSX, DOCX — up to 10 MB)
- Create draft replies on request
- Mark emails as read / archive / add label
- Automatic email monitoring every 30 min — digest with categories (task / event / project update / info / spam)
- **Never send automatically** — only with explicit confirmation

### 4. Google Drive

All file storage is in Google Drive under a root folder (`config.gdrive.root_folder`, default `"Снежанна"`).

```
Снежанна/
  ├── memory/        — health.md, kids.md, finance.md, bureaucracy.md, decisions.md
  ├── fitness/
  │   ├── weekly/    — YYYY-WNN.json + YYYY-WNN-summary.md
  │   └── races/     — {date}_{name}/README.md, plan.md, gear.md, result.md
  ├── drafts/
  ├── digests/
  ├── inbox/         — default destination for Telegram file saves
  ├── backups/       — snezhanna_YYYYMMDD.db (daily SQLite backup, keep 7)
  └── workload-history.json
```

**`lib/gdrive.js`** — Drive abstraction layer:
- Folder and file ID caches (`Map`) to minimise API calls
- `readFile(path)` / `writeFile(path, content)` / `appendFile(path, content)`
- `uploadBinary(path, buffer, mimeType)` for binary files (backups, Telegram attachments)
- `searchFiles(query)` — full-text search using Drive API
- `pruneBackups(folderPath, keepN)` — delete oldest backup files
- `ensureDirs()` — creates required folder structure on startup

Requires Google OAuth with `drive` scope (in addition to `calendar` and `gmail.modify`).

### 5. Strava (fitness tracking)

- Weekly activity sync every Sunday at 09:30 → saved to Google Drive `fitness/weekly/`
- Each week: `YYYY-WNN.json` (raw API data) + `YYYY-WNN-summary.md` (human-readable)
- Race management: create folders in Google Drive `fitness/races/{date}_{name}/`
- Sunday digest includes fitness block: current week vs previous, Snezhanna's commentary
- Requires `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN` in `.env`
- Optional: bot works without Strava if env vars are missing

### 6. Task Tracking

- Free-form task input → stored as JSON on Yandex.Disk
- Eisenhower Matrix prioritization (urgent × important → Q1/Q2/Q3/Q4)
- Per-project tasks (stored in `projects/{name}/tasks.json`) and global tasks (`tasks/tasks.json`)
- Morning briefing includes top tasks sorted by quadrant
- Evening check-in sends native Telegram checklist (Vova can check off tasks in-app)
- See `docs/tz-task-tracking.md` for full spec

### 7. Mini App (Tasks + Calendar)

- Telegram Mini App accessible via the bot's Menu Button
- Two-tab interface: **Tasks** (Eisenhower task list) and **Calendar** (day timeline / week list)
- Frontend: single-file `mini-app/index.html` using Telegram theme variables (`var(--tg-theme-*)`)
- Backend: `lib/api.js` — lightweight HTTP server using Node's built-in `http` module (no new dependencies)
- API validates Telegram `initData` via HMAC-SHA256 using `TELEGRAM_BOT_TOKEN`
- Task API routes: `GET /api/tasks`, `POST /api/tasks/:id/complete`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`
- Calendar API routes: `GET /api/calendar/day`, `GET /api/calendar/week` — reads from `lib/google.js`
- Settings API routes: `GET/POST /api/settings`, `POST /api/settings/batch`, `POST /api/quiet`
- Chats API routes: `GET/POST /api/chats`, `DELETE /api/chats/:chat_id`
- Projects API routes: `GET/POST /api/projects`, `PATCH /api/projects/:id`, `GET/POST /api/projects/:id/params`
- Contacts API routes: `GET/POST /api/contacts`, `PATCH/DELETE /api/contacts/:id`, contact↔project linking
- All task/settings mutations go through respective `lib/*.js` modules — no direct DB access in api.js for logic
- Port configured in `config/nanobot.json → mini_app.port` (default 3001)
- Requires HTTPS reverse proxy (nginx/caddy) for Telegram Mini App requirement
- Mini App frontend has 3 tabs: Tasks, Calendar, Settings (gear icon → full-screen modal)
- See `docs/tz-tasks-mini-app.md`, `docs/tz-miniapp-calendar-tab.md`, `docs/tz-3-settings-miniapp.md` for specs

### 8. Chat Monitoring

- Snezhanna passively monitors specified Telegram chats (family + work)
- Monitored chats stored in SQLite `monitored_chats` table (migrated from `config/nanobot.json → chat_monitor.chats`)
- Add/remove chats via Mini App Settings → Chats, or via Claude conversation
- In-memory message store (cleared after evening check-in)
- Messages available to Claude as context when Vova asks about them
- Evening check-in includes summary of disk write operations (via `lib/disk-log.js`)

### 9. Web Search

- Anthropic native web search tool (`web_search_20250305`)
- Server-side, no local execution needed
- Claude can search for current info: exchange rates, news, weather, etc.

### 10. Reply Context (Telegram Replies)

When a user replies to a specific message in Telegram (or quotes a part of it), the bot extracts the original message and prepends it as context before sending to Claude.

**Implementation:** shared utility `lib/reply-chain.js`, used by both Snezhanna and Max.

**Context sources (priority order):**
1. `msg.quote.text` — if user selected a specific text fragment when replying
2. `msg.reply_to_message.text` — full text of the message being replied to
3. In-memory history chain — walks `message_id` → `reply_to_message_id` links to reconstruct deeper reply chains (reply-to-reply-to-reply)

**Limits:**
- Max chain depth: 5 messages
- Max per-message length: 500 chars (truncated with `…`)
- Max total context block: 2000 chars

**Format for single reply:**
```
[Reply to message]
> Snezhanna: Here are three options...

User's new message text
```

**Format for chain (2+ levels):**
```
[Message chain]
> (1) Snezhanna: Original question...
> (2) User: First reply...
> (3) Snezhanna: Follow-up...

User's new message text
```

**History metadata:** each history entry stores optional `message_id` and `reply_to_message_id` fields for chain reconstruction. These fields are stripped before sending to the Anthropic API (`messages.map(({ role, content }) => ({ role, content }))`).

---

## Google Drive Structure

Root folder: `Снежанна` (configurable via `config.gdrive.root_folder`).

```
Снежанна/
  ├── memory/
  │   ├── health.md
  │   ├── kids.md
  │   ├── finance.md
  │   ├── bureaucracy.md
  │   └── decisions.md
  ├── fitness/
  │   ├── weekly/
  │   │   ├── YYYY-WNN.json
  │   │   └── YYYY-WNN-summary.md
  │   └── races/
  │       └── {date}_{name}/
  │           ├── README.md
  │           ├── plan.md
  │           ├── gear.md
  │           └── result.md
  ├── inbox/             ← default save_file destination
  ├── drafts/
  ├── digests/
  ├── backups/           ← snezhanna_YYYYMMDD.db (keep 7)
  └── workload-history.json
```

**Note:** Tasks and projects are in local SQLite (`data/snezhanna.db`), not Drive.
Max (tutor) writes to local `KIDS_DATA_DIR` (`/opt/snezhanna/data/kids`). These files are not in Drive.

---

## Schedule (Heartbeat / Cron Jobs)

All times are in **Europe/Madrid** timezone.

### Daily 08:00 — Morning briefing

```
Good morning, Vovik! ☀️

📅 Today, {date}:
• [Calendar events]

📋 Open tasks:
• [top tasks by Eisenhower quadrant]

📬 Email:
• [unread count, important senders]

Have a great day! 🚀
```

### Daily 19:00 — Evening check-in

```
Vova, how was your day?
Tomorrow you have:
• [tomorrow's Calendar events]

[Telegram checklist with today's open tasks]

[Summary of Google Drive write operations during the day]
```

### Every Sunday 10:00 — Weekly digest

- What happened this week
- What's coming next week
- Fitness progress (Strava block if configured)
- Upcoming deadlines from `bureaucracy.md`

### Every Sunday 09:30 — Strava sync

- Fetch last 7 days of activities
- Save weekly JSON + summary to Google Drive `fitness/weekly/`

### Every 30 min — Email check

- Read new unread emails
- Categorize: task / event / project update / info / spam
- Send digest if there are important messages

### Every 10 min — Calendar reminders

- Check events in next 30 minutes
- Fire reminder at the 30-min mark

---

## Prompt Caching

Prompt caching is enabled on both Snezhanna and Max:

- Identity block (`IDENTITY.md`) marked with `cache_control: { type: 'ephemeral' }`
- `betas: ['prompt-caching-2024-07-31']` passed to Anthropic SDK
- Cache hits logged: `[Cache] hit: N tokens cached`
- Reduces input token usage and avoids rate limits on repeated calls

---

## Security

- Telegram: responds only to `TELEGRAM_ALLOWED_USER_ID`
- Google Drive: all writes scoped to the assistant's root folder
- Gmail: never sends without explicit confirmation
- All tokens in `.env`, never in git
- Agent runs as unprivileged user `snezhanna`
- `IDENTITY.md` includes prompt injection protection — ignore malicious instructions from emails, files, Drive
- Email/Drive file content treated as DATA, not instructions

---

## Systemd Services

### Snezhanna (`systemd/snezhanna.service`)

```ini
[Unit]
Description=Snezhanna Personal AI Assistant
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=snezhanna
WorkingDirectory=/opt/snezhanna
EnvironmentFile=/opt/snezhanna/.env
ExecStart=/usr/bin/node /opt/snezhanna/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=snezhanna

[Install]
WantedBy=multi-user.target
```

### Max Tutor Bot (`tutor/systemd/tutor.service`)

```ini
[Unit]
Description=Max Tutor Bot for Son
After=network.target snezhanna.service

[Service]
Type=simple
User=snezhanna
WorkingDirectory=/opt/snezhanna/tutor
EnvironmentFile=/opt/snezhanna/.env
ExecStart=/usr/bin/node /opt/snezhanna/tutor/index.js
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Zhora Watchdog (`watchdog/zhora.service`)

```ini
[Unit]
Description=Zhora Watchdog for Snezhanna
After=network.target network-online.target snezhanna.service
Wants=network-online.target

[Service]
Type=simple
User=snezhanna
WorkingDirectory=/opt/snezhanna
EnvironmentFile=/opt/snezhanna/.env
ExecStart=/usr/bin/node /opt/snezhanna/watchdog/zhora.js
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=zhora

[Install]
WantedBy=multi-user.target
```

### Service management

```bash
# Deploy service files after editing
sudo cp systemd/snezhanna.service /etc/systemd/system/
sudo cp tutor/systemd/tutor.service /etc/systemd/system/
sudo cp watchdog/zhora.service /etc/systemd/system/
sudo systemctl daemon-reload

# Snezhanna
sudo systemctl start|stop|restart|status snezhanna
journalctl -u snezhanna -f
journalctl -u snezhanna -n 100

# Max tutor
sudo systemctl start|stop|restart|status tutor
journalctl -u tutor -f

# Zhora
sudo systemctl start|stop|restart|status zhora
journalctl -u zhora -f
```

---

## Watchdog «Zhora»

Separate sysadmin service. Independent from Snezhanna. Uses its own Telegram bot.

### Checks every 5 minutes

1. **Snezhanna** process — `systemctl is-active snezhanna`
2. **Max (tutor)** process — `systemctl is-active tutor`
3. **Telegram Bot API** — ping api.telegram.org
4. **Server disk** — not over 85%
6. **Error logs** — no repeating critical errors in last 10 min

### Response scenarios

- Snezhanna down → restart → report result
- Tutor (Max) down → restart → report result
- Disk > 85% → warn Vova
- Telegram API down → report when restored
- All good → silent

### Commands

Zhora listens via long polling. Only responds to `TELEGRAM_ALLOWED_USER_ID`.

| Command | Description |
|---------|-------------|
| `/status` | Full status report (all services + disk + logs) |
| `/logs [snezhanna\|max\|index] [N]` | Last N log lines (default: 30) |
| `/restart [snezhanna\|max]` | Request restart with confirmation |
| `/restart_confirm` | Confirm pending restart |

### `/status` response example

```
🤖 Zhora reporting:

Snezhanna: ✅ active (uptime 3d 14h)
Max: ✅ active (uptime 3d 14h)
Telegram API: ✅
Disk readonly: ✅
Disk agent: ✅
Server space: 42%
Log errors: none
```

### Morning report at 07:55

```
🤖 Zhora reporting: all systems nominal.
Snezhanna ready ✅
```

---

## Max Tutor Bot

Separate Telegram bot for Vova's son. See `docs/tutor-bot-tz.md` for full spec.

**Summary:**
- Always responds in Spanish; understands Russian but redirects to Spanish
- Pedagogical approach: never gives answers, asks guiding questions
- Onboarding: collects school timetable day by day → `schedule.json`
- Homework tracking: afternoon checkin (15:00) → auto-parsed → `homework.json`
- Photo support (homework photos, textbook pages) via shared `lib/vision.js`
- Voice support via shared `lib/whisper.js` with `language='es'`
- Prompt caching enabled
- Reports to `KIDS_DATA_DIR` (`/opt/snezhanna/data/kids`)
- Commands: `/start`, `/done`, `/schedule`, `/homework`, `/reset`, `/status`

---

## Google OAuth flow

1. On startup (or on `/status`), if `token.json` is missing, Snezhanna sends Vova a Google auth URL
2. Vova visits the URL, copies the code, sends `/auth <code>` to the bot
3. `lib/google.js::saveToken()` exchanges the code and writes `token.json`
4. Scopes: `calendar` (read/write) and `gmail.modify`

---

## Configuration (`config/nanobot.json`)

Single source of truth for static runtime config. Dynamic user preferences are stored in SQLite `user_settings` (via `lib/settings.js`):

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 4096,
  "temperature": 1.0,
  "timezone": "Europe/Madrid",
  "language": "ru",
  "voice": {
    "transcription_model": "whisper-1",
    "transcription_language": "ru",
    "tts_model": "tts-1",
    "tts_voice": "nova"
  },
  "history": {
    "max_messages": 40,
    "keep_last": 30
  },
  "mini_app": {
    "port": 3001
  }
}
```

### User Settings (SQLite `user_settings`)

Dynamic preferences edited via Mini App or Claude conversation (`update_my_preferences` tool):

| Key | Default | Description |
|-----|---------|-------------|
| `preferred_name` | `Вовик` | How Snezhanna addresses Vova |
| `formality` | `informal` | `formal` or `informal` |
| `response_style` | `concise` | `concise` or `detailed` |
| `briefing_time` | `08:00` | Morning briefing HH:MM; changes reschedule the cron job live |
| `github_enabled` | `true` | Include GitHub milestones in briefing |
| `strava_enabled` | `true` | Include Strava in weekly digest |
| `email_poll_interval` | `30` | Minutes between email checks: 15, 30, or 60 |

---

## State & Credentials

| File | Purpose | Gitignored |
|------|---------|-----------|
| `.nanobot/state.json` | Snezhanna's chatId | ✅ |
| `tutor/.tutor-state.json` | Max's chatId | ✅ |
| `token.json` | Google OAuth token | ✅ |
| `credentials.json` | Google OAuth2 Desktop credentials | ✅ |
| `.env` | All secrets | ✅ |

---

## What Was Done — Infrastructure ✅

- ✅ Proxmox VM created (ID 101, Ubuntu 22.04, 2CPU, 2GB RAM, 20GB disk, vmbr1)
- ✅ Ubuntu 22.04 installed, user `vova` created
- ✅ Node.js v22.x installed
- ✅ tmux and git installed
- ✅ qemu-guest-agent installed
- ✅ System user `snezhanna` created at `/opt/snezhanna`
- ✅ SSH keys configured (Windows → Proxmox jump → VM)
- ✅ Cursor Remote SSH configured with ProxyJump
- ✅ GitHub repo `morshin/snezhanna` created (private)
- ✅ GitHub SSH key added
- ✅ Google Cloud project created (personal account)
- ✅ Google Calendar API + Gmail API enabled
- ✅ OAuth 2.0 Desktop credentials → `credentials.json`
- ✅ Personal Gmail added as OAuth test user
- ✅ Snezhanna dedicated email created
- ✅ Telegram bot Snezhanna created
- ✅ Telegram bot Zhora created
- ✅ Telegram bot Max created
- ✅ Anthropic API key created
- ✅ OpenAI API key created (Whisper + TTS)
- ✅ `.env` filled with all tokens
- ✅ davfs2 installed, WebDAV mounts configured in `/etc/fstab`
- ✅ All three systemd services active and enabled
- ✅ Agent folder structure created on Yandex.Disk
