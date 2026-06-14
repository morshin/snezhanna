# Adding a New Bot Instance on the Same VPS

Each user gets an isolated copy of the bot: their own directory `/opt/<name>`, their own system user, their own systemd service, and their own Mini App port.

> **Quick path** — the script `scripts/deploy-instance.sh` performs steps 1–8 automatically.  
> Clone the repo, place `credentials.json`, run the script and fill in `.env`.  
> The manual step-by-step breakdown below is for understanding or troubleshooting.

In the examples below the instance name is `ira`. Substitute your actual name everywhere: `eugenio`, `lena`, etc.

---

## Quick Deployment (script)

```bash
# 1. Clone the repo
sudo git clone https://github.com/morshin/snezhanna /opt/ira

# 2. Place credentials.json
scp credentials.json user@server:/opt/ira/credentials.json

# 3. Run the script
sudo bash /opt/ira/scripts/deploy-instance.sh
# → will ask: bot name, user name, timezone, port, Drive folder
# → creates user, service, sudoers, .env and nanobot.json

# 4. Fill in API keys
sudo nano /opt/ira/.env

# 5. Start
sudo systemctl start ira

# 6. Authorize Google — send /status to the bot
```

---

## Step-by-Step Deployment (manual)

## What to Prepare in Advance (on your local machine)

- **Telegram bot**: create via @BotFather → get `TELEGRAM_BOT_TOKEN`
- **Telegram user ID**: look up via @userinfobot → numeric ID
- **Google OAuth credentials**: Google Cloud Console → Desktop-type OAuth 2.0 Client → download `credentials.json`
  - You can reuse the same Google Cloud Project as the main instance
- **Anthropic API key**: platform.anthropic.com
- **OpenAI API key** _(optional — only needed for voice messages)_

---

## Instance Map on the Server

Keep this list manually — it helps avoid port collisions:

| Directory         | Service | User         | Port |
|-------------------|---------|--------------|------|
| `/opt/snezhanna`  | `snezhanna` | `snezhanna` | 3001 |
| `/opt/ira`        | `ira`   | `ira`        | 3002 |
| `/opt/eugenio`    | `eugenio` | `eugenio`  | 3003 |

---

## Step 1. Create a system user

```bash
sudo useradd -r -m -s /bin/bash ira
```

---

## Step 2. Clone the repository

```bash
cd /opt
sudo git clone https://github.com/morshin/snezhanna ira
sudo chown -R ira:ira /opt/ira
sudo -u ira bash -c "cd /opt/ira && npm install"
```

---

## Step 3. Copy Google credentials

```bash
# From local machine to server
scp credentials.json user@server:/opt/ira/credentials.json
sudo chown ira:ira /opt/ira/credentials.json
```

---

## Step 4. Configure .env

```bash
sudo -u ira cp /opt/ira/.env.example /opt/ira/.env
sudo nano /opt/ira/.env
```

Required:
```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...           # new bot token
TELEGRAM_ALLOWED_USER_ID=...     # numeric Telegram user ID
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Optional:
```
OPENAI_API_KEY=...               # for voice messages
```

> `GOOGLE_TOKEN_FILE`, `STATE_FILE`, `GOOGLE_CREDENTIALS_FILE` are not needed —
> each instance has its own directory, so default paths do not conflict.

---

## Step 5. Configure config/nanobot.json

```bash
sudo -u ira nano /opt/ira/config/nanobot.json
```

```json
{
  "user": {
    "name": "Ira",
    "assistant_name": "Sveta"
  },
  "timezone": "Europe/Moscow",
  "gdrive": {
    "root_folder": "Sveta"
  },
  "mini_app": {
    "port": 3002
  },
  "integrations": {
    "strava": false,
    "github": false,
    "chat_monitor": false
  },
  "github": { "milestone_due_within_days": 14, "repos": [] },
  "chat_monitor": { "chats": [] }
}
```

`mini_app.port` — unique for each instance (see map above).  
`gdrive.root_folder` — unique folder name in Google Drive.

---

## Step 6. Configure bot personality

```bash
sudo -u ira cp /opt/ira/identity/IDENTITY.template.md /opt/ira/identity/IDENTITY.md
sudo nano /opt/ira/identity/IDENTITY.md
```

`{{USER_NAME}}` and `{{ASSISTANT_NAME}}` are substituted from `config.user` on startup.

---

## Step 7. Create the systemd service

```bash
sed 's|INSTANCE_NAME|ira|g; s|INSTANCE_USER|ira|g; s|INSTANCE_DIR|/opt/ira|g' \
  /opt/snezhanna/systemd/snezhanna.service.template \
  | sudo tee /etc/systemd/system/ira.service

sudo systemctl daemon-reload
sudo systemctl enable ira
sudo systemctl start ira
```

Check logs:
```bash
journalctl -u ira -f
```

Expected lines on successful startup:
```
[DB] initialized
[API] Server listening on port 3002
[Bot] started
```

(`[GDrive] dirs ok` appears after Google OAuth)

---

## Step 8. Configure sudoers for restart from Mini App

```bash
echo "ira ALL=(ALL) NOPASSWD: /bin/systemctl restart ira" \
  | sudo tee /etc/sudoers.d/ira-restart
sudo chmod 440 /etc/sudoers.d/ira-restart
```

---

## Step 9. Authorize Google

The bot will send an authorization link on first startup (or send `/status`):

1. Open the link from the bot
2. Sign in with the **user's** Google account (not the user's!)
3. Grant access: Calendar + Gmail + Drive
4. Copy the code from the address bar (`code=...`)
5. Send to the bot: `/auth <code>`

The bot will create the Google Drive folder structure and be ready to use.

---

## Step 10. Onboarding

On the first message, the bot will automatically launch the setup wizard: check integrations, ask for name, communication style, briefing schedule. Takes about 2 minutes.

---

## Updating

Each instance is updated independently:

```bash
cd /opt/ira
sudo -u ira git pull
sudo -u ira npm install   # if dependencies changed
sudo systemctl restart ira
```
