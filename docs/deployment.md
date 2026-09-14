# Deployment Guide

## A. Local development (this sandbox / any machine)

```bash
# 1. infrastructure is embedded (SQLite + in-process stores)
bun install

# 2. schema
bun run db:push

# 3. seeds: admin-by-env + demo users + group + channel
bun scripts/seed.ts

# 4. services (three processes)
bun run dev                          # API + client  → :3000
cd mini-services/realtime && bun run dev   # realtime     → :3003
cd mini-services/worker && bun run dev     # worker

# 5. open the app and log in
#    OTP dev-echo returns the code in the API response (and logs)
#    demo users: +9647700000001 .. 0004 (ahmed/fatima/ali/zainab)
```

Push notifications (optional, works locally):
```bash
bun scripts/gen-vapid.ts   # writes VAPID keys into .env, restart services
```

## B. Production (docker compose)

```bash
cp .env.example .env
# fill: POSTGRES_PASSWORD, JWT_SECRET, INTERNAL_SECRET, APP_PEPPER,
#       OBJECT_STORAGE_* (MinIO keys), ADMIN_USERNAME/ADMIN_PASSWORD,
#       optional: VAPID_*, SMS_GATEWAY_*, CDN_BASE_URL
bun scripts/gen-vapid.ts      # generates + appends keys

docker compose -f infrastructure/docker-compose.yml --env-file .env up -d --build

# run migrations (first boot and after schema changes)
docker compose -f infrastructure/docker-compose.yml exec web \
  bunx prisma migrate deploy
```

What compose provides:
- **web ×2** (stateless API + client), **realtime**, **worker ×2** (with ffmpeg)
- **postgres 16** (source of truth), **redis 7** (limits/presence/adapter)
- **minio** private bucket `sada-media` + init job
- **caddy**: auto-HTTPS, WebSocket upgrade, immutable media cache, security headers

Health checks: `GET /api/v1/health` (web), `GET :3003/internal/health` (realtime).
Post-deploy verification: log in → send message between two devices → confirm socket delivery + unread counters → upload an image → confirm variants exist (`media/<h2>/<hash>/thumb`).

## C. Rollback (spec §47)

Deployments are tagged images. On failed health check after a rollout:
```bash
docker compose -f infrastructure/docker-compose.yml down web worker realtime
# pin previous image tags, then up -d
```
Migrations are forward-only; risky migrations ship expand/contract (add nullable → backfill → switch reads → drop) so a rollback never needs a down-migration.

## D. Mobile builds (Android/iOS)

The client is an installable PWA (manifest + service worker + Web Push):
- Android Chrome/Edge: "Install app" → standalone, offline shell, push
- iOS Safari: Share → Add to Home Screen
- A native Flutter/React Native shell can reuse the same `/api/v1` contract + socket protocol unchanged (`auth/socket-token` issues 60-second WS tokens for native clients).
