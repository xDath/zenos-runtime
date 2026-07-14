#!/usr/bin/env bash
set -euo pipefail

UNIT="zenos-coding-continuity-smoke-$(date +%s)"
systemd-run \
  --wait \
  --pipe \
  --collect \
  --unit="${UNIT}" \
  --property=WorkingDirectory=/opt/zenos-runtime/current \
  --property=LoadCredentialEncrypted=zenos-runtime.env:/etc/credstore.encrypted/zenos-runtime.env.cred \
  /usr/bin/node scripts/smoke-live-coding-continuity.mjs
