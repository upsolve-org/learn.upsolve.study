#!/usr/bin/env bash
# Atomic artifact deploy for learn.upsolve.study on Pandev.
# Usage: deploy-release.sh <path-to-release-tar.gz>
#
# Reuses /srv/learn/node_modules via hard-links when package-lock.json is
# unchanged (~20-30s total deploy, zero build on the VPS), falls back to
# `npm ci` when dependencies changed, verifies HTTP 200 + active systemd
# units, and automatically rolls back on failure.
set -euo pipefail

TARBALL="${1:-/tmp/learn-release.tar.gz}"
LIVE_DIR="/srv/learn"
NEXT_DIR="/srv/learn-next"
STAMP="$(date +%F-%H%M%S)"
BACKUP_DIR="/srv/learn-bak-${STAMP}"

export PATH="/usr/local/lib/library-node/bin:${PATH}"

if [[ ! -f "${TARBALL}" ]]; then
  echo "[deploy] Release tarball not found: ${TARBALL}" >&2
  exit 1
fi

echo "[deploy] Extracting ${TARBALL} into ${NEXT_DIR}..."
rm -rf "${NEXT_DIR}"
mkdir -p "${NEXT_DIR}"
tar xzf "${TARBALL}" -C "${NEXT_DIR}"
rm -f "${TARBALL}"

if [[ ! -f "${LIVE_DIR}/.env.local" ]]; then
  echo "[deploy] Missing ${LIVE_DIR}/.env.local" >&2
  exit 1
fi
cp -a "${LIVE_DIR}/.env.local" "${NEXT_DIR}/.env.local"
chmod 600 "${NEXT_DIR}/.env.local"

# Reuse node_modules when package-lock.json is unchanged (fast hard-link copy).
OLD_LOCK=""
NEW_LOCK=""
if [[ -f "${LIVE_DIR}/package-lock.json" ]]; then
  OLD_LOCK="$(sha256sum "${LIVE_DIR}/package-lock.json" | awk '{print $1}')"
fi
if [[ -f "${NEXT_DIR}/package-lock.json" ]]; then
  NEW_LOCK="$(sha256sum "${NEXT_DIR}/package-lock.json" | awk '{print $1}')"
fi

if [[ -n "${OLD_LOCK}" && "${OLD_LOCK}" == "${NEW_LOCK}" && -d "${LIVE_DIR}/node_modules" ]]; then
  echo "[deploy] package-lock.json unchanged — hard-linking node_modules..."
  cp -al "${LIVE_DIR}/node_modules" "${NEXT_DIR}/node_modules"
else
  echo "[deploy] package-lock.json changed — running npm ci..."
  (cd "${NEXT_DIR}" && npm ci)
fi

chown -R learn:learn "${NEXT_DIR}"

echo "[deploy] Stopping services for atomic swap..."
systemctl stop learn-worker.service learn.service

if [[ -d "${LIVE_DIR}/data" ]]; then
  cp -a "${LIVE_DIR}/data" "${NEXT_DIR}/data"
  chown -R learn:learn "${NEXT_DIR}/data"
fi

mv "${LIVE_DIR}" "${BACKUP_DIR}"
mv "${NEXT_DIR}" "${LIVE_DIR}"

rollback() {
  echo "[deploy] Health check failed — rolling back to ${BACKUP_DIR}..." >&2
  systemctl stop learn-worker.service learn.service || true
  rm -rf "/srv/learn-failed-${STAMP}"
  mv "${LIVE_DIR}" "/srv/learn-failed-${STAMP}" || true
  mv "${BACKUP_DIR}" "${LIVE_DIR}"
  systemctl start learn.service learn-worker.service
  exit 1
}

echo "[deploy] Starting services..."
systemctl start learn.service learn-worker.service

OK=0
for _ in $(seq 1 20); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8300/auth/login || true)"
  if [[ "${CODE}" == "200" ]] && systemctl is-active --quiet learn.service && systemctl is-active --quiet learn-worker.service; then
    OK=1
    break
  fi
  sleep 1
done

if [[ "${OK}" != "1" ]]; then
  journalctl -u learn.service -n 25 --no-pager >&2 || true
  journalctl -u learn-worker.service -n 15 --no-pager >&2 || true
  rollback
fi

# Keep only the 2 most recent /srv/learn-bak-* directories to bound disk usage.
ls -1dt /srv/learn-bak-* 2>/dev/null | tail -n +3 | xargs -r rm -rf

echo "[deploy] Live and healthy (HTTP 200, learn.service + learn-worker.service active)."
