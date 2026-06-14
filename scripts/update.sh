#!/bin/bash
# Usage:
#   sudo bash scripts/update.sh           # update to latest release tag
#   sudo bash scripts/update.sh --dev     # update to latest master commit
set -e
INSTANCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_NAME="$(basename "$INSTANCE_DIR")"
cd "$INSTANCE_DIR"

DEV_MODE=false
for arg in "$@"; do
  [[ "$arg" == "--dev" ]] && DEV_MODE=true
done

echo "Updating $INSTANCE_NAME..."

if [ "$DEV_MODE" = true ]; then
  echo "⚠  --dev mode: pulling latest master"
  sudo -u "$INSTANCE_NAME" git fetch origin -q
  sudo -u "$INSTANCE_NAME" git checkout -q origin/master
  REF="master"
else
  LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/morshin/snezhanna/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4 || true)
  [ -z "$LATEST_TAG" ] && { echo "Could not fetch latest tag"; exit 1; }
  echo "Latest release: $LATEST_TAG"
  sudo -u "$INSTANCE_NAME" git fetch --tags -q
  sudo -u "$INSTANCE_NAME" git checkout -q "$LATEST_TAG"
  REF="$LATEST_TAG"
fi

sudo -u "$INSTANCE_NAME" npm install --production --ignore-scripts -q
systemctl restart "$INSTANCE_NAME"
echo "Done. $INSTANCE_NAME restarted at $REF"
