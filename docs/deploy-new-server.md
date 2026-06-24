# Deploying Snezhanna on a New Server

Guide for deploying a new bot instance (main bot only, without Max and Zhora) on a clean server. Service management is done via the Mini App (Settings → "System" section).

---

## What to Prepare in Advance (on your local machine)

- **Telegram bot**: create via @BotFather → get `TELEGRAM_BOT_TOKEN`
- **Telegram user ID**: look up via @userinfobot → numeric ID
- **Google OAuth credentials**: Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID → type **Desktop app** → copy `Client ID` and `Client Secret`
  - You can reuse the same Google Cloud Project as the main instance
- **Anthropic API key**: platform.anthropic.com
- **OpenAI API key** _(optional — only needed for voice messages)_
- **Domain** _(optional — needed for Mini App)_: DNS A record must point to the server's IP. The script will obtain a TLS certificate via Let's Encrypt automatically.

---

## Deployment

The server must have **Node.js 18+** and **git** installed:

```bash
# Debian/Ubuntu — if Node.js 18+ is not yet installed:
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Then run a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/morshin/snezhanna/master/deploy.sh \
  -o /tmp/deploy.sh && sudo bash /tmp/deploy.sh
```

The script will ask for:
- Directory name, bot name and user, timezone
- API keys: Anthropic, Telegram bot token, Telegram ID, Google Client ID + Secret, OpenAI (optional)

The script then: clones the latest release into `/opt/<name>/`, generates `credentials.json`, configures the service, creates a systemd unit, and starts the bot.

**After startup:** the bot will send a Google authorization link. Visit it, grant access to Calendar + Gmail + Drive, copy the `code=...` from the address bar, and send it to the bot: `/auth <code>`. The onboarding wizard will start automatically on the first message.

---

## Mini App

The Mini App runs as an HTTP server on the port configured in `nanobot.json`. Telegram requires HTTPS.

**If you provide a domain when running `deploy.sh`** — the script will install nginx, obtain a TLS certificate via Let's Encrypt, and configure auto-renewal (`certbot.timer`). The domain's DNS A record must point to the server's IP before running the script.

**Alternative without a domain — Cloudflare Tunnel:**

```bash
# see developers.cloudflare.com/cloudflare-one/connections/connect-networks/
cloudflared tunnel create <name>
cloudflared tunnel route dns <name> alice.example.com
# cloudflared service install  — run as a service
```

### Setting up the button in BotFather

Once the Mini App is accessible via an HTTPS URL:

1. Open @BotFather → `/mybots` → select the bot
2. **Bot Settings → Menu Button → Configure Menu Button**
3. Enter URL: `https://alice.example.com`
4. Enter button text: `Open` (or any other)

The Mini App button will then appear next to the input field in Telegram.

---

## Updating

```bash
sudo bash /opt/<name>/scripts/update.sh
```

---

## Debug: teardown → redeploy cycle

When iterating on `deploy.sh` itself, you need to wipe and redeploy repeatedly without re-entering secrets.

```bash
# 1. Tear down — exports secrets + downloads latest deploy.sh automatically
sudo bash /opt/<name>/scripts/teardown.sh <name>

# 2. Redeploy without any prompts
sudo bash /tmp/deploy.sh --answers-file /root/deploy.local.env --yes
```

`teardown.sh` writes `/root/deploy.local.env` (chmod 600) before removing files, and fetches the latest `deploy.sh` to `/tmp/` — so step 2 is always ready immediately after step 1.

---

<details>
<summary>Manual deployment (step by step)</summary>

### Step 1. Prepare the server

```bash
# Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git

# System user for the service
sudo useradd -r -m -s /bin/bash snezhanna
```

### Step 2. Clone the repository and install dependencies

```bash
cd /opt
sudo git clone https://github.com/morshin/snezhanna snezhanna
sudo chown -R snezhanna:snezhanna /opt/snezhanna
sudo -u snezhanna bash -c "cd /opt/snezhanna && npm install"
```

### Step 3. Copy Google credentials

```bash
# From local machine to the new server
scp credentials.json user@new-server:/opt/snezhanna/credentials.json
sudo chown snezhanna:snezhanna /opt/snezhanna/credentials.json
```

### Step 4. Configure .env

```bash
sudo -u snezhanna cp /opt/snezhanna/.env.example /opt/snezhanna/.env
sudo nano /opt/snezhanna/.env
```

Fill in (required):
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

**Not needed** on a standalone server: `WATCHDOG_BOT_TOKEN`, `GOOGLE_TOKEN_FILE`, `STATE_FILE`, `GOOGLE_CREDENTIALS_FILE`, `TUTOR_BOT_TOKEN`.

### Step 5. Configure config/nanobot.json

```bash
sudo nano /opt/snezhanna/config/nanobot.json
```

Key fields:
```json
{
  "user": {
    "name": "Alex",
    "assistant_name": "Alice"
  },
  "timezone": "Europe/Moscow",
  "gdrive": {
    "root_folder": "Alice"
  },
  "mini_app": {
    "port": 3001
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

`gdrive.root_folder` — unique folder name in Google Drive for this instance.

### Step 6. Configure bot personality

```bash
sudo -u snezhanna cp /opt/snezhanna/identity/IDENTITY.template.md \
                     /opt/snezhanna/identity/IDENTITY.md
sudo nano /opt/snezhanna/identity/IDENTITY.md
```

`{{USER_NAME}}` and `{{ASSISTANT_NAME}}` are substituted automatically from `config.user` on startup.

### Step 7. Create the systemd service

```bash
sed 's|INSTANCE_NAME|snezhanna|g; s|INSTANCE_USER|snezhanna|g; s|INSTANCE_DIR|/opt/snezhanna|g' \
  /opt/snezhanna/systemd/snezhanna.service.template \
  | sudo tee /etc/systemd/system/snezhanna.service

sudo systemctl daemon-reload
sudo systemctl enable snezhanna
sudo systemctl start snezhanna
```

Check logs:
```bash
journalctl -u snezhanna -f
```

Expected lines on successful startup:
```
[DB] initialized
[GDrive] dirs ok   ← appears after Google OAuth
[API] Server listening on port 3001
[Bot] started
```

### Step 8. Configure sudoers for service management from Mini App

```bash
printf 'snezhanna ALL=(ALL) NOPASSWD: /bin/systemctl restart snezhanna\nsnezhanna ALL=(ALL) NOPASSWD: /bin/systemctl start snezhanna\n' \
  | sudo tee /etc/sudoers.d/snezhanna-restart
sudo chmod 440 /etc/sudoers.d/snezhanna-restart
```

### Step 9. Authorize Google

The bot will send an authorization link on first startup (or send `/status`):

1. Open the link from the bot
2. Sign in with the **user's** Google account (not the main instance's!)
3. Grant access: Calendar + Gmail + Drive
4. Copy the code from the address bar (the `code=...` parameter)
5. Send to the bot: `/auth <code>`

The bot will create the Google Drive folder structure and be ready to use.

### Step 10. Onboarding

On the first message, the bot will automatically launch the setup wizard: check integrations, ask for name, communication style, briefing and check-in schedule. Takes about 2 minutes.

After onboarding, additional settings are available in the Mini App (button in the bot's menu).

### Step 11. Verification

```bash
journalctl -u snezhanna -n 100
```

In Mini App → Settings → **System** section: service Active ✅

</details>
