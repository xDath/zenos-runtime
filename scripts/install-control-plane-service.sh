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
BUILD_ID="$(tr -cd 'A-Za-z0-9._-' < .next/BUILD_ID | cut -c1-32)"
[[ -n "${BUILD_ID}" ]] || BUILD_ID="build-$(date +%s)"
RELEASE_ROOT="/opt/zenos-runtime/releases/${VERSION}-${COMMIT}-${BUILD_ID}"
STAGING="${RELEASE_ROOT}.staging"
PREVIOUS_RELEASE="$(readlink -f /opt/zenos-runtime/current 2>/dev/null || true)"
SERVICE_USER="zenos-runtime"
SERVICE_GROUP="zenos-runtime"
HERMES_SERVICE_USER="hermes"
HERMES_SERVICE_GROUP="hermes"
HERMES_PROFILE_ROOT="${ZENOS_HERMES_PROFILE_ROOT:-/var/lib/hermes/.hermes/profiles/zenos}"
LEGACY_HERMES_PROFILE_ROOT="/root/.hermes/profiles/zenos"

if [[ ! -f "${HERMES_PROFILE_ROOT}/config.yaml" && -f "${LEGACY_HERMES_PROFILE_ROOT}/config.yaml" ]]; then
  HERMES_PROFILE_ROOT="${LEGACY_HERMES_PROFILE_ROOT}"
fi

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
  /var/backups/zenos-memory \
  /var/backups/zenos-runtime
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

install -d -o root -g root -m 0700 /etc/credstore.encrypted
CREDENTIAL_TMP="$(mktemp)"
HERMES_CREDENTIAL_TMP="$(mktemp)"
SANITIZED_CONFIG_TMP="$(mktemp)"
SANITIZED_MODELS_TMP="$(mktemp)"
SANITIZED_HERMES_CONFIG_TMP="$(mktemp)"
EXISTING_CREDENTIAL_TMP="$(mktemp)"
EXISTING_HERMES_CREDENTIAL_TMP="$(mktemp)"
cleanup() {
  rm -f "${CREDENTIAL_TMP}" "${HERMES_CREDENTIAL_TMP}" "${SANITIZED_CONFIG_TMP}" \
    "${SANITIZED_MODELS_TMP}" "${SANITIZED_HERMES_CONFIG_TMP}" \
    "${EXISTING_CREDENTIAL_TMP}" "${EXISTING_HERMES_CREDENTIAL_TMP}"
}
trap cleanup EXIT

if [[ -s /etc/credstore.encrypted/zenos-runtime.env.cred ]]; then
  systemd-creds decrypt --name=zenos-runtime.env \
    /etc/credstore.encrypted/zenos-runtime.env.cred "${EXISTING_CREDENTIAL_TMP}" >/dev/null
fi
if [[ -s /etc/credstore.encrypted/hermes-zenos.env.cred ]]; then
  systemd-creds decrypt --name=hermes-zenos.env \
    /etc/credstore.encrypted/hermes-zenos.env.cred "${EXISTING_HERMES_CREDENTIAL_TMP}" >/dev/null
fi

python3 "${SOURCE_ROOT}/scripts/prepare-runtime-service-files.py" \
  "${CREDENTIAL_TMP}" \
  "${SANITIZED_CONFIG_TMP}" \
  "${HERMES_PROFILE_ROOT}/config.yaml" \
  "${SANITIZED_MODELS_TMP}" \
  "${HERMES_PROFILE_ROOT}/zenos-runtime.json" \
  "${SANITIZED_HERMES_CONFIG_TMP}" \
  "${HERMES_CREDENTIAL_TMP}" \
  "${SOURCE_ROOT}/.env.local" \
  "${HERMES_PROFILE_ROOT}/.env" \
  /root/.hermes/.env \
  "${EXISTING_CREDENTIAL_TMP}" \
  "${EXISTING_HERMES_CREDENTIAL_TMP}"

rm -f /etc/credstore.encrypted/zenos-runtime.env.cred
systemd-creds encrypt --with-key=host --name=zenos-runtime.env \
  "${CREDENTIAL_TMP}" /etc/credstore.encrypted/zenos-runtime.env.cred >/dev/null
chmod 0600 /etc/credstore.encrypted/zenos-runtime.env.cred
rm -f /etc/credstore.encrypted/hermes-zenos.env.cred
systemd-creds encrypt --with-key=host --name=hermes-zenos.env \
  "${HERMES_CREDENTIAL_TMP}" /etc/credstore.encrypted/hermes-zenos.env.cred >/dev/null
chmod 0600 /etc/credstore.encrypted/hermes-zenos.env.cred
rm -f /etc/zenos-runtime/runtime.env /etc/zenos-runtime/profile.env /etc/zenos-runtime/global.env
install -o root -g "${SERVICE_GROUP}" -m 0640 \
  "${SANITIZED_CONFIG_TMP}" /etc/zenos-runtime/hermes-config.yaml

install -o root -g "${SERVICE_GROUP}" -m 0640 \
  "${SANITIZED_MODELS_TMP}" /etc/zenos-runtime/models.json
HERMES_CONFIG_OWNER="root"
HERMES_CONFIG_GROUP="root"
if [[ "${HERMES_PROFILE_ROOT}" == /var/lib/hermes/* ]] && id -u "${HERMES_SERVICE_USER}" >/dev/null 2>&1; then
  HERMES_CONFIG_OWNER="${HERMES_SERVICE_USER}"
  HERMES_CONFIG_GROUP="${HERMES_SERVICE_GROUP}"
fi
install -o "${HERMES_CONFIG_OWNER}" -g "${HERMES_CONFIG_GROUP}" -m 0600 \
  "${SANITIZED_HERMES_CONFIG_TMP}" "${HERMES_PROFILE_ROOT}/config.yaml"

install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-runtime.service" /etc/systemd/system/zenos-runtime.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-memory-secondary-backup.service" /etc/systemd/system/zenos-memory-secondary-backup.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-memory-secondary-backup.timer" /etc/systemd/system/zenos-memory-secondary-backup.timer
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-runtime-backup.service" /etc/systemd/system/zenos-runtime-backup.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-runtime-backup.timer" /etc/systemd/system/zenos-runtime-backup.timer
HERMES_ZENOS_UNIT="${SOURCE_ROOT}/hermes-gateway-zenos.service"
if [[ -f "${HERMES_ZENOS_UNIT}" ]]; then
  install -o root -g root -m 0644 "${HERMES_ZENOS_UNIT}" /etc/systemd/system/hermes-gateway.service
fi
systemctl daemon-reload
systemctl enable zenos-runtime.service zenos-memory-secondary-backup.timer zenos-runtime-backup.timer >/dev/null
rollback_runtime() {
  if [[ -n "${PREVIOUS_RELEASE}" && -d "${PREVIOUS_RELEASE}" ]]; then
    ln -sfn "${PREVIOUS_RELEASE}" /opt/zenos-runtime/current
    systemctl restart zenos-runtime.service || true
  fi
}
ln -sfn "${RELEASE_ROOT}" /opt/zenos-runtime/current
if ! systemctl restart zenos-runtime.service; then
  rollback_runtime
  echo "Zenos Runtime deployment failed; restored the previous release." >&2
  exit 1
fi
RUNTIME_READY=false
for _ in {1..30}; do
  if curl --fail --silent --show-error --max-time 2 \
    http://127.0.0.1:3090/api/health >/dev/null; then
    RUNTIME_READY=true
    break
  fi
  sleep 1
done
if [[ "${RUNTIME_READY}" != "true" ]]; then
  rollback_runtime
  echo "Zenos Runtime failed its post-restart HTTP health gate; restored the previous release." >&2
  exit 1
fi
if [[ -n "${PREVIOUS_RELEASE}" && -d "${PREVIOUS_RELEASE}" && "${PREVIOUS_RELEASE}" != "${RELEASE_ROOT}" ]]; then
  ln -sfn "${PREVIOUS_RELEASE}" /opt/zenos-runtime/previous
fi
systemctl start zenos-memory-secondary-backup.timer
systemctl start zenos-runtime-backup.timer
systemctl start zenos-runtime-backup.service
if [[ -f "${HERMES_ZENOS_UNIT}" && "${ZENOS_DEPLOY_RESTART_HERMES:-true}" == "true" ]]; then
  systemctl enable hermes-gateway.service >/dev/null
  systemctl restart hermes-gateway.service
fi

# Services now receive the same values from encrypted systemd credentials.
# Remove persistent plaintext copies only after both Runtime and Hermes have
# restarted successfully.
rm -f \
  "${SOURCE_ROOT}/.env.local" \
  "${HERMES_PROFILE_ROOT}/.env" \
  /root/.hermes/profiles/zenos/.env \
  /root/.hermes/.env

CURRENT_RELEASE="$(readlink -f /opt/zenos-runtime/current)"
ROLLBACK_RELEASE="$(readlink -f /opt/zenos-runtime/previous 2>/dev/null || true)"
for candidate in /opt/zenos-runtime/releases/*; do
  [[ -d "${candidate}" ]] || continue
  resolved="$(readlink -f "${candidate}")"
  [[ "${resolved}" == "${CURRENT_RELEASE}" || "${resolved}" == "${ROLLBACK_RELEASE}" ]] && continue
  case "${resolved}" in
    /opt/zenos-runtime/releases/*) rm -rf -- "${resolved}" ;;
    *) echo "Refusing unsafe release cleanup target: ${resolved}" >&2; exit 1 ;;
  esac
done

printf 'Installed Zenos Runtime %s (%s) at %s\n' "${VERSION}" "${COMMIT}" "${RELEASE_ROOT}"
systemctl --no-pager --full status zenos-runtime.service
