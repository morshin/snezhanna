#!/usr/bin/env bash
# setup.sh — Run as root: sudo bash /opt/snezhanna/setup.sh
set -e

PROJECT=/opt/snezhanna
YADISK_LOGIN="$(grep YANDEX_WEBDAV_LOGIN $PROJECT/.env | cut -d= -f2)"
YADISK_PASS="$(grep YANDEX_WEBDAV_PASSWORD $PROJECT/.env | cut -d= -f2)"

echo "══════════════════════════════════════════"
echo "  Snezhanna Setup Script"
echo "══════════════════════════════════════════"

# ── 1. Install davfs2 ──────────────────────────────────────────────────────────
echo "[1/9] Installing davfs2..."
DEBIAN_FRONTEND=noninteractive apt-get install -y davfs2
# Allow non-root users to mount davfs2 (needed for snezhanna user)
echo 'davfs2 davfs2/suid_file boolean true' | debconf-set-selections 2>/dev/null || true

# ── 2. Create mount points ─────────────────────────────────────────────────────
echo "[2/9] Creating mount points..."
mkdir -p /mnt/yadisk-readonly /mnt/yadisk-agent

# ── 3. Configure davfs2 ────────────────────────────────────────────────────────
echo "[3/9] Configuring davfs2..."
# Enable davfs2 for non-root users
if grep -q "^# use_locks" /etc/davfs2/davfs2.conf 2>/dev/null; then
  sed -i 's/^# use_locks.*/use_locks 0/' /etc/davfs2/davfs2.conf || true
fi

cat >> /etc/davfs2/davfs2.conf << 'EOF'

# Snezhanna WebDAV settings
use_locks       0
cache_size      128
delay_upload    5
gui_optimize    1
EOF

# ── 4. Set up credentials ──────────────────────────────────────────────────────
echo "[4/9] Setting up WebDAV credentials..."
SECRETS_FILE=/etc/davfs2/secrets
# Remove old entries if any
sed -i '/webdav.yandex.ru/d' "$SECRETS_FILE" 2>/dev/null || true
echo "https://webdav.yandex.ru        ${YADISK_LOGIN}  ${YADISK_PASS}" >> "$SECRETS_FILE"
echo "https://webdav.yandex.ru/Snezhanna  ${YADISK_LOGIN}  ${YADISK_PASS}" >> "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

# ── 5. Add to /etc/fstab ───────────────────────────────────────────────────────
echo "[5/9] Adding to /etc/fstab..."
# Remove old entries if any
sed -i '/yadisk-readonly\|yadisk-agent/d' /etc/fstab 2>/dev/null || true
cat >> /etc/fstab << 'EOF'

# Yandex.Disk WebDAV mounts (Snezhanna)
https://webdav.yandex.ru           /mnt/yadisk-readonly  davfs  ro,_netdev,noauto,user  0  0
https://webdav.yandex.ru/Snezhanna /mnt/yadisk-agent     davfs  rw,_netdev,noauto,user  0  0
EOF
echo "fstab updated."

# ── 6. Mount Yandex.Disk ───────────────────────────────────────────────────────
echo "[6/9] Mounting Yandex.Disk..."
mount /mnt/yadisk-readonly && echo "  ✅ yadisk-readonly mounted" || echo "  ⚠️  yadisk-readonly mount failed (check credentials/network)"
mount /mnt/yadisk-agent    && echo "  ✅ yadisk-agent mounted"    || echo "  ⚠️  yadisk-agent mount failed (check credentials/network)"

# ── 7. Create agent folder structure ──────────────────────────────────────────
echo "[7/9] Creating agent folder structure on Yandex.Disk..."
if mountpoint -q /mnt/yadisk-agent; then
  mkdir -p /mnt/yadisk-agent/{index,memory,projects,fitness,drafts,digests}
  # Create empty memory files if they don't exist
  for f in health kids finance bureaucracy decisions; do
    [ ! -f "/mnt/yadisk-agent/memory/${f}.md" ] && echo "# ${f^}" > "/mnt/yadisk-agent/memory/${f}.md"
  done
  # Create empty index file if it doesn't exist
  if [ ! -f /mnt/yadisk-agent/index/file_index.json ]; then
    echo '{"last_updated":null,"total":0,"files":[]}' > /mnt/yadisk-agent/index/file_index.json
  fi
  echo "  ✅ Agent folder structure created"
else
  echo "  ⚠️  Skipping folder structure (yadisk-agent not mounted)"
fi

# ── 8. Set permissions ─────────────────────────────────────────────────────────
echo "[8/9] Setting file permissions..."
chown -R snezhanna:snezhanna /opt/snezhanna
chmod 750 /opt/snezhanna
chmod 600 /opt/snezhanna/.env
chmod 600 /opt/snezhanna/credentials.json
# Allow vova to read project files
usermod -aG snezhanna vova 2>/dev/null || true

# ── 9. Install and enable systemd services ─────────────────────────────────────
echo "[9/9] Installing systemd services..."
cp $PROJECT/systemd/snezhanna.service /etc/systemd/system/snezhanna.service
cp $PROJECT/watchdog/zhora.service    /etc/systemd/system/zhora.service
systemctl daemon-reload
systemctl enable snezhanna
systemctl enable zhora
echo "  ✅ Services installed and enabled"

# ── 10. Set up cron jobs ────────────────────────────────────────────────────────
echo "[+] Setting up cron jobs..."
CRON_FILE=/etc/cron.d/snezhanna
cat > "$CRON_FILE" << CRONEOF
# Snezhanna — Yandex.Disk indexer cron jobs
# Timezone: Europe/Madrid (UTC+1/UTC+2)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

# Incremental index — every night at 02:00 Madrid (01:00 UTC winter / 00:00 UTC summer)
0 2 * * * snezhanna TZ=Europe/Madrid /usr/bin/node /opt/snezhanna/lib/indexer.js --incremental >> /var/log/snezhanna-index.log 2>&1

# Full reindex — every Sunday at 03:00 Madrid
0 3 * * 0 snezhanna TZ=Europe/Madrid /usr/bin/node /opt/snezhanna/lib/indexer.js --full >> /var/log/snezhanna-index.log 2>&1
CRONEOF
chmod 644 "$CRON_FILE"
echo "  ✅ Cron jobs installed at $CRON_FILE"

# ── Start services ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
echo "  Starting services..."
echo "══════════════════════════════════════════"
systemctl start snezhanna && echo "  ✅ snezhanna started" || echo "  ❌ snezhanna failed to start"
sleep 3
systemctl start zhora     && echo "  ✅ zhora started"     || echo "  ❌ zhora failed to start"

echo ""
echo "══════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Check status:"
echo "    systemctl status snezhanna"
echo "    systemctl status zhora"
echo "    journalctl -u snezhanna -f"
echo "    journalctl -u zhora -f"
echo "══════════════════════════════════════════"
