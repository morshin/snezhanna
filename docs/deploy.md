# Deploying Snezhanna

One script handles both scenarios — a fresh server and adding another instance to an existing VPS.

---

## What to prepare in advance

- **Telegram bot**: @BotFather → get `TELEGRAM_BOT_TOKEN`
- **Telegram user ID**: @userinfobot → numeric ID
- **Google OAuth credentials**: Google Cloud Console → Desktop-type OAuth 2.0 Client → copy `Client ID` and `Client Secret`
  - For a second instance on the same VPS: reuse the same Google Cloud Project
- **Anthropic API key**: platform.anthropic.com
- **OpenAI API key** _(optional — only needed for voice messages)_

---

## Fresh server

```bash
# 1. Install Node.js 18+ and git (if not yet):
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Run the deploy script:
curl -fsSL https://raw.githubusercontent.com/morshin/snezhanna/master/deploy.sh \
  -o /tmp/deploy.sh && sudo bash /tmp/deploy.sh
```

The script will ask for: bot name, user name, timezone, port, Google Drive folder, domain (optional for Mini App HTTPS), and API keys. It then clones the latest release, creates a system user, configures everything, and starts the bot.

---

## New instance on the same VPS

If the repo is already cloned at `/opt/<name>/`, run `deploy.sh` from inside it — it detects the existing repo and skips the clone step:

```bash
sudo git clone https://github.com/morshin/snezhanna /opt/ira
sudo bash /opt/ira/deploy.sh
```

Same prompts, same result.

---

## Instance map

Keep this list to avoid port collisions:

| Directory         | Service     | User        | Port |
|-------------------|-------------|-------------|------|
| `/opt/snezhanna`  | `snezhanna` | `snezhanna` | 3001 |
| `/opt/ira`        | `ira`       | `ira`       | 3002 |
| `/opt/eugenio`    | `eugenio`   | `eugenio`   | 3003 |

---

## Google OAuth (after deploy)

The bot sends an auth link on first startup (or send `/status`):

1. Click the link → sign in with the **user's** Google account
2. Grant access: Calendar + Gmail + Drive
3. Copy the `code=...` parameter from the redirect URL
4. Send to the bot: `/auth <code>`

The onboarding wizard starts automatically on the first message.

---

## Mini App HTTPS

The Mini App runs on HTTP; Telegram requires HTTPS.

**Option A — domain + Let's Encrypt** (handled by the script automatically if you provide a domain when prompted)

**Option B — Cloudflare Tunnel** (no domain/certificate setup needed):

```bash
cloudflared tunnel create <name>
cloudflared tunnel route dns <name> alice.example.com
# see: developers.cloudflare.com/cloudflare-one/connections/connect-networks/
```

**Setting up the Mini App button in BotFather:**

1. @BotFather → `/mybots` → select your bot
2. **Bot Settings → Menu Button → Configure Menu Button**
3. Enter your HTTPS URL and button text

---

## Updating

```bash
sudo bash /opt/<name>/scripts/update.sh
```

---

## Debug: teardown → redeploy cycle

When iterating on `deploy.sh` itself, repeat without re-entering secrets:

```bash
# 1. Tear down — exports secrets, fetches latest deploy.sh to /tmp/
sudo bash /opt/<name>/scripts/teardown.sh <name>

# 2. Redeploy without prompts
sudo bash /tmp/deploy.sh --answers-file /root/deploy.local.env --yes
```
