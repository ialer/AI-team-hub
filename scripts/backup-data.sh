#!/bin/sh
# Daily snapshot of the hub's data directory (messages, sessions, tokens, invites…).
# Installed on the hub host as a cron job; committed here so it is reproducible.
set -e
SRC=/vol1/docker/ai-team-hub
DST=/vol1/docker/ai-team-hub-backups
TS=$(date +%Y%m%d-%H%M)
mkdir -p "$DST"
tar czf "$DST/data-$TS.tgz" -C "$SRC" data
# Keep the 7 newest data snapshots.
ls -1t "$DST"/data-*.tgz 2>/dev/null | tail -n +8 | while read -r old; do rm -f "$old"; done
echo "[$(date -Iseconds)] snapshot $DST/data-$TS.tgz $(du -h "$DST/data-$TS.tgz" | cut -f1)"
