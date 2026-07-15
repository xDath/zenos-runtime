#!/usr/bin/env bash
set -euo pipefail

log() { logger -t etla-maintenance -- "$*"; printf '%s\n' "$*"; }
root_usage() { df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}'; }

before="$(root_usage)"
if (( before >= 85 )); then
  logger -p user.err -t etla-disk-alert -- "CRITICAL root filesystem usage ${before}% (threshold 85%)"
elif (( before >= 70 )); then
  logger -p user.warning -t etla-disk-alert -- "WARNING root filesystem usage ${before}% (threshold 70%)"
fi

# Prune only reproducible caches and dated upgrade artifacts. Project sources,
# active releases, SQLite state, credentials, and encrypted backups are never
# touched by this maintenance job. Upgrade snapshots are short-lived because
# current+previous atomic releases and verified encrypted/offsite backups are
# the supported rollback mechanisms.
if [[ -d /root/zenos-upgrade-backups ]]; then
  find /root/zenos-upgrade-backups -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf -- {} +
fi
if [[ -d /root/.npm/_cacache ]]; then
  find /root/.npm/_cacache -xdev -type f -mtime +7 -delete
  find /root/.npm/_cacache -xdev -depth -type d -empty -delete || true
fi
if [[ -d /root/.npm/_npx ]]; then
  find /root/.npm/_npx -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf -- {} +
fi
for cache in /srv/etla/workspaces/*/.next/cache; do
  [[ -d "${cache}" ]] || continue
  find "${cache}" -xdev -type f -mtime +14 -delete
  find "${cache}" -xdev -depth -type d -empty -delete || true
done
journalctl --vacuum-size=512M >/dev/null

# Remove incomplete deployment staging directories only. Completed releases are
# pruned by the atomic deployer, which preserves current + previous explicitly.
find /opt/zenos-runtime/releases -mindepth 1 -maxdepth 1 -type d -name '*.staging' -mtime +1 -exec rm -rf -- {} + 2>/dev/null || true

after="$(root_usage)"
log "maintenance complete: root filesystem ${before}% -> ${after}%"
if (( after >= 85 )); then
  logger -p user.err -t etla-disk-alert -- "CRITICAL root filesystem remains ${after}% after cleanup"
elif (( after >= 70 )); then
  logger -p user.warning -t etla-disk-alert -- "WARNING root filesystem remains ${after}% after cleanup"
fi
