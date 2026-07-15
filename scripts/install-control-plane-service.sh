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
CURRENT_TARGET="${PREVIOUS_RELEASE}"
ROLLBACK_TARGET="$(readlink -f /opt/zenos-runtime/previous 2>/dev/null || true)"
if [[ -e "${RELEASE_ROOT}" ]]; then
  RESOLVED_RELEASE="$(readlink -f "${RELEASE_ROOT}")"
  if [[ "${RESOLVED_RELEASE}" == "${CURRENT_TARGET}" ]]; then
    echo "Runtime release is already active: ${RELEASE_ROOT}"
    exit 0
  fi
  if [[ "${RESOLVED_RELEASE}" == "${ROLLBACK_TARGET}" ]]; then
    echo "Refusing to replace the rollback Runtime release: ${RELEASE_ROOT}" >&2
    exit 1
  fi
fi
SERVICE_USER="zenos-runtime"
SERVICE_GROUP="zenos-runtime"
HERMES_SERVICE_USER="hermes"
HERMES_SERVICE_GROUP="hermes"
ROUTER_SERVICE_USER="etla-router"
ROUTER_SERVICE_GROUP="etla-router"
HERMES_PROFILE_ROOT="/var/lib/hermes/.hermes/profiles/zenos"
LEGACY_HERMES_PROFILE_ROOT="/root/.hermes/profiles/zenos"
WORKSPACE_SOURCE="$(cd "${SOURCE_ROOT}/.." && pwd)"
WORKSPACE_ROOT="/srv/etla/workspaces"

if ! getent group "${SERVICE_GROUP}" >/dev/null; then
  groupadd --system "${SERVICE_GROUP}"
fi
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${SERVICE_GROUP}" --home-dir /var/lib/zenos-runtime --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
if ! getent group "${HERMES_SERVICE_GROUP}" >/dev/null; then
  groupadd --system "${HERMES_SERVICE_GROUP}"
fi
if ! id -u "${HERMES_SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${HERMES_SERVICE_GROUP}" --home-dir /var/lib/hermes --shell /usr/sbin/nologin "${HERMES_SERVICE_USER}"
fi
if ! getent group "${ROUTER_SERVICE_GROUP}" >/dev/null; then
  groupadd --system "${ROUTER_SERVICE_GROUP}"
fi
if ! id -u "${ROUTER_SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${ROUTER_SERVICE_GROUP}" --home-dir /var/lib/9router --shell /usr/sbin/nologin "${ROUTER_SERVICE_USER}"
fi
command -v setfacl >/dev/null 2>&1 || {
  echo "The acl package is required for least-privilege workspace access." >&2
  exit 1
}

# Hermes was originally installed by uv with its CPython base under /root.
# A non-root sandbox cannot safely traverse that path, and substituting the
# system Python would mix CPython 3.12 with 3.11 extension modules. Mirror the
# complete immutable 3.11 runtime into /usr/local instead.
HERMES_PYTHON_EXECUTABLE="$(readlink -f /usr/local/lib/hermes-agent/venv/bin/python)"
HERMES_PYTHON_SOURCE="$(cd "$(dirname "${HERMES_PYTHON_EXECUTABLE}")/.." && pwd)"
[[ -x "${HERMES_PYTHON_SOURCE}/bin/python3.11" && -d "${HERMES_PYTHON_SOURCE}/lib/python3.11" ]] || {
  echo "Hermes CPython 3.11 base runtime is incomplete: ${HERMES_PYTHON_SOURCE}" >&2
  exit 1
}
install -d -o root -g root -m 0755 /usr/local/lib/hermes-python
rsync -a --delete "${HERMES_PYTHON_SOURCE}/" /usr/local/lib/hermes-python/
chown -R root:root /usr/local/lib/hermes-python
find /usr/local/lib/hermes-python -xdev -type d -exec chmod go-w {} +
find /usr/local/lib/hermes-python -xdev -type f -exec chmod go-w {} +

install -d -o root -g root -m 0755 /opt/zenos-runtime /opt/zenos-runtime/releases /srv/etla
install -d -o root -g root -m 0755 "${WORKSPACE_ROOT}"
install -d -o "${HERMES_SERVICE_USER}" -g "${HERMES_SERVICE_GROUP}" -m 0700 \
  /var/lib/hermes /var/lib/hermes/.hermes /var/lib/hermes/.hermes/profiles

# Migrate the live profile before preparing credentials/config. Keep the legacy
# path as a compatibility symlink, but the service identity owns the canonical
# profile from this point onward. Broker-triggered deployments deliberately
# leave the calling gateway online and defer its unit/credential reload.
if [[ "${ZENOS_DEPLOY_RESTART_HERMES:-true}" == "true" ]]; then
  systemctl stop hermes-gateway.service 2>/dev/null || true
fi
if [[ -L "${LEGACY_HERMES_PROFILE_ROOT}" ]]; then
  [[ "$(readlink -f "${LEGACY_HERMES_PROFILE_ROOT}")" == "${HERMES_PROFILE_ROOT}" ]] || {
    echo "Legacy Hermes profile symlink points to an unexpected target." >&2
    exit 1
  }
elif [[ -d "${LEGACY_HERMES_PROFILE_ROOT}" && ! -e "${HERMES_PROFILE_ROOT}" ]]; then
  mv "${LEGACY_HERMES_PROFILE_ROOT}" "${HERMES_PROFILE_ROOT}"
  ln -s "${HERMES_PROFILE_ROOT}" "${LEGACY_HERMES_PROFILE_ROOT}"
elif [[ -d "${LEGACY_HERMES_PROFILE_ROOT}" && -d "${HERMES_PROFILE_ROOT}" ]]; then
  echo "Both legacy and canonical Hermes profiles exist; refusing an ambiguous merge." >&2
  exit 1
elif [[ ! -d "${HERMES_PROFILE_ROOT}" ]]; then
  install -d -o "${HERMES_SERVICE_USER}" -g "${HERMES_SERVICE_GROUP}" -m 0700 "${HERMES_PROFILE_ROOT}"
fi
chown -R "${HERMES_SERVICE_USER}:${HERMES_SERVICE_GROUP}" "${HERMES_PROFILE_ROOT}"
find "${HERMES_PROFILE_ROOT}" -xdev -type d -exec chmod u+rwx,go-rwx {} +
find "${HERMES_PROFILE_ROOT}" -xdev -type f -exec chmod u+rw,go-rwx {} +
python3 "${SOURCE_ROOT}/scripts/migrate-hermes-runtime-paths.py" "${HERMES_PROFILE_ROOT}"
install -d -o root -g "${SERVICE_GROUP}" -m 0750 /etc/zenos-runtime
install -d -o "${ROUTER_SERVICE_USER}" -g "${ROUTER_SERVICE_GROUP}" -m 0700 /var/lib/9router /var/cache/9router
if [[ -d /opt/9router/data ]]; then
  rsync -a /opt/9router/data/ /var/lib/9router/
  chown -R "${ROUTER_SERVICE_USER}:${ROUTER_SERVICE_GROUP}" /var/lib/9router
  find /var/lib/9router -xdev -type d -exec chmod 0700 {} +
  find /var/lib/9router -xdev -type f -exec chmod 0600 {} +
fi
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

# The bind-mounted path avoids exposing /root to either service. ACLs grant the
# gateway read/write access and Runtime read-only repository intelligence while
# preserving existing project ownership.
setfacl -R -m "u:${HERMES_SERVICE_USER}:rwX,u:${SERVICE_USER}:rX" "${WORKSPACE_SOURCE}"
find "${WORKSPACE_SOURCE}" -xdev -type d -exec setfacl \
  -m "d:u:${HERMES_SERVICE_USER}:rwX,d:u:${SERVICE_USER}:rX" {} +
runuser -u "${HERMES_SERVICE_USER}" -- env HOME=/var/lib/hermes \
  git -C /var/lib/hermes config --global --replace-all safe.directory '*'
runuser -u "${SERVICE_USER}" -- env HOME=/var/lib/zenos-runtime \
  git -C /var/lib/zenos-runtime config --global --replace-all safe.directory '*'

rm -rf "${STAGING}"
if [[ -e "${RELEASE_ROOT}" ]]; then
  rm -rf -- "${RELEASE_ROOT}"
fi
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
ROUTER_ENV_SOURCE_TMP="$(mktemp)"
ROUTER_ENV_TMP="$(mktemp)"
ROUTER_UNIT_BACKUP_TMP="$(mktemp)"
cleanup() {
  rm -f "${CREDENTIAL_TMP}" "${HERMES_CREDENTIAL_TMP}" "${SANITIZED_CONFIG_TMP}" \
    "${SANITIZED_MODELS_TMP}" "${SANITIZED_HERMES_CONFIG_TMP}" \
    "${EXISTING_CREDENTIAL_TMP}" "${EXISTING_HERMES_CREDENTIAL_TMP}" \
    "${ROUTER_ENV_SOURCE_TMP}" "${ROUTER_ENV_TMP}" "${ROUTER_UNIT_BACKUP_TMP}"
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
if [[ -s /etc/credstore.encrypted/9router.env.cred ]]; then
  systemd-creds decrypt --name=9router.env \
    /etc/credstore.encrypted/9router.env.cred "${ROUTER_ENV_SOURCE_TMP}" >/dev/null
elif [[ -s /opt/9router/.env ]]; then
  cp /opt/9router/.env "${ROUTER_ENV_SOURCE_TMP}"
else
  echo "No 9Router credential source exists." >&2
  exit 1
fi
python3 "${SOURCE_ROOT}/scripts/prepare-9router-environment.py" \
  "${ROUTER_ENV_SOURCE_TMP}" "${ROUTER_ENV_TMP}"

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
rm -f /etc/credstore.encrypted/9router.env.cred
systemd-creds encrypt --with-key=host --name=9router.env \
  "${ROUTER_ENV_TMP}" /etc/credstore.encrypted/9router.env.cred >/dev/null
chmod 0600 /etc/credstore.encrypted/9router.env.cred
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

install -o root -g root -m 0755 "${SOURCE_ROOT}/scripts/etla-ops-broker.py" /usr/local/sbin/etla-ops-broker
install -o root -g root -m 0755 "${SOURCE_ROOT}/scripts/etla-ops-client.py" /usr/local/bin/etla-ops
install -o root -g root -m 0755 "${SOURCE_ROOT}/scripts/etla-maintenance.sh" /usr/local/sbin/etla-maintenance
install -o root -g root -m 0755 "${SOURCE_ROOT}/scripts/run-9router-with-credential.py" /usr/local/sbin/run-9router-with-credential
install -o root -g root -m 0755 "${SOURCE_ROOT}/scripts/run-hermes-gateway-with-credential.py" /usr/local/sbin/run-hermes-gateway-with-credential
if [[ -f /etc/systemd/system/9router.service ]]; then
  cp /etc/systemd/system/9router.service "${ROUTER_UNIT_BACKUP_TMP}"
fi
install -o root -g root -m 0644 "${SOURCE_ROOT}/9router.service" /etc/systemd/system/9router.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/srv-etla-workspaces.mount" /etc/systemd/system/srv-etla-workspaces.mount
install -o root -g root -m 0644 "${SOURCE_ROOT}/etla-ops-broker.service" /etc/systemd/system/etla-ops-broker.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/etla-maintenance.service" /etc/systemd/system/etla-maintenance.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/etla-maintenance.timer" /etc/systemd/system/etla-maintenance.timer
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-runtime.service" /etc/systemd/system/zenos-runtime.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-memory-secondary-backup.service" /etc/systemd/system/zenos-memory-secondary-backup.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-memory-secondary-backup.timer" /etc/systemd/system/zenos-memory-secondary-backup.timer
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-runtime-backup.service" /etc/systemd/system/zenos-runtime-backup.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-runtime-backup.timer" /etc/systemd/system/zenos-runtime-backup.timer
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-offsite-backup.service" /etc/systemd/system/zenos-offsite-backup.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/zenos-offsite-backup.timer" /etc/systemd/system/zenos-offsite-backup.timer
HERMES_ZENOS_UNIT="${SOURCE_ROOT}/hermes-gateway-zenos.service"
if [[ -f "${HERMES_ZENOS_UNIT}" ]]; then
  install -o root -g root -m 0644 "${HERMES_ZENOS_UNIT}" /etc/systemd/system/hermes-gateway.service
fi
MEMORY_PLUGIN_SOURCE="${WORKSPACE_SOURCE}/zenos-memory/plugins/zenos-memory"
if [[ -d "${MEMORY_PLUGIN_SOURCE}" ]]; then
  install -d -o "${HERMES_SERVICE_USER}" -g "${HERMES_SERVICE_GROUP}" -m 0700 "${HERMES_PROFILE_ROOT}/plugins"
  rm -rf "${HERMES_PROFILE_ROOT}/plugins/zenos-memory"
  cp -a "${MEMORY_PLUGIN_SOURCE}" "${HERMES_PROFILE_ROOT}/plugins/zenos-memory"
  chown -R "${HERMES_SERVICE_USER}:${HERMES_SERVICE_GROUP}" "${HERMES_PROFILE_ROOT}/plugins/zenos-memory"
  find "${HERMES_PROFILE_ROOT}/plugins/zenos-memory" -type d -exec chmod 0700 {} +
  find "${HERMES_PROFILE_ROOT}/plugins/zenos-memory" -type f -exec chmod 0600 {} +
fi

systemctl daemon-reload
systemctl enable 9router.service srv-etla-workspaces.mount etla-ops-broker.service zenos-runtime.service \
  zenos-memory-secondary-backup.timer zenos-runtime-backup.timer zenos-offsite-backup.timer \
  etla-maintenance.timer >/dev/null
systemctl start srv-etla-workspaces.mount
rollback_runtime() {
  if [[ -n "${PREVIOUS_RELEASE}" && -d "${PREVIOUS_RELEASE}" ]]; then
    ln -sfn "${PREVIOUS_RELEASE}" /opt/zenos-runtime/current
    systemctl restart zenos-runtime.service || true
  fi
}
rollback_router() {
  if [[ -s "${ROUTER_UNIT_BACKUP_TMP}" ]]; then
    cp "${ROUTER_UNIT_BACKUP_TMP}" /etc/systemd/system/9router.service
    systemctl daemon-reload
    systemctl restart 9router.service || true
  fi
}
ln -sfn "${RELEASE_ROOT}" /opt/zenos-runtime/current
if [[ "${ZENOS_DEPLOY_RESTART_BROKER:-true}" == "true" ]]; then
  if ! systemctl restart etla-ops-broker.service; then
    rollback_runtime
    echo "Etla operations broker failed to start on the new release." >&2
    exit 1
  fi
fi
if ! systemctl restart 9router.service; then
  rollback_router
  rollback_runtime
  echo "Hardened 9Router failed to start; restored its previous unit." >&2
  exit 1
fi
ROUTER_READY=false
for _ in {1..30}; do
  if curl --fail --silent --output /dev/null --max-time 2 http://127.0.0.1:20128/api/health; then
    ROUTER_READY=true
    break
  fi
  sleep 1
done
if [[ "${ROUTER_READY}" != "true" \
  || "$(systemctl show 9router.service -p User --value)" != "${ROUTER_SERVICE_USER}" \
  || ! "$(ss -ltnH 'sport = :20128' | awk '{print $4}')" =~ ^127\.0\.0\.1:20128$ ]]; then
  rollback_router
  rollback_runtime
  echo "Hardened 9Router failed its user, loopback, or HTTP health gate." >&2
  exit 1
fi
rm -f /opt/9router/.env

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

start_oneshot_with_retry() {
  local unit="$1"
  local attempts="${2:-3}"
  local delay_seconds="${3:-10}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
    if systemctl start "${unit}"; then
      return 0
    fi
    if ((attempt < attempts)); then
      echo "${unit} failed attempt ${attempt}/${attempts}; retrying in ${delay_seconds}s." >&2
      sleep "${delay_seconds}"
    fi
  done
  return 1
}

# Prove the cloud Memory data plane end to end before removing the legacy local
# sidecar from the boot graph. This performs scoped auth, Drive-backed write,
# recall, optimistic edit, readiness, and archive in an isolated smoke namespace.
if ! (
  set -a
  # shellcheck disable=SC1090
  source "${CREDENTIAL_TMP}"
  set +a
  export ZENOS_MEMORY_SMOKE_URL=https://zenos-memory.vercel.app
  /usr/bin/node "${WORKSPACE_SOURCE}/zenos-memory/scripts/smoke-production.mjs"
); then
  rollback_runtime
  echo "Cloud Zenos Memory smoke failed; restored the previous Runtime release and kept the local sidecar." >&2
  exit 1
fi

# Backups are a deployment gate, not an afterthought. Produce and locally
# restore-verify both encrypted artifacts, then upload/read-back verify them in
# Drive while the legacy sidecar is still available for emergency rollback.
if ! start_oneshot_with_retry zenos-runtime-backup.service 6 30 \
  || ! start_oneshot_with_retry zenos-memory-secondary-backup.service 3 10 \
  || ! start_oneshot_with_retry zenos-offsite-backup.service 3 10 \
  || ! start_oneshot_with_retry etla-maintenance.service 3 10; then
  rollback_runtime
  systemctl enable --now zenos-memory.service >/dev/null 2>&1 || true
  echo "Backup, offsite read-back, or maintenance gate failed; restored Runtime and kept local Memory." >&2
  exit 1
fi

# Cloud Memory is now canonical and the VPS is a thin client only. Remove the
# disabled sidecar unit and its reproducible deployment bundle after cloud,
# local-backup, and offsite read-back gates have all succeeded. Keep encrypted
# credentials and /var/lib state because backup/export clients still use them.
systemctl disable --now zenos-memory.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/zenos-memory.service
case /opt/zenos-memory in
  /opt/zenos-memory) rm -rf -- /opt/zenos-memory ;;
  *) echo "Refusing unsafe local Memory decommission path" >&2; exit 1 ;;
esac
systemctl daemon-reload
if [[ -n "${PREVIOUS_RELEASE}" && -d "${PREVIOUS_RELEASE}" && "${PREVIOUS_RELEASE}" != "${RELEASE_ROOT}" ]]; then
  ln -sfn "${PREVIOUS_RELEASE}" /opt/zenos-runtime/previous
fi
systemctl start zenos-memory-secondary-backup.timer
systemctl start zenos-runtime-backup.timer
systemctl start zenos-offsite-backup.timer
systemctl start etla-maintenance.timer
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
