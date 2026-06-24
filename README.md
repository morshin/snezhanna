# Snezhanna

Personal AI assistant running as a Telegram bot on a Linux VPS. Uses Claude as its brain, with integrations for Google Calendar, Gmail, Google Drive, Strava, and GitHub.

## Deploy

The server must have **Node.js 18+** and **git**:

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Then run:

```bash
curl -fsSL https://raw.githubusercontent.com/morshin/snezhanna/master/deploy.sh \
  -o /tmp/deploy.sh && sudo bash /tmp/deploy.sh
```

The script will ask for a name, timezone, and API keys, then set everything up and start the bot.

See `docs/deploy-new-server.md` for a full walkthrough and manual step-by-step instructions.

## First run

After the bot starts, it will send a Google auth link. Visit it, grant access to Calendar + Gmail + Drive, copy the `code=...` from the redirect URL, and send `/auth <code>` to the bot.

On the first message the **onboarding wizard** will start automatically — it takes about 2 minutes to set up name, personality, briefing schedule, and integrations.

## Update

```bash
sudo bash /opt/<name>/scripts/update.sh
```

## Service management

```bash
sudo systemctl start|stop|restart|status <name>
journalctl -u <name> -f        # live logs
journalctl -u <name> -n 100    # last 100 lines
```

## Bot commands

- `/reset` — clear conversation history
- `/status` — show service and Google auth state
- `/auth <code>` — complete Google OAuth flow
- `/quiet [N]` — quiet mode for N days (default 3); `/quiet 0` to cancel

## Configuration

`config/nanobot.json` — model, timezone, history window, Google Drive root folder, user name, enabled integrations.

```json
{
  "user": { "name": "Alex", "assistant_name": "Alice" },
  "timezone": "Europe/Madrid",
  "gdrive": { "root_folder": "Alice" },
  "mini_app": { "port": 3001 }
}
```

## Mini App (Tasks & Calendar)

Runs as an HTTP server on the port set in `nanobot.json`. Telegram requires HTTPS — use nginx + Let's Encrypt or Cloudflare Tunnel.

Set up the button in BotFather: `/mybots` → select bot → **Bot Settings → Menu Button → Configure Menu Button** → enter the HTTPS URL and button text.

## Scheduled tasks

| Time | Task |
|------|------|
| 08:00 | Morning briefing (calendar + tasks + email) |
| 19:00 | Evening check-in |
| Monday 09:00 | Workload & wellbeing check-in |
| Sunday 10:00 | Weekly digest |
| Every 10 min | Calendar reminders, deadline alerts |
| 03:30 | SQLite backup to Google Drive |

All times use the timezone from `nanobot.json`.
