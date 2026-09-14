#!/usr/bin/env bash
# ============================================================
# Sada all-in-one launcher (single-container deployment for
# Railway/Render/small VPS): web + realtime + worker sharing
# one SQLite file + local media dir on the mounted volume.
# Crash-propagation: if ANY service dies, the container exits
# and the platform's restart policy boots a fresh one.
# ============================================================
set -euo pipefail
cd /app

DATA_DIR="/app/data"
mkdir -p "$DATA_DIR/media"

# --- Persist auto-generated secrets across redeploys ---------
# Platform-provided env vars always win (ensureEnvKey checks
# process.env first); this file is only the fallback.
if [ -f "$DATA_DIR/.env" ]; then
  cp "$DATA_DIR/.env" /app/.env
fi
touch /app/.env
gen_hex() { head -c 48 /dev/urandom | base64 | tr -d '=+/' | head -c 48; }
for k in JWT_SECRET INTERNAL_SECRET APP_PEPPER; do
  if ! grep -q "^$k=" /app/.env; then
    printf '%s=%s\n' "$k" "$(gen_hex)" >> /app/.env
  fi
done
cp /app/.env "$DATA_DIR/.env"

# --- Schema → SQLite (idempotent, safe on every boot) --------
echo "[start-all] syncing prisma schema…"
bunx prisma db push --skip-generate

# --- Launch the three services --------------------------------
bun mini-services/realtime/index.ts & RT_PID=$!
bun mini-services/worker/index.ts   & WK_PID=$!
PORT="${PORT:-3000}" HOSTNAME="${HOSTNAME:-0.0.0.0}" NODE_ENV=production \
  bun server.js & WEB_PID=$!
echo "[start-all] up: web($WEB_PID) realtime($RT_PID) worker($WK_PID)"

trap 'kill "$RT_PID" "$WK_PID" "$WEB_PID" 2>/dev/null || true' TERM INT
wait -n "$RT_PID" "$WK_PID" "$WEB_PID"
CODE=$?
echo "[start-all] a service exited (code $CODE) — stopping the rest" >&2
kill "$RT_PID" "$WK_PID" "$WEB_PID" 2>/dev/null || true
exit "$CODE"
