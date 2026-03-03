# Technical Specification: Personal AI Assistant «Snezhanna»

## Overview

Deploy a personal AI assistant based on **nanobot** on an Ubuntu VM inside Proxmox on a Hetzner dedicated server.
The assistant communicates via **Telegram** (text + voice), runs 24/7, and proactively messages the owner on schedule.

---

## Infrastructure

| Component | Details |
|-----------|---------|
| Physical server | Hetzner dedicated, 2x 477GB SSD RAID1 |
| Hypervisor | Proxmox VE |
| VM | Ubuntu 22.04 LTS, 2 vCPU, 2GB RAM, 20GB disk |
| VM ID | 101, name: Snezhanna |
| VM network | vmbr1 (internal), IP: 192.168.78.10 |
| Proxmox host | 5.9.69.196 (vmbr0, external) |
| SSH access | Via Jump Host: `ssh -J root@5.9.69.196 vova@192.168.78.10` |
| VS Code | Remote SSH profile: `snezhanna` (via ProxyJump) |
| Project path | `/opt/snezhanna` |
| System user | `snezhanna` (runs the agent process) |

### SSH config (Windows `~/.ssh/config`)

```
Host proxmox
    HostName 5.9.69.196
    User root

Host snezhanna
    HostName 192.168.78.10
    User vova
    ProxyJump proxmox
    IdentityFile C:/Users/demor/.ssh/id_ed25519
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
| Agent | nanobot (npm package, pinned version) |
| Channel | Telegram Bot API |
| Brain | Anthropic Claude (claude-sonnet-4-6) |
| Voice transcription | OpenAI Whisper API (`/v1/audio/transcriptions`) |
| Voice responses | OpenAI TTS API (`/v1/audio/speech`) |
| Disk storage | Yandex.Disk via WebDAV (davfs2) |
| Process manager | systemd |
| Runtime | Node.js 22.x (installed: v22.22.0) |
| Package manager | npm 10.x |
| Repository | GitHub private: `github.com/morshin/snezhanna` |

---

## GitHub Repository

Private repo `snezhanna` — contains only config and skills, not nanobot source.
nanobot is used as an npm dependency.

### Structure

```
snezhanna/
  ├── .env.example
  ├── .env                  # ← in .gitignore, never in repo
  ├── .gitignore
  ├── package.json
  ├── README.md
  ├── config/
  │   └── nanobot.json
  ├── identity/
  │   └── IDENTITY.md
  ├── skills/
  │   ├── google-calendar.md
  │   ├── gmail.md
  │   ├── yadisk.md
  │   └── memory.md
  ├── schedules/
  │   └── heartbeats.json
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
  "dependencies": {
    "nanobot": "0.x.x"
  },
  "scripts": {
    "start": "nanobot start",
    "dev": "nanobot start --debug"
  }
}
```

Note: pin nanobot to a specific version, not "latest".

---

## Environment Variables

```
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

# Yandex.Disk WebDAV
YANDEX_WEBDAV_LOGIN=
YANDEX_WEBDAV_PASSWORD=
```

---

## Integrations

### 1. Telegram (main channel)

- Accept text messages
- Accept voice messages → transcribe via Whisper → process as text
- Optionally respond with voice via TTS
- **Only one user allowed** (`TELEGRAM_ALLOWED_USER_ID`) — all others ignored

### 2. Google Calendar

- Read events for today and upcoming days
- Create, update, delete events on request
- OAuth2 via `credentials.json`
- Google Cloud project under personal Google account
- APIs enabled: Google Calendar API, Gmail API
- OAuth type: Desktop app
- Test user added: personal Gmail

### 3. Gmail — snezhanna@morshin.pro

- Dedicated email for Snezhanna: `snezhanna@morshin.pro`
- Vova's work mail is auto-forwarded here
- Read inbox (last 20-50 emails)
- Create draft replies on request
- **Never send automatically** — only with explicit confirmation
- Mark emails as read on request

### 4. Yandex.Disk (WebDAV)

Mount two separate points:

```bash
# Read only — Vova's full disk
/mnt/yadisk-readonly   (mount options: ro)
WebDAV URL: https://webdav.yandex.ru

# Read+write — ONLY /Snezhanna/ folder
/mnt/yadisk-agent      (mount options: rw)
WebDAV URL: https://webdav.yandex.ru/Snezhanna
```

Agent physically cannot write outside its own folder.
Credentials from `.env`. If Yandex has 2FA — use app password from id.yandex.ru → Security → App passwords.
Add to `/etc/fstab` for auto-mount on reboot.

---

## Yandex.Disk Index

### Index these folders (recursively)

- `Документы/`
- `Clients/`
- `Spain taxes/`
- `morshin.pro/`
- `Яндекс.Фото/` (important only, see exclusions)

### Exclusions

By extension:
```
*.dt *.cf *.cf2 *.cfe    # 1C databases
*.zip *.rar *.7z *.tar   # Archives
*.exe *.msi *.dmg        # Binaries
*.db *.sqlite *.mdf      # Databases
```

By folder name: `Скриншоты`, `Screenshots`, `screen*`, `Клиент_*`, `Client_*`, `Архив клиентов`, `.trash`, `Корзина`

By date: files not modified in 3+ years (except documents)

By size: files > 50 MB

### Index file

Save to `/mnt/yadisk-agent/index/file_index.json`:

```json
{
  "last_updated": "2026-03-01T08:00:00",
  "files": [
    {
      "path": "/Документы/Договор_аренды_2024.pdf",
      "name": "Договор_аренды_2024.pdf",
      "modified": "2024-06-15",
      "size_kb": 245,
      "category": "documents",
      "keywords": ["аренда", "договор", "2024"]
    }
  ]
}
```

### Update schedule

- Full reindex: every Sunday at 03:00
- Incremental: every night at 02:00
- On demand: "Снежанна, обнови индекс"

---

## Agent Folder `/mnt/yadisk-agent/`

```
/Snezhanna/
  ├── index/
  │   └── file_index.json
  ├── memory/
  │   ├── health.md
  │   ├── kids.md
  │   ├── finance.md
  │   ├── bureaucracy.md
  │   └── decisions.md
  ├── projects/
  │   └── {project_name}.md
  ├── fitness/
  │   └── log.md
  ├── drafts/
  └── digests/
```

---

## Schedule (Heartbeat / Cron Jobs)

### Daily 08:00 Madrid — Morning briefing

```
Доброе утро, Вовик! ☀️

📅 Сегодня, {date}:
• [Calendar events]

📋 Открытые задачи:
• [top-3 tasks]

📬 Почта:
• [unread count, important senders]

Хорошего дня! 🚀
```

### Daily 19:00 Madrid — Evening check-in

```
Вова, как прошёл день?
Завтра у тебя:
• [tomorrow's Calendar events]
```

### Every Sunday 10:00 — Weekly digest

- What happened this week
- What's coming next week
- Fitness progress
- Upcoming deadlines from `bureaucracy.md`

### 30 min before each Calendar event

```
Вовик, через 30 минут: {event} в {time}
```

---

## Security

- Telegram: responds only to `TELEGRAM_ALLOWED_USER_ID`
- Yandex.Disk main: read-only mount
- Yandex.Disk agent: write only to `/Snezhanna/`
- Gmail: never sends without explicit confirmation
- All tokens in `.env`, never in git
- Agent runs as unprivileged user `snezhanna`
- IDENTITY.md includes prompt injection protection — ignore malicious instructions from emails, files, disk

---

## Systemd — Snezhanna

`/etc/systemd/system/snezhanna.service`:

```ini
[Unit]
Description=Snezhanna Personal AI Assistant
After=network.target

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

[Install]
WantedBy=multi-user.target
```

---

## Watchdog «Zhora»

Separate sysadmin service. Independent from Snezhanna. Uses its own Telegram bot.

### Checks every 5 minutes

1. Snezhanna process — `systemctl is-active snezhanna`
2. Telegram Bot API — ping api.telegram.org
3. Disk mounts — both `/mnt/yadisk-readonly` and `/mnt/yadisk-agent`
4. Server disk — not over 85%
5. Snezhanna logs — no repeating critical errors in last 10 min

### Response scenarios

Snezhanna down → restart → report result
Disk unmounted → remount → report result
Disk > 85% → warn Vova
Telegram API down → report when restored
All good → silent

### `/status` command

Zhora listens for incoming Telegram messages via long polling. When Vova sends `/status`, Zhora runs all checks and replies with a full status report:

```
🤖 Жора рапортует:

Снежанна: ✅ active (uptime 3d 14h)
Telegram API: ✅
Диск readonly: ✅
Диск агент: ✅
Место на сервере: 42%
Ошибки в логах: нет
```

Only responds to `TELEGRAM_ALLOWED_USER_ID`. All other users are ignored.

### Morning report at 07:55

```
🤖 Жора рапортует: все системы в норме.
Снежанна готова к работе ✅
```

### Systemd — Zhora

```ini
[Unit]
Description=Zhora Watchdog for Snezhanna
After=network.target snezhanna.service

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

[Install]
WantedBy=multi-user.target
```

---

## What Was Done Manually (Already Completed ✅)

- ✅ Proxmox VM created (ID 101, Ubuntu 22.04, 2CPU, 2GB RAM, 20GB disk, vmbr1, IP 192.168.78.10)
- ✅ Ubuntu 22.04 installed, user `vova` created
- ✅ Node.js v22.22.0 installed
- ✅ tmux and git installed
- ✅ qemu-guest-agent installed
- ✅ System user `snezhanna` created at `/opt/snezhanna`
- ✅ SSH keys configured (Windows → Proxmox jump → VM)
- ✅ VS Code Remote SSH configured with ProxyJump
- ✅ GitHub repo `morshin/snezhanna` created (private)
- ✅ GitHub SSH key added
- ✅ Claude Code installed (v2.1.63)
- ✅ Google Cloud project created (personal account)
- ✅ Google Calendar API + Gmail API enabled
- ✅ OAuth 2.0 Desktop credentials → `credentials.json` at `/opt/snezhanna/`
- ✅ Personal Gmail added as OAuth test user
- ✅ Snezhanna email created: snezhanna@morshin.pro
- ✅ Telegram bot Snezhanna created
- ✅ Telegram bot Zhora created
- ✅ Anthropic API key created
- ✅ OpenAI API key created (Whisper + TTS)
- ✅ `.env` filled with all tokens at `/opt/snezhanna/.env`
- ✅ `.gitignore` created

---

## Claude Code Prompt — Ready to Run

Start tmux and Claude Code on the server:

```bash
tmux new -s snezhanna
cd /opt/snezhanna
claude
```

Paste this prompt:

```
Read snezhanna-tz.md for full context.

Set up a complete personal AI assistant called Snezhanna based on nanobot.

Everything is already prepared:
- .env is filled with all API tokens at /opt/snezhanna/.env
- credentials.json is at /opt/snezhanna/credentials.json
- Node.js 22 is installed
- System user 'snezhanna' exists at /opt/snezhanna
- GitHub repo is at /opt/snezhanna

Please do:
1. Create full project structure per the TZ (package.json, config, identity, skills, schedules, watchdog)
2. Pin nanobot to latest stable version in package.json (not "latest" string)
3. Run npm install
4. Create IDENTITY.md with Snezhanna's personality and explicit prompt injection protection
5. Install davfs2 and set up WebDAV mounts for Yandex.Disk (add to /etc/fstab):
   - /mnt/yadisk-readonly → full disk, read only
   - /mnt/yadisk-agent → /Агент-Снежанна/ folder only, read+write
6. Create agent folder structure on /mnt/yadisk-agent
7. Create and enable systemd service: snezhanna
8. Create and enable systemd service: zhora (watchdog)
9. Set up all cron jobs per schedule in TZ
10. Commit everything to git (except .env and credentials.json)

After successful launch:
- Snezhanna sends to Telegram: "Вов, я онлайн! 🦞"
- Zhora sends via his bot: "🤖 Жора здесь. Слежу за Снежанной."
```
