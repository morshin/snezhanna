#!/usr/bin/env bash
# setup.sh — Run as root: sudo bash /opt/snezhanna/setup.sh
set -e

PROJECT=/opt/snezhanna

echo "══════════════════════════════════════════"
echo "  Snezhanna Setup Script"
echo "══════════════════════════════════════════"

# ── 1. Install Node.js dependencies ───────────────────────────────────────────
echo "[1/4] Installing Node.js dependencies..."
cd "$PROJECT"
npm install --production
echo "  ✅ Dependencies installed"

# ── 2. Create data directory ───────────────────────────────────────────────────
echo "[2/4] Creating data directory..."
mkdir -p "$PROJECT/data"
echo "  ✅ Data directory ready"

# ── 3. Set permissions ─────────────────────────────────────────────────────────
echo "[3/4] Setting file permissions..."
chown -R snezhanna:snezhanna "$PROJECT"
chmod 750 "$PROJECT"
chmod 600 "$PROJECT/.env"
if [ -f "$PROJECT/credentials.json" ]; then
  chmod 600 "$PROJECT/credentials.json"
fi
echo "  ✅ Permissions set"

# ── 4. Install and enable systemd services ─────────────────────────────────────
echo "[4/4] Installing systemd services..."
cp "$PROJECT/systemd/snezhanna.service" /etc/systemd/system/snezhanna.service
if [ -f "$PROJECT/watchdog/zhora.service" ]; then
  cp "$PROJECT/watchdog/zhora.service" /etc/systemd/system/zhora.service
  systemctl enable zhora
fi
systemctl daemon-reload
systemctl enable snezhanna
echo "  ✅ Services installed and enabled"

# ── Start services ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
echo "  Starting services..."
echo "══════════════════════════════════════════"
systemctl start snezhanna && echo "  ✅ snezhanna started" || echo "  ❌ snezhanna failed to start"
if systemctl is-enabled zhora &>/dev/null; then
  sleep 3
  systemctl start zhora && echo "  ✅ zhora started" || echo "  ❌ zhora failed to start"
fi

echo ""
echo "══════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Next: authenticate Google account"
echo "    1. Send /status to the bot in Telegram"
echo "    2. Click the auth link and copy the code"
echo "    3. Send /auth <code> to the bot"
echo ""
echo "  Check status:"
echo "    systemctl status snezhanna"
echo "    journalctl -u snezhanna -f"
echo "══════════════════════════════════════════"
