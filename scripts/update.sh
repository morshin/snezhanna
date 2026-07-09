#!/bin/bash
# Usage:
#   sudo bash scripts/update.sh           # update to latest release tag
#   sudo bash scripts/update.sh --dev     # update to latest master commit
set -e
INSTANCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_NAME="$(basename "$INSTANCE_DIR")"
cd "$INSTANCE_DIR"

DEV_MODE=false
POST_UPDATE=false
PREV_REF=""
for arg in "$@"; do
  [[ "$arg" == "--dev" ]]         && DEV_MODE=true
  [[ "$arg" == "--post-update" ]] && POST_UPDATE=true
  [[ "$arg" == --prev-ref=* ]]    && PREV_REF="${arg#--prev-ref=}"
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

if [ "$POST_UPDATE" = false ]; then
  # ── Git phase ──────────────────────────────────────────────────────────────

  # Record the commit we're updating FROM, so the test gate below can roll
  # back to a known-good state if the new version fails its own test suite.
  PREV_REF=$($RUN git rev-parse HEAD)

  # Back up nanobot.json BEFORE any git operations — migrations need it even
  # after git checkout removes it from the repo (v1.3.17+).
  NANOBOT_BACKUP="$(mktemp "/tmp/${INSTANCE_NAME}-nanobot-backup.XXXXXX.json")"
  if [ -f config/nanobot.json ]; then
    cp config/nanobot.json "$NANOBOT_BACKUP"
    echo "Backed up config/nanobot.json → $NANOBOT_BACKUP"
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
    $RUN git checkout -q FETCH_HEAD
  else
    LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/morshin/snezhanna/releases/latest" \
      | grep '"tag_name"' | head -1 | cut -d'"' -f4 || true)
    [ -z "$LATEST_TAG" ] && { echo "Could not fetch latest tag"; exit 1; }
    echo "Latest release: $LATEST_TAG"
    $RUN git fetch --tags -q
    $RUN git checkout -q "$LATEST_TAG"
  fi

  # Restore stashed changes; warn on conflict but don't abort the update
  if [ "$STASHED" = true ]; then
    $RUN git stash pop -q && echo "Local changes restored" \
      || echo "⚠  Stash pop had conflicts — run 'git stash show' to review and restore manually"
    # package-lock.json always comes from the release tag — discard any conflict
    $RUN git checkout HEAD -- package-lock.json 2>/dev/null || true
  fi

  # Re-exec from the freshly checked-out script — bash was reading the old inode;
  # exec replaces the process so all post-update steps run from the new version.
  exec bash "$INSTANCE_DIR/scripts/update.sh" --post-update ${DEV_MODE:+--dev} "--prev-ref=$PREV_REF"
fi

# ── Post-update phase (running from new script inode after exec) ──────────────
REF=$($RUN git describe --tags --exact-match HEAD 2>/dev/null || $RUN git rev-parse --short HEAD)

$RUN npm install --production --ignore-scripts -q

# ── Test gate ──────────────────────────────────────────────────────────────
# Protects tenants from a bad release reaching every instance at once via
# auto-update. `node:test` ships in Node core, so this runs even with the
# --production install above. On failure: roll back to the commit we were on
# before this update, reinstall its deps, and restart into the known-good
# version instead of the broken one — the existing update_pending_from check
# in index.js (post-restart) will then correctly report "update failed,
# version unchanged" to the owner via Telegram.
if [ -d test ]; then
  echo "Running test suite..."
  if ! $RUN npm test --silent; then
    echo "❌ Tests failed on $REF — rolling back to $PREV_REF"
    if [ -n "$PREV_REF" ]; then
      $RUN git checkout -q "$PREV_REF"
      $RUN npm install --production --ignore-scripts -q
    fi
    sudo systemctl restart "$INSTANCE_NAME"
    echo "Rolled back to $PREV_REF and restarted. Update to $REF aborted."
    exit 1
  fi
  echo "Tests passed"
fi

# Run pending migrations (idempotent; failures are logged but don't abort the update)
$RUN node scripts/run-migrations.js || echo "⚠  Migration runner exited with errors — check output above"

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

  # Find stale vars in .env that no longer exist in .env.example
  stale=()
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    key="${line%%=*}"
    [[ -z "$key" ]] && continue
    if ! grep -qE "^#?${key}=" .env.example 2>/dev/null; then
      stale+=("$key")
    fi
  done < .env

  if [ ${#stale[@]} -gt 0 ]; then
    echo "⚠  Stale vars in .env (not in .env.example): ${stale[*]}"
    if [ -t 0 ]; then
      read -rp "   Remove them? [y/N]: " REMOVE_STALE
      if [[ "$REMOVE_STALE" =~ ^[Yy]$ ]]; then
        cp .env .env.bak
        for key in "${stale[@]}"; do
          sed -i "/^${key}=/d" .env
          echo "   - $key"
        done
        echo "   Backup saved to .env.bak"
      fi
    fi
  fi
fi

# CREDENTIALS_KEY encrypts email_accounts.credentials — deploy.sh generates it on
# fresh installs, but instances updating to v1.5.0+ arrive here with the key
# missing or empty (the merge above only copies the blank line from .env.example).
# Generate once; never rotate, or already-encrypted rows become unreadable.
if [ -f .env ] && ! grep -q '^CREDENTIALS_KEY=.\+' .env; then
  if grep -q '^CREDENTIALS_KEY=' .env; then
    sed -i "s|^CREDENTIALS_KEY=.*|CREDENTIALS_KEY=$(openssl rand -hex 32)|" .env
  else
    echo "CREDENTIALS_KEY=$(openssl rand -hex 32)" >> .env
  fi
  echo "Generated CREDENTIALS_KEY (encrypts stored email credentials)"
fi

# Merge new fields from nanobot.json.example into nanobot.json (add missing only, never overwrite)
if [ -f config/nanobot.json.example ] && [ -f config/nanobot.json ]; then
  MERGED=$($RUN node -e "
    const fs = require('fs');
    const example = JSON.parse(fs.readFileSync('config/nanobot.json.example', 'utf8'));
    const current = JSON.parse(fs.readFileSync('config/nanobot.json', 'utf8'));
    function mergeNew(target, source) {
      for (const key of Object.keys(source)) {
        if (!(key in target)) {
          target[key] = source[key];
          process.stdout.write('  + ' + key + '\n');
        } else if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
                   target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
          const before = JSON.stringify(target[key]);
          mergeNew(target[key], source[key]);
          if (JSON.stringify(target[key]) !== before) process.stdout.write('  ~ ' + key + '\n');
        }
      }
    }
    mergeNew(current, example);
    fs.writeFileSync('config/nanobot.json', JSON.stringify(current, null, 2) + '\n');
  " 2>/dev/null || true)
  [ -n "$MERGED" ] && echo "nanobot.json updated with new fields from example:" && echo "$MERGED" || true
fi

# Ensure mini_app.url is set in nanobot.local.json (needed for Google OAuth callback)
LOCAL_CFG="config/nanobot.local.json"
HAS_URL=$($RUN node -e "
  try {
    const c = JSON.parse(require('fs').readFileSync('$LOCAL_CFG', 'utf8'));
    process.stdout.write(c.mini_app && c.mini_app.url ? 'yes' : 'no');
  } catch(e) { process.stdout.write('no'); }
" 2>/dev/null || echo "no")

if [ "$HAS_URL" != "yes" ]; then
  if [ -t 0 ]; then
    echo ""
    echo "⚠  mini_app.url not set in $LOCAL_CFG (needed for Google OAuth callback)"
    read -rp "   Enter public HTTPS URL (e.g. https://snezhanna.example.com) or Enter to skip: " MINI_APP_URL
    if [ -n "$MINI_APP_URL" ]; then
      $RUN node -e "
        const fs = require('fs');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync('$LOCAL_CFG', 'utf8')); } catch(e) {}
        cfg.mini_app = cfg.mini_app || {};
        cfg.mini_app.url = '$MINI_APP_URL';
        fs.writeFileSync('$LOCAL_CFG', JSON.stringify(cfg, null, 2) + '\n');
      "
      echo "   Saved mini_app.url to $LOCAL_CFG"
    fi
  else
    echo "⚠  mini_app.url not set in $LOCAL_CFG — Google OAuth redirect will not work. Set it manually."
  fi
fi

sudo systemctl restart "$INSTANCE_NAME"
echo "Done. $INSTANCE_NAME restarted at $REF"
