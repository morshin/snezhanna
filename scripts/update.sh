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

# Stash local changes (e.g. tenant-specific config/nanobot.json) so checkout succeeds
STASHED=false
if ! $RUN git diff --quiet || ! $RUN git diff --cached --quiet; then
  $RUN git stash push -q -m "update.sh: before update"
  STASHED=true
  echo "Local changes stashed"
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

# Restore stashed changes; warn on conflict but don't abort the update
if [ "$STASHED" = true ]; then
  $RUN git stash pop -q && echo "Local changes restored" \
    || echo "⚠  Stash pop had conflicts — run 'git stash show' to review and restore manually"
fi

$RUN npm install --production --ignore-scripts -q

# Merge new vars from .env.example into .env (add missing only, never overwrite existing)
if [ -f .env.example ] && [ -f .env ]; then
  added=0
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue   # skip comments
    [[ -z "${line// }" ]] && continue              # skip blank lines
    key="${line%%=*}"
    [[ -z "$key" ]] && continue
    if ! grep -q "^${key}=" .env 2>/dev/null; then
      echo "$line" >> .env
      echo "  + $key"
      added=$((added + 1))
    fi
  done < .env.example
  [ "$added" -gt 0 ] && echo "$added new var(s) merged into .env" || true
fi

sudo systemctl restart "$INSTANCE_NAME"
echo "Done. $INSTANCE_NAME restarted at $REF"
