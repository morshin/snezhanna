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
#
# Flags:
#   --dev   Clone latest commit from master instead of the latest release tag

set -euo pipefail
trap 'echo ""; red "Deploy failed at line $LINENO (exit code: $?)"; exit 1' ERR

# ── Helpers ───────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

ok()   { printf '  \033[0;32m[ok]\033[0m   %s\n' "$*"; }
skip() { printf '  \033[0;33m[skip]\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
die()  { red "Error: $*"; exit 1; }

rollback() {
  local reason="${1:-unknown}"
  echo
  red "╔══════════════════════════════════════════════════╗"
  red "║  Deployment failed — rolling back                ║"
  red "╚══════════════════════════════════════════════════╝"
  red "  Reason: $reason"
  echo
  systemctl stop    "$INSTANCE_NAME" 2>/dev/null || true
  systemctl disable "$INSTANCE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/$INSTANCE_NAME.service"
  rm -f "/etc/sudoers.d/$INSTANCE_NAME-restart"
  if [ -L "/etc/nginx/sites-enabled/$INSTANCE_NAME" ]; then
    rm -f "/etc/nginx/sites-enabled/$INSTANCE_NAME"
    rm -f "/etc/nginx/sites-available/$INSTANCE_NAME"
    nginx -t -q 2>/dev/null && systemctl reload nginx 2>/dev/null || true
  fi
  systemctl daemon-reload
  echo
  yellow "  Instance directory preserved for debugging: $INSTANCE_DIR"
  yellow "  Review logs: journalctl -u $INSTANCE_NAME -n 50 --no-pager"
  echo
  red "  Fix the issue, then re-run deploy."
  exit 1
}

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

# ── Flags ─────────────────────────────────────────────────────────────────────

DEV_MODE=false
for arg in "$@"; do
  [[ "$arg" == "--dev" ]] && DEV_MODE=true
done

# ── Root check ────────────────────────────────────────────────────────────────

require_root

DEPLOY_SCRIPT_VERSION="1.3.9"

# Disable terminal modes that inject escape sequences into stdin during read:
#   ?2004l — bracketed paste mode (sends \e[200~ / \e[201~ around pasted text)
#   ?1004l — focus event reporting (sends \e[I on focus-in, \e[O on focus-out)
printf '\e[?2004l\e[?1004l' 2>/dev/null || true

echo
bold "╔══════════════════════════════════════════════════╗"
bold "║        Snezhanna — Deployment Script              ║"
bold "╚══════════════════════════════════════════════════╝"
echo "  Script version: $DEPLOY_SCRIPT_VERSION"
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
  if [ "$DEV_MODE" = true ]; then
    step "Clone master branch (dev mode)"
    yellow "  ⚠  --dev flag: cloning latest commit from master, not a release tag"
  else
    step "Clone latest release"
  fi

  DEFAULT_REPO="https://github.com/morshin/snezhanna"
  read -rp "  Repository URL [$DEFAULT_REPO]: " REPO_URL
  REPO_URL="${REPO_URL:-$DEFAULT_REPO}"

  read -rp "  Bot directory name (e.g. alice): " DIR_NAME
  DIR_NAME=$(printf '%s' "$DIR_NAME" | tr -cd 'a-zA-Z0-9_-')
  [ -z "$DIR_NAME" ] && die "Directory name is required"
  echo "  → /opt/$DIR_NAME"
  INSTANCE_DIR="/opt/$DIR_NAME"

  if [ -d "$INSTANCE_DIR" ]; then
    echo
    yellow "  Directory $INSTANCE_DIR already exists (previous failed deploy?)."
    printf '\e[?2004l\e[?1004l' 2>/dev/null || true
    read -rp "  Remove it and start fresh? [y/N]: " REMOVE_DIR
    REMOVE_DIR=$(printf '%s' "$REMOVE_DIR" | tr -cd '[:alpha:]')
    [[ "$REMOVE_DIR" =~ ^[Yy]$ ]] || die "Aborted. Remove $INSTANCE_DIR manually and re-run."
    rm -rf "$INSTANCE_DIR"
    ok "Removed $INSTANCE_DIR"
  fi

  if [ "$DEV_MODE" = true ]; then
    LATEST_TAG="master"
    git clone --depth 1 "$REPO_URL" "$INSTANCE_DIR" -q 2>/dev/null \
      || die "Failed to clone master from $REPO_URL"
    ok "Cloned master → $INSTANCE_DIR"
  else
    echo "  Fetching latest release tag..."
    REPO_SLUG=$(echo "$REPO_URL" | sed 's|https://github.com/||')
    LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO_SLUG/releases/latest" 2>/dev/null \
      | grep '"tag_name"' | head -1 | cut -d'"' -f4 || true)
    [ -z "$LATEST_TAG" ] && die "Could not determine latest release tag from $REPO_URL"
    echo "  Latest release: $LATEST_TAG"
    git clone --depth 1 --branch "$LATEST_TAG" "$REPO_URL" "$INSTANCE_DIR" -q 2>/dev/null \
      || die "Failed to clone $LATEST_TAG from $REPO_URL"
    ok "Cloned $LATEST_TAG → $INSTANCE_DIR"
  fi

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

while true; do
  echo "  Common timezones: Europe/Moscow  Europe/Madrid  Europe/London"
  echo "                    America/New_York  Asia/Almaty  Asia/Dubai"
  read -rp "  Timezone [Europe/Madrid]: " TIMEZONE
  TIMEZONE="${TIMEZONE:-Europe/Madrid}"
  [ -f "/usr/share/zoneinfo/$TIMEZONE" ] && break
  red "  Unknown timezone '$TIMEZONE'. Use format Region/City (e.g. Europe/Moscow)"
done

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
  ANTHROPIC_API_KEY=$(printf '%s' "$ANTHROPIC_API_KEY" | grep -oE 'sk-ant-[A-Za-z0-9_-]+' | head -1 || true)
  [[ "$ANTHROPIC_API_KEY" == sk-ant-* ]] && break
  red "  Must start with sk-ant-  (got: ${ANTHROPIC_API_KEY:0:10}...)"
done

# Telegram bot token
while true; do
  read -rsp "  TELEGRAM_BOT_TOKEN: " TELEGRAM_BOT_TOKEN; echo
  TELEGRAM_BOT_TOKEN=$(printf '%s' "$TELEGRAM_BOT_TOKEN" | grep -oE '[0-9]+:[A-Za-z0-9_-]+' | head -1 || true)
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
  GOOGLE_CLIENT_ID=$(printf '%s' "$GOOGLE_CLIENT_ID" | tr -cd '[:print:]' | tr -d ' ')
  [ -n "$GOOGLE_CLIENT_ID" ] && break
  red "  Cannot be empty"
done
while true; do
  read -rsp "  GOOGLE_CLIENT_SECRET: " GOOGLE_CLIENT_SECRET; echo
  GOOGLE_CLIENT_SECRET=$(printf '%s' "$GOOGLE_CLIENT_SECRET" | tr -cd '[:print:]' | tr -d ' ')
  [ -n "$GOOGLE_CLIENT_SECRET" ] && break
  red "  Cannot be empty"
done

# OpenAI (optional)
read -rsp "  OPENAI_API_KEY (optional, Enter to skip): " OPENAI_API_KEY; echo
OPENAI_API_KEY=$(printf '%s' "$OPENAI_API_KEY" | grep -oE 'sk-[A-Za-z0-9_-]+' | head -1 || true)

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
echo "  Telegram user ID: $TELEGRAM_ALLOWED_USER_ID"
bold "──────────────────────────────────────────────────"
echo
printf '\e[?2004l\e[?1004l' 2>/dev/null || true
read -rp "Proceed? [y/N] " CONFIRM
CONFIRM=$(printf '%s' "$CONFIRM" | tr -cd '[:alpha:]')
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
if [ ! -f "$INSTANCE_DIR/config/nanobot.json" ]; then
  cp "$INSTANCE_DIR/config/nanobot.json.example" "$INSTANCE_DIR/config/nanobot.json"
fi
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
# Strip inline comments from variable lines (KEY=value # comment → KEY=value)
# so dotenv doesn't read comment text as the variable value.
sed -i '/^[^#]*=/ s/[[:space:]]*#.*$//' "$ENV_FILE"
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
    redirect_uris: ["http://localhost"]
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

# sudoers: restart + start for Mini App and update.sh
SYSTEMCTL_PATH="$(command -v systemctl)"
{
  printf '%s ALL=(ALL) NOPASSWD: %s restart %s\n' "$INSTANCE_NAME" "$SYSTEMCTL_PATH" "$INSTANCE_NAME"
  printf '%s ALL=(ALL) NOPASSWD: %s start %s\n'   "$INSTANCE_NAME" "$SYSTEMCTL_PATH" "$INSTANCE_NAME"
} > "/etc/sudoers.d/$INSTANCE_NAME-restart"
chmod 440 "/etc/sudoers.d/$INSTANCE_NAME-restart"
ok "sudoers rule created"

systemctl daemon-reload
systemctl enable "$INSTANCE_NAME" -q
ok "Service enabled"

# ── Start + wait for ready ────────────────────────────────────────────────────

step "Starting $INSTANCE_NAME"
# Record timestamp before start so journalctl --since filters to this run only
START_TS=$(date -u +"%Y-%m-%d %H:%M:%S")
systemctl start "$INSTANCE_NAME"

# ① Wait for systemd active/failed (up to 20 s)
TIMEOUT=20
ELAPSED=0
STATUS=""
while [ $ELAPSED -lt $TIMEOUT ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  STATUS=$(systemctl is-active "$INSTANCE_NAME" 2>/dev/null || true)
  if [ "$STATUS" = "failed" ]; then
    red "Service entered 'failed' state. Last logs:"
    journalctl -u "$INSTANCE_NAME" --since "$START_TS" --no-pager 2>/dev/null | sed 's/^/    /' || true
    rollback "service entered 'failed' state on startup"
  fi
  [ "$STATUS" = "active" ] && break
done

if [ "$STATUS" != "active" ]; then
  red "Service did not reach 'active' after ${TIMEOUT}s (status: ${STATUS:-unknown}). Last logs:"
  journalctl -u "$INSTANCE_NAME" --since "$START_TS" --no-pager 2>/dev/null | sed 's/^/    /' || true
  rollback "service stuck in '${STATUS:-unknown}' after ${TIMEOUT}s (restart loop?)"
fi

ok "Service is active"

# ② Wait for bot to log "Ready and listening" (up to 15 more s)
# Use --since to only look at logs from this deployment, not previous runs.
BOT_READY=false
for i in $(seq 1 15); do
  if journalctl -u "$INSTANCE_NAME" --since "$START_TS" --no-pager 2>/dev/null \
       | grep -q 'Ready and listening'; then
    BOT_READY=true
    break
  fi
  sleep 1
done

NRESTARTS=$(systemctl show "$INSTANCE_NAME" --property=NRestarts --value 2>/dev/null || echo 0)

if [ "$BOT_READY" = true ]; then
  ok "Bot is ready and listening"
  [ "${NRESTARTS:-0}" -gt 0 ] && yellow "⚠  Service restarted ${NRESTARTS} time(s) before stabilising"
else
  red "Bot did not log 'Ready and listening' after 35s (NRestarts=${NRESTARTS:-0}). Last logs:"
  journalctl -u "$INSTANCE_NAME" --since "$START_TS" --no-pager 2>/dev/null | sed 's/^/    /' || true
  rollback "bot never reached ready state after 35s (NRestarts=${NRESTARTS:-0})"
fi

# ③ Warn on fatal config errors (API key / auth issues)
FATAL=$(journalctl -u "$INSTANCE_NAME" --since "$START_TS" --no-pager 2>/dev/null \
  | grep -iE 'error.*api.?key|invalid.*token|authentication.*failed|401 unauthorized' | head -3 || true)
if [ -n "$FATAL" ]; then
  yellow "⚠  Possible auth errors in logs (check API keys):"
  echo "$FATAL" | sed 's/^/    /'
fi

# Check Mini App port is reachable
if curl -sf --max-time 5 "http://localhost:$PORT/" -o /dev/null 2>/dev/null; then
  ok "Mini App responding on localhost:$PORT"
else
  yellow "Mini App not yet reachable on localhost:$PORT (may need a moment)"
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
    # Verify the full HTTPS chain is reachable
    if curl -sf --max-time 10 "https://$DOMAIN/" -o /dev/null 2>/dev/null; then
      ok "Mini App reachable at https://$DOMAIN/"
    else
      yellow "https://$DOMAIN/ not reachable yet (DNS propagation or nginx issue?)"
      yellow "Check:  curl -v https://$DOMAIN/"
    fi
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
