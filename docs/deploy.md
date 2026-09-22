# Deploying Snezhanna

One script handles both scenarios — a fresh server and adding another instance to an existing VPS.

---

## What to prepare in advance

- **Telegram bot**: @BotFather → get `TELEGRAM_BOT_TOKEN`
- **Telegram user ID**: @userinfobot → numeric ID
- **Google account for the bot**: create a dedicated Gmail account the bot will use (e.g. `mybot-assistant@gmail.com`) — not the operator's personal account
- **Google OAuth credentials**: Google Cloud Console → create a **Web application** OAuth 2.0 Client → copy `Client ID` and `Client Secret`
  - For a second instance on the same VPS: reuse the same Google Cloud Project (add a new redirect URI per instance)
- **Domain with HTTPS**: required for both Mini App and Google OAuth callback (see [Mini App HTTPS](#mini-app-https)). Planning multiple bots on one server? Point a wildcard DNS record (`*.example.com`) at the server once, and every instance just picks an unused subdomain — see [New instance on the same VPS](#new-instance-on-the-same-vps)
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

The script will ask for: bot name, user name, timezone, port, Google Drive folder, domain (for Mini App HTTPS + Google OAuth callback), and API keys. It then clones the latest release, creates a system user, configures everything, and starts the bot.

---

## New instance on the same VPS

If the repo is already cloned at `/opt/<name>/`, run `deploy.sh` from inside it — it detects the existing repo and skips the clone step:

```bash
sudo git clone https://github.com/morshin/snezhanna /opt/ira
sudo bash /opt/ira/deploy.sh
```

Same prompts, same result. Each instance gets its own system user, its own `/opt/<name>` directory, its own port, its own SQLite DB, and its own systemd unit with `MemoryMax`/`CPUQuota` caps (`systemd/snezhanna.service.template`) — instances can't see each other's data and one runaway instance can't starve the rest. The Mini App API also only binds to `127.0.0.1`; it's reachable from outside only through the nginx vhost for that instance's domain, not directly on its port.

Set up **wildcard DNS once** — `*.example.com → <server IP>` — and every new instance just picks an unused subdomain (`ira.example.com`, `eugenio.example.com`, ...) at the deploy prompt; there's no per-bot DNS step after that.

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

The deploy script automatically writes `config/nanobot.local.json` with `mini_app.url` after successful TLS setup. This drives the OAuth redirect URI (`https://<domain>/auth/google/callback`).

**One manual step** — add the redirect URI in Google Console:

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Open your OAuth 2.0 Client → **Authorized redirect URIs** → add:
   ```
   https://<your-domain>/auth/google/callback
   ```
   _(for multiple instances, add one URI per instance)_

**Then authorise the bot:**

1. Send `/status` to the bot (or it sends the link automatically on first startup)
2. Click the Google auth link
3. Sign in with the **bot's dedicated Google account** (not your personal account)
4. Grant access: Calendar + Gmail + Drive
5. Browser redirects automatically → bot confirms in Telegram

The onboarding wizard starts immediately after.

---

## Mini App HTTPS

HTTPS is required for both Telegram Mini App and Google OAuth callback.

**Option A — domain + Let's Encrypt** (handled by the deploy script automatically when a domain is provided):

The script installs nginx, obtains a Let's Encrypt certificate, and writes `config/nanobot.local.json` with `mini_app.url`. Google OAuth callback works automatically. It also calls Telegram's `setChatMenuButton` API to point the bot's Menu Button at the new Mini App URL — no manual BotFather step needed for this path.

**Option B — Cloudflare Tunnel** (no domain/certificate setup needed):

```bash
cloudflared tunnel create <name>
cloudflared tunnel route dns <name> alice.example.com
# see: developers.cloudflare.com/cloudflare-one/connections/connect-networks/
```

Then set `mini_app.url` manually in `config/nanobot.local.json`:

```json
{
  "mini_app": {
    "url": "https://alice.example.com"
  }
}
```

And restart the service: `sudo systemctl restart <name>`

**Setting up the Mini App button manually** (only needed for Option B, or if the automatic call in Option A failed — the deploy script tells you if it did):

1. @BotFather → `/mybots` → select your bot
2. **Bot Settings → Menu Button → Configure Menu Button**
3. Enter your HTTPS URL and button text

Or equivalently, via the Bot API directly:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setChatMenuButton" \
  -H 'Content-Type: application/json' \
  -d '{"menu_button":{"type":"web_app","text":"Menu","web_app":{"url":"https://alice.example.com"}}}'
```

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
