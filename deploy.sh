#!/usr/bin/env bash
# deploy.sh — Full deployment: clone latest release → configure → start
#
# Usage on a fresh server:
#   curl -fsSL https://raw.githubusercontent.com/morshin/snezhanna/master/deploy.sh \
#     -o /tmp/deploy.sh && sudo bash /tmp/deploy.sh
#
# Usage when repo is already cloned (e.g. same-VPS multi-instance):
#   sudo bash /opt/alice/deploy.sh
#
# For adding a second instance on the SAME VPS see scripts/deploy-instance.sh

set -euo pipefail

# ── Helpers ───────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

ok()   { printf '  \033[0;32m[ok]\033[0m   %s\n' "$*"; }
skip() { printf '  \033[0;33m[skip]\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
die()  { red "Error: $*"; exit 1; }

require_root() {
  [ "$EUID" -eq 0 ] || die "Run with sudo: sudo bash $0"
}

node_major() {
  node --version 2>/dev/null | grep -oP '(?<=v)\d+' | head -1
}

check_node() {
  if ! command -v node &>/dev/null; then
    red "Node.js is not installed."
    echo "Install it first:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
  fi
  local major
  major=$(node_major)
  if [ "${major:-0}" -lt 18 ]; then
    red "Node.js ${major} found, need >= 18."
    echo "Upgrade:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
  fi
}

# ── Root check ────────────────────────────────────────────────────────────────

require_root

echo
bold "╔══════════════════════════════════════════════════╗"
bold "║        Snezhanna — Deployment Script              ║"
bold "╚══════════════════════════════════════════════════╝"
echo

# ── Detect mode: clone needed or already in repo ─────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN_REPO=false
[ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/index.js" ] && IN_REPO=true

# ── Prerequisites ─────────────────────────────────────────────────────────────

step "Checking prerequisites"

if ! command -v git &>/dev/null; then
  echo "  Installing git..."
  apt-get install -y git -q
fi
ok "git $(git --version | grep -oP '[\d.]+')"

check_node
ok "node v$(node_major)"

# ── Clone (bootstrap mode only) ───────────────────────────────────────────────

if [ "$IN_REPO" = false ]; then
  step "Clone latest release"

  DEFAULT_REPO="https://github.com/morshin/snezhanna"
  read -rp "  Repository URL [$DEFAULT_REPO]: " REPO_URL
  REPO_URL="${REPO_URL:-$DEFAULT_REPO}"

  read -rp "  Bot directory name (e.g. alice): " DIR_NAME
  [ -z "$DIR_NAME" ] && die "Directory name is required"
  INSTANCE_DIR="/opt/$DIR_NAME"

  if [ -d "$INSTANCE_DIR" ]; then
    die "Directory $INSTANCE_DIR already exists. Remove it first or run deploy.sh from inside it."
  fi

  echo "  Fetching latest release tag..."
  LATEST_TAG=$(git ls-remote --tags --refs --sort=-v:refname "$REPO_URL" \
    | head -1 | cut -d/ -f3)
  [ -z "$LATEST_TAG" ] && die "Could not determine latest release tag from $REPO_URL"
  echo "  Latest release: $LATEST_TAG"

  git -c advice.detachedHead=false clone --depth 1 --branch "$LATEST_TAG" "$REPO_URL" "$INSTANCE_DIR" -q
  ok "Cloned $LATEST_TAG → $INSTANCE_DIR"

  cd "$INSTANCE_DIR"
  SCRIPT_DIR="$INSTANCE_DIR"
else
  INSTANCE_DIR="$SCRIPT_DIR"
  LATEST_TAG=$(git -C "$INSTANCE_DIR" describe --tags --abbrev=0 2>/dev/null || echo "dev")
  echo "  Running from existing repo: $INSTANCE_DIR ($LATEST_TAG)"
fi

INSTANCE_NAME="$(basename "$INSTANCE_DIR")"

# ── Bot configuration prompts ─────────────────────────────────────────────────

step "Bot configuration"

read -rp "  Bot name (e.g. Алиса): "           ASSISTANT_NAME
[ -z "$ASSISTANT_NAME" ] && die "Bot name is required"

read -rp "  User name (e.g. Алекс): "          USER_NAME
[ -z "$USER_NAME" ] && die "User name is required"

read -rp "  Timezone [Europe/Madrid]: "         TIMEZONE
TIMEZONE="${TIMEZONE:-Europe/Madrid}"

# Auto-detect next available port
USED_PORTS=$(grep -h '"port"' /opt/*/config/nanobot.json 2>/dev/null \
  | grep -oP '\d+' | sort -n | tr '\n' ' ' || true)
SUGGESTED_PORT=3001
while echo "$USED_PORTS" | grep -qw "$SUGGESTED_PORT"; do
  SUGGESTED_PORT=$((SUGGESTED_PORT + 1))
done
read -rp "  Mini App port [$SUGGESTED_PORT]: "  PORT
PORT="${PORT:-$SUGGESTED_PORT}"

read -rp "  Google Drive folder name (e.g. Алиса): " GDRIVE_FOLDER
[ -z "$GDRIVE_FOLDER" ] && die "Google Drive folder name is required"

read -rp "  Domain for Mini App (e.g. alice.example.com, Enter to skip): " DOMAIN
if [ -n "$DOMAIN" ]; then
  while true; do
    read -rp "  Admin email for Let's Encrypt: " LE_EMAIL
    [[ "$LE_EMAIL" =~ ^[^@]+@[^@]+\.[^@]+$ ]] && break
    red "  Enter a valid email address"
  done
fi

# ── API keys ──────────────────────────────────────────────────────────────────

step "API keys"
echo "  (input is hidden)"
echo

# Anthropic
while true; do
  read -rsp "  ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY; echo
  [[ "$ANTHROPIC_API_KEY" == sk-ant-* ]] && break
  red "  Must start with sk-ant-"
done

# Telegram bot token
while true; do
  read -rsp "  TELEGRAM_BOT_TOKEN: " TELEGRAM_BOT_TOKEN; echo
  [[ "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] && break
  red "  Invalid format (expected 123456:ABC-xyz)"
done

# Telegram user ID
while true; do
  read -rp "  TELEGRAM_ALLOWED_USER_ID: " TELEGRAM_ALLOWED_USER_ID
  [[ "$TELEGRAM_ALLOWED_USER_ID" =~ ^[0-9]+$ ]] && break
  red "  Must be a numeric Telegram user ID"
done

# Google OAuth
while true; do
  read -rsp "  GOOGLE_CLIENT_ID: " GOOGLE_CLIENT_ID; echo
  [ -n "$GOOGLE_CLIENT_ID" ] && break
  red "  Cannot be empty"
done
while true; do
  read -rsp "  GOOGLE_CLIENT_SECRET: " GOOGLE_CLIENT_SECRET; echo
  [ -n "$GOOGLE_CLIENT_SECRET" ] && break
  red "  Cannot be empty"
done

# OpenAI (optional)
read -rsp "  OPENAI_API_KEY (optional, Enter to skip): " OPENAI_API_KEY; echo

# ── Confirmation ──────────────────────────────────────────────────────────────

echo
bold "── Config ────────────────────────────────────────"
echo "  Instance:   $INSTANCE_NAME  →  $INSTANCE_DIR"
echo "  Tag:        $LATEST_TAG"
echo "  Bot:        $ASSISTANT_NAME  (user: $USER_NAME)"
echo "  Timezone:   $TIMEZONE"
echo "  Port:       $PORT"
echo "  Drive:      $GDRIVE_FOLDER/"
if [ -n "$DOMAIN" ]; then
  echo "  Domain:     $DOMAIN  (TLS via Let's Encrypt, $LE_EMAIL)"
else
  echo "  Domain:     — (Mini App HTTPS skipped)"
fi
printf "  Secrets:    ANTHROPIC ✓  TELEGRAM ✓  GOOGLE ✓"
[ -n "$OPENAI_API_KEY" ] && printf "  OPENAI ✓"
echo
bold "──────────────────────────────────────────────────"
echo
read -rp "Proceed? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 1; }

# ── System user ───────────────────────────────────────────────────────────────

step "System user"
if id "$INSTANCE_NAME" &>/dev/null; then
  skip "User $INSTANCE_NAME already exists"
else
  useradd -r -m -s /bin/bash "$INSTANCE_NAME"
  ok "User $INSTANCE_NAME created"
fi

# ── Ownership + npm install ───────────────────────────────────────────────────

step "Dependencies"
chown -R "$INSTANCE_NAME:$INSTANCE_NAME" "$INSTANCE_DIR"
ok "Ownership set"

echo "  Running npm install..."
sudo -u "$INSTANCE_NAME" bash -c "cd '$INSTANCE_DIR' && npm install --silent --production"
ok "npm install done"

# ── nanobot.json ──────────────────────────────────────────────────────────────

step "Configuration files"
node - "$INSTANCE_DIR/config/nanobot.json" \
     "$USER_NAME" "$ASSISTANT_NAME" "$TIMEZONE" "$PORT" "$GDRIVE_FOLDER" <<'EOF'
const fs = require('fs');
const [,, cfgPath, userName, assistantName, timezone, port, driveFolder] = process.argv;
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.user = { name: userName, assistant_name: assistantName };
cfg.timezone = timezone;
cfg.gdrive = { root_folder: driveFolder };
cfg.mini_app = { port: Number(port) };
cfg.integrations = { strava: false, github: false, chat_monitor: false };
cfg.github = { milestone_due_within_days: 14, repos: [] };
cfg.chat_monitor = { chats: [] };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
EOF
chown "$INSTANCE_NAME:$INSTANCE_NAME" "$INSTANCE_DIR/config/nanobot.json"
ok "nanobot.json configured"

# ── .env ──────────────────────────────────────────────────────────────────────

if [ ! -f "$INSTANCE_DIR/.env" ]; then
  cp "$INSTANCE_DIR/.env.example" "$INSTANCE_DIR/.env"
fi

ENV_FILE="$INSTANCE_DIR/.env"
set_env() {
  local key="$1" val="$2"
  # Escape special characters for sed replacement
  local escaped
  escaped=$(printf '%s' "$val" | sed 's/[\/&]/\\&/g')
  sed -i "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
}

set_env "ANTHROPIC_API_KEY"        "$ANTHROPIC_API_KEY"
set_env "TELEGRAM_BOT_TOKEN"       "$TELEGRAM_BOT_TOKEN"
set_env "TELEGRAM_ALLOWED_USER_ID" "$TELEGRAM_ALLOWED_USER_ID"
set_env "GOOGLE_CLIENT_ID"         "$GOOGLE_CLIENT_ID"
set_env "GOOGLE_CLIENT_SECRET"     "$GOOGLE_CLIENT_SECRET"
[ -n "$OPENAI_API_KEY" ] && set_env "OPENAI_API_KEY" "$OPENAI_API_KEY"

chmod 600 "$ENV_FILE"
chown "$INSTANCE_NAME:$INSTANCE_NAME" "$ENV_FILE"
ok ".env written"

# ── credentials.json ──────────────────────────────────────────────────────────

if [ ! -f "$INSTANCE_DIR/credentials.json" ]; then
  node - "$INSTANCE_DIR/credentials.json" "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET" <<'EOF'
const fs = require('fs');
const [,, out, id, secret] = process.argv;
fs.writeFileSync(out, JSON.stringify({
  installed: {
    client_id: id,
    client_secret: secret,
    redirect_uris: ["urn:ietf:wg:oauth:2.0:oob", "http://localhost"]
  }
}, null, 2) + '\n');
EOF
  chmod 600 "$INSTANCE_DIR/credentials.json"
  chown "$INSTANCE_NAME:$INSTANCE_NAME" "$INSTANCE_DIR/credentials.json"
  ok "credentials.json generated"
else
  skip "credentials.json already exists"
fi

# ── IDENTITY.md ───────────────────────────────────────────────────────────────

if [ ! -f "$INSTANCE_DIR/identity/IDENTITY.md" ]; then
  sudo -u "$INSTANCE_NAME" cp \
    "$INSTANCE_DIR/identity/IDENTITY.template.md" \
    "$INSTANCE_DIR/identity/IDENTITY.md"
  ok "identity/IDENTITY.md created from template"
else
  skip "identity/IDENTITY.md already exists"
fi

# ── systemd service ───────────────────────────────────────────────────────────

step "System service"
sed "s|INSTANCE_NAME|$INSTANCE_NAME|g; \
     s|INSTANCE_USER|$INSTANCE_NAME|g; \
     s|INSTANCE_DIR|$INSTANCE_DIR|g" \
  "$INSTANCE_DIR/systemd/snezhanna.service.template" \
  > "/etc/systemd/system/$INSTANCE_NAME.service"
ok "/etc/systemd/system/$INSTANCE_NAME.service created"

# sudoers: restart + start for Mini App
printf '%s ALL=(ALL) NOPASSWD: /bin/systemctl restart %s\n' "$INSTANCE_NAME" "$INSTANCE_NAME" \
  > "/etc/sudoers.d/$INSTANCE_NAME-restart"
printf '%s ALL=(ALL) NOPASSWD: /bin/systemctl start %s\n'   "$INSTANCE_NAME" "$INSTANCE_NAME" \
  >> "/etc/sudoers.d/$INSTANCE_NAME-restart"
chmod 440 "/etc/sudoers.d/$INSTANCE_NAME-restart"
ok "sudoers rule created"

systemctl daemon-reload
systemctl enable "$INSTANCE_NAME" -q
ok "Service enabled"

# ── Start + wait for ready ────────────────────────────────────────────────────

step "Starting $INSTANCE_NAME"
systemctl start "$INSTANCE_NAME"

TIMEOUT=15
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  STATUS=$(systemctl is-active "$INSTANCE_NAME" 2>/dev/null || true)
  if [ "$STATUS" = "active" ]; then
    ok "Service is running"
    break
  elif [ "$STATUS" = "failed" ]; then
    red "Service failed to start. Last logs:"
    journalctl -u "$INSTANCE_NAME" -n 20 --no-pager 2>/dev/null || true
    die "Fix the issue and run: sudo systemctl start $INSTANCE_NAME"
  fi
done

if [ "$STATUS" != "active" ]; then
  yellow "Service is still starting up. Check logs:"
  yellow "  journalctl -u $INSTANCE_NAME -f"
fi

echo
echo "  Last log lines:"
journalctl -u "$INSTANCE_NAME" -n 8 --no-pager 2>/dev/null \
  | sed 's/^/    /' || true

# ── nginx + TLS ───────────────────────────────────────────────────────────────

MINI_APP_URL=""
if [ -n "$DOMAIN" ]; then
  step "nginx + TLS ($DOMAIN)"

  if ! command -v nginx &>/dev/null; then
    echo "  Installing nginx..."
    apt-get install -y nginx -q
    ok "nginx installed"
  else
    skip "nginx already installed"
  fi

  if ! command -v certbot &>/dev/null; then
    echo "  Installing certbot..."
    apt-get install -y certbot python3-certbot-nginx -q
    ok "certbot installed"
  else
    skip "certbot already installed"
  fi

  NGINX_CONF="/etc/nginx/sites-available/$INSTANCE_NAME"
  cat > "$NGINX_CONF" <<EOF
server {
    server_name $DOMAIN;
    location / {
        proxy_pass http://localhost:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
EOF
  ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$INSTANCE_NAME"
  nginx -t -q && systemctl reload nginx
  ok "nginx configured for $DOMAIN"

  echo "  Requesting TLS certificate (domain DNS must point to this server)..."
  if certbot --nginx -d "$DOMAIN" \
       --non-interactive --agree-tos -m "$LE_EMAIL" -q 2>/dev/null; then
    ok "TLS certificate issued — auto-renewal via certbot.timer"
    MINI_APP_URL="https://$DOMAIN"
  else
    yellow "certbot failed — DNS may not point here yet, or port 80 is blocked."
    yellow "Run manually later:  certbot --nginx -d $DOMAIN -m $LE_EMAIL --agree-tos"
    MINI_APP_URL="https://$DOMAIN  (TLS pending)"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo
bold "╔══════════════════════════════════════════════════════════╗"
printf "║  ✅ %-52s ║\n" "$INSTANCE_NAME deployed and running ($LATEST_TAG)"
bold "╠══════════════════════════════════════════════════════════╣"
bold "║                                                          ║"
bold "║  Next: authorize Google                                  ║"
bold "║                                                          ║"
bold "║  1. Open Telegram → find your bot                        ║"
bold "║  2. Bot will send a Google auth URL on first start       ║"
bold "║     (or send /status to trigger it)                      ║"
bold "║  3. Visit the URL → authorize Calendar + Gmail + Drive   ║"
bold "║  4. Copy code from the redirect URL (code=... param)     ║"
bold "║  5. Send to bot: /auth <code>                            ║"
bold "║                                                          ║"
bold "║  After auth → onboarding wizard starts automatically     ║"
bold "║                                                          ║"
if [ -n "$MINI_APP_URL" ]; then
printf "║  Mini App ready: %-40s ║\n" "$MINI_APP_URL"
bold "║  In @BotFather: /mybots → bot →                          ║"
bold "║    Menu Button → Configure → paste URL above             ║"
bold "║                                                          ║"
else
bold "║  Mini App: set up nginx + HTTPS when ready, then         ║"
bold "║    @BotFather → /mybots → bot → Menu Button → URL        ║"
printf "║  See: %-51s ║\n" "docs/deploy-new-server.md → Mini App"
bold "║                                                          ║"
fi
printf "║  Logs:   journalctl -u %-34s ║\n" "$INSTANCE_NAME -f"
printf "║  Update: sudo bash %-39s ║\n" "$INSTANCE_DIR/scripts/update.sh"
bold "╚══════════════════════════════════════════════════════════╝"
echo
