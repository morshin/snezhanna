#!/usr/bin/env bash
# teardown.sh — Remove a deployed instance cleanly (service + files + systemd)
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

echo
bold "Tearing down: $INSTANCE_NAME"
echo

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

echo
ok "Done — ready for a fresh deploy"
echo
echo "  Next:"
echo "    sudo bash /tmp/deploy.sh --answers-file /root/deploy.local.env --yes"
echo
