#!/usr/bin/env bash
# One-off: SQLite data must be owned by the systemd service user (snezhanna).
# Run on the VPS: sudo bash /opt/snezhanna/scripts/fix-snezhanna-data-perms.sh

set -euo pipefail

DATA=/opt/snezhanna/data

if [[ $(id -u) -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

mkdir -p "$DATA"
chown -R snezhanna:snezhanna "$DATA"
chmod 750 "$DATA"
find "$DATA" -maxdepth 1 -type f \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' \) -exec chmod 660 {} \;

echo "OK: $DATA -> snezhanna:snezhanna (dir 750, SQLite files 660)"
