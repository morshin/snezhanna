#!/usr/bin/env bash
# reset-onboarding.sh — Reset bot to pre-onboarding state while keeping integrations.
#
# Clears: user_settings, memory, tasks, projects, all derived DB data, onboarding
#         flags in state.json, conversation history.
# Keeps:  token.json (Google OAuth), .env (all API keys), config/nanobot.local.json
#
# Usage:
#   bash scripts/reset-onboarding.sh [instance-dir]
#   bash scripts/reset-onboarding.sh /opt/beckham

set -euo pipefail

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
ok()     { printf '  \033[0;32m[ok]\033[0m   %s\n' "$*"; }
skip()   { printf '  \033[0;33m[skip]\033[0m %s\n' "$*"; }
die()    { red "Error: $*"; exit 1; }

INSTANCE_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

[ -f "$INSTANCE_DIR/index.js" ] || die "Not a snezhanna instance: $INSTANCE_DIR"

# Detect service name from the directory name
SERVICE_NAME=$(basename "$INSTANCE_DIR")

echo
bold "Reset onboarding: $INSTANCE_DIR (service: $SERVICE_NAME)"
bold "Integrations (token.json, .env) will NOT be touched."
echo
printf 'Continue? [y/N] '
read -r answer
[[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
echo

# ── Stop service ──────────────────────────────────────────────────────────────

bold "── Stopping service"

if systemctl is-active "$SERVICE_NAME" &>/dev/null 2>&1; then
  sudo systemctl stop "$SERVICE_NAME"
  ok "Service stopped"
else
  skip "Service not running"
fi

# ── Drop SQLite DB ────────────────────────────────────────────────────────────

bold "── Clearing database"

DB_PATH=$(node -e "
process.chdir('$INSTANCE_DIR');
const cfg = require('./config/nanobot.json');
console.log((cfg.database && cfg.database.path) || 'data/snezhanna.db');
" 2>/dev/null || echo "data/snezhanna.db")

DB_FILE="$INSTANCE_DIR/$DB_PATH"

if [ -f "$DB_FILE" ]; then
  rm "$DB_FILE"
  ok "Removed $DB_FILE"
else
  skip "DB not found: $DB_FILE"
fi

# ── Reset state.json ──────────────────────────────────────────────────────────

bold "── Resetting state.json"

STATE_FILE="$INSTANCE_DIR/.nanobot/state.json"

if [ -f "$STATE_FILE" ]; then
  node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('$STATE_FILE', 'utf8'));
s.onboarding_completed = false;
s.onboarding_step = null;
// Clear conversation-derived state; keep chatId so bot knows where to write
delete s.awaitingWorkloadCheckin;
delete s.briefingPending;
delete s.briefingPendingAt;
delete s.silenceLevel;
delete s.silenceDaysCount;
delete s.quietUntil;
delete s.lastUserMessageAt;
delete s.emailDigestSeenIds;
delete s.emailDigestBootstrapped;
fs.writeFileSync('$STATE_FILE', JSON.stringify(s, null, 2));
console.log('ok');
  "
  ok "state.json reset"
else
  skip "state.json not found (will be created on start)"
fi

# ── Start service ─────────────────────────────────────────────────────────────

bold "── Starting service"

if systemctl list-unit-files "$SERVICE_NAME.service" &>/dev/null 2>&1; then
  sudo systemctl start "$SERVICE_NAME"
  ok "Service started"
  echo
  echo "  Watch logs:"
  echo "    journalctl -u $SERVICE_NAME -f"
else
  skip "No systemd unit — start manually: node $INSTANCE_DIR/index.js"
fi

echo
ok "Done — send any message to the bot to begin onboarding"
echo
