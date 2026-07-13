#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SOURCE_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "${SOURCE_ROOT}"

if [[ ! -s .next/BUILD_ID ]]; then
  echo "Production build missing at ${SOURCE_ROOT}/.next/BUILD_ID" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'uncommitted')"
RELEASE_ROOT="/opt/zenos-runtime/releases/${VERSION}-${COMMIT}"
STAGING="${RELEASE_ROOT}.staging"
SERVICE_USER="zenos-runtime"
SERVICE_GROUP="zenos-runtime"

if ! getent group "${SERVICE_GROUP}" >/dev/null; then
  groupadd --system "${SERVICE_GROUP}"
fi
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${SERVICE_GROUP}" --home-dir /var/lib/zenos-runtime --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

install -d -o root -g root -m 0755 /opt/zenos-runtime /opt/zenos-runtime/releases
install -d -o root -g "${SERVICE_GROUP}" -m 0750 /etc/zenos-runtime
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 \
  /var/lib/zenos-runtime \
  /var/lib/zenos-runtime/session-models \
  /var/lib/zenos-runtime/validation-workspaces \
  /var/lib/zenos-runtime/executor-workspaces \
  /var/lib/zenos-runtime/artifacts \
  /var/backups/zenos-memory
# Preserve the existing SQLite/audit state while transferring ownership from
# the legacy root service to the dedicated control-plane identity.
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" /var/lib/zenos-runtime
find /var/lib/zenos-runtime -xdev -type d -exec chmod 0700 {} +
find /var/lib/zenos-runtime -xdev -type f -exec chmod 0600 {} +

rm -rf "${STAGING}"
install -d -o root -g root -m 0755 "${STAGING}"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.data/' \
  --exclude='coverage/' \
  --exclude='test-results/' \
  "${SOURCE_ROOT}/" "${STAGING}/"
find "${STAGING}" -xdev -type d -exec chmod go-w {} +
find "${STAGING}" -xdev -type f -exec chmod go-w {} +
chown -R root:root "${STAGING}"
mv "${STAGING}" "${RELEASE_ROOT}"
ln -sfn "${RELEASE_ROOT}" /opt/zenos-runtime/current

copy_secret_file() {
  local source="$1"
  local destination="$2"
  if [[ -f "${source}" ]]; then
    install -o root -g "${SERVICE_GROUP}" -m 0640 "${source}" "${destination}"
  else
    rm -f "${destination}"
  fi
}

copy_secret_file "${SOURCE_ROOT}/.env.local" /etc/zenos-runtime/runtime.env
copy_secret_file /root/.hermes/profiles/zenos/.env /etc/zenos-runtime/profile.env
copy_secret_file /root/.hermes/.env /etc/zenos-runtime/global.env
copy_secret_file /root/.hermes/profiles/zenos/config.yaml /etc/zenos-runtime/hermes-config.yaml
copy_secret_file /root/.hermes/profiles/zenos/zenos-runtime.json /etc/zenos-runtime/models.json

install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-runtime.service" /etc/systemd/system/zenos-runtime.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-memory-secondary-backup.service" /etc/systemd/system/zenos-memory-secondary-backup.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-memory-secondary-backup.timer" /etc/systemd/system/zenos-memory-secondary-backup.timer
systemctl daemon-reload
systemctl enable zenos-runtime.service zenos-memory-secondary-backup.timer >/dev/null
systemctl restart zenos-runtime.service
systemctl start zenos-memory-secondary-backup.timer

printf 'Installed Zenos Runtime %s (%s) at %s\n' "${VERSION}" "${COMMIT}" "${RELEASE_ROOT}"
systemctl --no-pager --full status zenos-runtime.service
