#!/bin/bash
# Deploy a new bot instance on the same VPS.
#
# Usage (run from anywhere, as root or with sudo):
#   sudo bash /opt/ira/scripts/deploy-instance.sh
#
# Prerequisites:
#   - Repo already cloned to /opt/<name>/
#   - credentials.json placed in /opt/<name>/

set -euo pipefail

INSTANCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_NAME="$(basename "$INSTANCE_DIR")"

if [ "$EUID" -ne 0 ]; then
  echo "Run with sudo: sudo bash $0"
  exit 1
fi

echo "╔══════════════════════════════════════════╗"
echo "║  Deploying instance: $INSTANCE_NAME"
echo "║  Directory:          $INSTANCE_DIR"
echo "╚══════════════════════════════════════════╝"
echo

# ── Detect next available port ──────────────────────────────────────────────
USED_PORTS=$(grep -h '"port"' /opt/*/config/nanobot.json 2>/dev/null \
  | grep -oP '\d+' | sort -n | tr '\n' ' ' || true)
SUGGESTED_PORT=3001
while echo "$USED_PORTS" | grep -qw "$SUGGESTED_PORT"; do
  SUGGESTED_PORT=$((SUGGESTED_PORT + 1))
done

# ── Interactive prompts ──────────────────────────────────────────────────────
read -rp "Bot name (e.g. Света): "         ASSISTANT_NAME
read -rp "User name (e.g. Ира): "          USER_NAME
read -rp "Timezone (e.g. Europe/Moscow): " TIMEZONE
read -rp "Mini App port [$SUGGESTED_PORT]: " PORT
PORT="${PORT:-$SUGGESTED_PORT}"
read -rp "Google Drive root folder name (e.g. Света): " GDRIVE_FOLDER

echo
echo "── Config ──────────────────────────────────"
echo "  Instance:   $INSTANCE_NAME"
echo "  Bot:        $ASSISTANT_NAME  (user: $USER_NAME)"
echo "  Timezone:   $TIMEZONE"
echo "  Port:       $PORT"
echo "  Drive:      $GDRIVE_FOLDER/"
echo "────────────────────────────────────────────"
read -rp "Proceed? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 1; }
echo

# ── System user ──────────────────────────────────────────────────────────────
if id "$INSTANCE_NAME" &>/dev/null; then
  echo "[skip] User $INSTANCE_NAME already exists"
else
  useradd -r -m -s /bin/bash "$INSTANCE_NAME"
  echo "[ok]   User $INSTANCE_NAME created"
fi

# ── Ownership + npm install ──────────────────────────────────────────────────
chown -R "$INSTANCE_NAME:$INSTANCE_NAME" "$INSTANCE_DIR"
echo "[ok]   Ownership set"

echo "[...]  npm install (this may take a moment)"
sudo -u "$INSTANCE_NAME" bash -c "cd $INSTANCE_DIR && npm install --silent"
echo "[ok]   npm install done"

# ── .env ─────────────────────────────────────────────────────────────────────
if [ ! -f "$INSTANCE_DIR/.env" ]; then
  sudo -u "$INSTANCE_NAME" cp "$INSTANCE_DIR/.env.example" "$INSTANCE_DIR/.env"
  echo "[ok]   .env created from example"
else
  echo "[skip] .env already exists"
fi

# ── nanobot.json ─────────────────────────────────────────────────────────────
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
echo "[ok]   nanobot.json configured"

# ── IDENTITY.md ───────────────────────────────────────────────────────────────
if [ ! -f "$INSTANCE_DIR/identity/IDENTITY.md" ]; then
  sudo -u "$INSTANCE_NAME" cp \
    "$INSTANCE_DIR/identity/IDENTITY.template.md" \
    "$INSTANCE_DIR/identity/IDENTITY.md"
  echo "[ok]   identity/IDENTITY.md created from template"
else
  echo "[skip] identity/IDENTITY.md already exists"
fi

# ── systemd service ───────────────────────────────────────────────────────────
sed "s|INSTANCE_NAME|$INSTANCE_NAME|g; \
     s|INSTANCE_USER|$INSTANCE_NAME|g; \
     s|INSTANCE_DIR|$INSTANCE_DIR|g" \
  "$INSTANCE_DIR/systemd/snezhanna.service.template" \
  > "/etc/systemd/system/$INSTANCE_NAME.service"
echo "[ok]   /etc/systemd/system/$INSTANCE_NAME.service created"

# ── sudoers for Mini App restart ─────────────────────────────────────────────
echo "$INSTANCE_NAME ALL=(ALL) NOPASSWD: /bin/systemctl restart $INSTANCE_NAME" \
  > "/etc/sudoers.d/$INSTANCE_NAME-restart"
chmod 440 "/etc/sudoers.d/$INSTANCE_NAME-restart"
echo "[ok]   sudoers rule created"

# ── Enable service (don't start yet — .env needs to be filled) ───────────────
systemctl daemon-reload
systemctl enable "$INSTANCE_NAME"
echo "[ok]   Service enabled (not started)"

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Done! Finish setup:                                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  1. Fill in API keys:                                    ║"
echo "║     nano $INSTANCE_DIR/.env"
echo "║     (ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN,              ║"
echo "║      TELEGRAM_ALLOWED_USER_ID, GOOGLE_CLIENT_ID/SECRET)  ║"
echo "║                                                          ║"
if [ ! -f "$INSTANCE_DIR/credentials.json" ]; then
echo "║  2. Copy Google credentials:                             ║"
echo "║     scp credentials.json server:$INSTANCE_DIR/"
echo "║                                                          ║"
echo "║  3. Start:                                               ║"
else
echo "║  2. Start:                                               ║"
fi
echo "║     sudo systemctl start $INSTANCE_NAME"
echo "║                                                          ║"
echo "║  4. Authorize Google — send /status to the bot           ║"
echo "║                                                          ║"
echo "║  Logs:  journalctl -u $INSTANCE_NAME -f"
echo "╚══════════════════════════════════════════════════════════╝"
