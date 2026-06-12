#!/bin/bash
set -e
INSTANCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_NAME="$(basename "$INSTANCE_DIR")"
cd "$INSTANCE_DIR"

echo "Updating $INSTANCE_NAME..."

LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/morshin/snezhanna/releases/latest" \
  | grep '"tag_name"' | head -1 | cut -d'"' -f4 || true)
[ -z "$LATEST_TAG" ] && { echo "Could not fetch latest tag"; exit 1; }
echo "Latest release: $LATEST_TAG"

sudo -u "$INSTANCE_NAME" git fetch --tags -q
sudo -u "$INSTANCE_NAME" git checkout -q "$LATEST_TAG"
sudo -u "$INSTANCE_NAME" npm install --production --ignore-scripts -q
systemctl restart "$INSTANCE_NAME"
echo "Done. $INSTANCE_NAME restarted at $LATEST_TAG"
