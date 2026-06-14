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

# When called from Mini App the process already runs as $INSTANCE_NAME,
# so sudo -u is unnecessary and unavailable. When called as root (CLI),
# we drop privileges for git/npm to avoid root-owned files.
if [ "$EUID" -eq 0 ]; then
  RUN="sudo -u $INSTANCE_NAME"
else
  RUN=""
fi

if [ "$DEV_MODE" = true ]; then
  echo "⚠  --dev mode: pulling latest master"
  $RUN git fetch origin -q
  $RUN git checkout -q origin/master
  REF="master"
else
  LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/morshin/snezhanna/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4 || true)
  [ -z "$LATEST_TAG" ] && { echo "Could not fetch latest tag"; exit 1; }
  echo "Latest release: $LATEST_TAG"
  $RUN git fetch --tags -q
  $RUN git checkout -q "$LATEST_TAG"
  REF="$LATEST_TAG"
fi

$RUN npm install --production --ignore-scripts -q
sudo systemctl restart "$INSTANCE_NAME"
echo "Done. $INSTANCE_NAME restarted at $REF"
