# Scaling Strategy (spec §26, §39, §55)

## Current measured baseline (dev, single node)

`bun scripts/load-test.ts 10 5` gives an honest snapshot: p95 send ≈ 20-60 ms,
p95 fetch ≈ 10-30 ms, throughput ceiling bounded by SQLite write serialization
(~100-150 msg/s). Do **not** extrapolate "millions of users" from this — the
point is the scaling plan below, each step of which is already an interface
in the code, not a rewrite.

## Scale-out plan (in the order costs bite)

| Stage | Bottleneck | Action | Code hook |
|---|---|---|---|
| 1 | DB writes (SQLite) | Swap `DATABASE_URL` to Postgres (schema.postgres.prisma + `infrastructure/postgres/001_fulltext.sql` FTS) | Prisma datasource |
| 2 | API capacity | Run N stateless `web` replicas behind Caddy/LB (compose `replicas: 2`) | already stateless |
| 3 | Realtime fan-out | `@socket.io/redis-adapter` on `REDIS_URL`; presence + rate-limit stores → Redis (`RateLimitStore` interface implemented by memory today) | `rate-limit.ts`, realtime service |
| 4 | Media bandwidth | CDN in front of object storage; URLs are content-addressed & immutable → `max-age=31536000` without invalidation | `CDN_BASE_URL`, §36 |
| 5 | Job backlog | More worker replicas; partition heavy classes (ffmpeg) onto dedicated workers; Redis/BullMQ driver if DB-queue polling becomes the limit | `queue.service` interface |
| 6 | Postgres writes | Read replicas for history/pagination reads; `pgbouncer`; partition `Message`/`Event` by `chatId`/time ranges | schema split-ready |
| 7 | Fan-out amplification | Channel posts fan out to N subscribers: batch room emits, move to Redis pub/sub pipelines, per-subscriber delivery is pull-based on open (already the design for channels) | realtime service |

## Why no premature microservices (spec Rule 3)

Three deployables (web, realtime, worker) with strict module boundaries
(`src/lib/server/services/*`) cover the Telegram-class feature set. Every
boundary that will eventually need splitting (auth, media, search, push)
is already a service module with a narrow interface — extracting it later
is an operation, not a re-architecture.

## Load-testing regime (spec §39)

- `bun scripts/load-test.ts <users> <msgs>` — auth + send + fetch mix, p50/p95
- Gate: p95 send < 200 ms and error rate < 0.1% at 2× expected peak before promoting a build
- WebSocket soak: reconnect storm test (kill half the sockets, verify sync converges with zero message loss — the Event-log tail guarantees this)
