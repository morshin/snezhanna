#!/usr/bin/env bash
# teardown.sh — Remove a deployed instance cleanly (service + files + systemd)
#               Automatically exports secrets and downloads latest deploy.sh.
#
# Usage:
#   sudo bash scripts/teardown.sh <instance-name>
#   sudo bash scripts/teardown.sh beckham

set -euo pipefail

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
ok()     { printf '  \033[0;32m[ok]\033[0m   %s\n' "$*"; }
skip()   { printf '  \033[0;33m[skip]\033[0m %s\n' "$*"; }
die()    { red "Error: $*"; exit 1; }

[ "$EUID" -eq 0 ] || die "Run with sudo: sudo bash $0 <instance-name>"
[ -n "${1:-}" ] || die "Usage: sudo bash $0 <instance-name>"

INSTANCE_NAME="$1"
INSTANCE_DIR="/opt/$INSTANCE_NAME"
REPO_SLUG="morshin/snezhanna"

echo
bold "Tearing down: $INSTANCE_NAME"
echo

# ── Export secrets before files are removed ───────────────────────────────────

bold "── Exporting secrets"

ENV_FILE="$INSTANCE_DIR/.env"
CFG_FILE="$INSTANCE_DIR/config/nanobot.json"

if [ -f "$ENV_FILE" ] && [ -f "$CFG_FILE" ] && command -v node &>/dev/null; then
  get_env() { grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

  CFG_JSON=$(node -e "
const cfg = JSON.parse(require('fs').readFileSync('$CFG_FILE', 'utf8'));
console.log([
  cfg.timezone || '',
  (cfg.mini_app || {}).port || '',
  (cfg.gdrive || {}).root_folder || '',
  (cfg.user || {}).assistant_name || '',
  (cfg.user || {}).name || ''
].join('\t'));
  ")
  IFS=$'\t' read -r CFG_TZ CFG_PORT CFG_DRIVE CFG_ASSISTANT CFG_USER <<< "$CFG_JSON"

  cat > /root/deploy.local.env <<EOF
REPO_URL=https://github.com/$REPO_SLUG
DIR_NAME=$INSTANCE_NAME
ASSISTANT_NAME=$CFG_ASSISTANT
USER_NAME=$CFG_USER
TIMEZONE=$CFG_TZ
PORT=$CFG_PORT
GDRIVE_FOLDER=$CFG_DRIVE
DOMAIN=
ANTHROPIC_API_KEY=$(get_env ANTHROPIC_API_KEY)
TELEGRAM_BOT_TOKEN=$(get_env TELEGRAM_BOT_TOKEN)
TELEGRAM_ALLOWED_USER_ID=$(get_env TELEGRAM_ALLOWED_USER_ID)
GOOGLE_CLIENT_ID=$(get_env GOOGLE_CLIENT_ID)
GOOGLE_CLIENT_SECRET=$(get_env GOOGLE_CLIENT_SECRET)
OPENAI_API_KEY=$(get_env OPENAI_API_KEY)
EOF
  chmod 600 /root/deploy.local.env
  ok "Secrets saved → /root/deploy.local.env"
else
  yellow "  Skipped: .env / nanobot.json not found or node unavailable"
fi

# ── Download latest deploy.sh ─────────────────────────────────────────────────

bold "── Downloading latest deploy.sh"

LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO_SLUG/releases/latest" 2>/dev/null \
  | grep '"tag_name"' | head -1 | cut -d'"' -f4 || true)

if [ -n "$LATEST_TAG" ]; then
  curl -fsSL "https://raw.githubusercontent.com/$REPO_SLUG/$LATEST_TAG/deploy.sh" \
    -o /tmp/deploy.sh
  chmod +x /tmp/deploy.sh
  ok "deploy.sh $LATEST_TAG → /tmp/deploy.sh"
else
  yellow "  Could not fetch latest tag; downloading from master"
  curl -fsSL "https://raw.githubusercontent.com/$REPO_SLUG/master/deploy.sh" \
    -o /tmp/deploy.sh
  chmod +x /tmp/deploy.sh
  ok "deploy.sh (master) → /tmp/deploy.sh"
fi

# ── Stop and remove service ───────────────────────────────────────────────────

bold "── Removing service"

if systemctl is-active "$INSTANCE_NAME" &>/dev/null 2>&1; then
  systemctl stop "$INSTANCE_NAME"
  ok "Service stopped"
else
  skip "Service not running"
fi

if systemctl is-enabled "$INSTANCE_NAME" &>/dev/null 2>&1; then
  systemctl disable "$INSTANCE_NAME" -q
  ok "Service disabled"
else
  skip "Service not enabled"
fi

if [ -f "/etc/systemd/system/$INSTANCE_NAME.service" ]; then
  rm -f "/etc/systemd/system/$INSTANCE_NAME.service"
  systemctl daemon-reload
  ok "Service file removed"
else
  skip "No service file"
fi

if [ -f "/etc/sudoers.d/$INSTANCE_NAME-restart" ]; then
  rm -f "/etc/sudoers.d/$INSTANCE_NAME-restart"
  ok "Sudoers rule removed"
else
  skip "No sudoers rule"
fi

if [ -L "/etc/nginx/sites-enabled/$INSTANCE_NAME" ]; then
  rm -f "/etc/nginx/sites-enabled/$INSTANCE_NAME"
  rm -f "/etc/nginx/sites-available/$INSTANCE_NAME"
  nginx -t -q 2>/dev/null && systemctl reload nginx 2>/dev/null || true
  ok "nginx config removed"
else
  skip "No nginx config"
fi

if [ -d "$INSTANCE_DIR" ]; then
  rm -rf "$INSTANCE_DIR"
  ok "Removed $INSTANCE_DIR"
else
  skip "$INSTANCE_DIR not found"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo
ok "Done — ready for a fresh deploy"
echo
echo "  Next:"
echo "    sudo bash /tmp/deploy.sh --answers-file /root/deploy.local.env --yes"
echo
