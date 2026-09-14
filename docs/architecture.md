# Sada (صدى) — Architecture

> Production-grade messenger inspired by the requirements in `messenger_app_prompt(2).txt`.
> This document maps every required flow to its implementation (spec §54).

## 1. System overview

```
                       ┌─────────────────────┐
                       │   Client (PWA)      │
                       │  Next.js SPA + SW   │
                       │  offline outbox     │
                       └───────┬─────────────┘
                               │ HTTPS / WSS (Caddy)
                ┌──────────────┴───────────────┐
                │                              │
      ┌─────────▼─────────┐          ┌─────────▼─────────┐
      │  API (Next.js)    │ internal │  Realtime (WS)    │
      │  /api/v1/* REST   │──emit───▶│  socket.io :3003  │
      │  auth·chats·msgs  │  (HMAC)  │  presence·typing  │
      │  media·sync·admin │          │  call signaling   │
      └─────────┬─────────┘          └─────────┬─────────┘
                │                              │
      ┌─────────▼──────────────────────────────▼─────────┐
      │              PostgreSQL (source of truth)         │
      │   dev: SQLite (same Prisma schema) + WAL          │
      └─────────────────────┬────────────────────────────┘
                            │
      ┌─────────────────────▼────────────────────────────┐
      │  Worker (jobs): thumbnails · link previews ·      │
      │  push · scheduled sends · cleanup · moderation    │
      └─────────────────────┬────────────────────────────┘
                            │
      ┌─────────────────────▼────────────────────────────┐
      │  Object storage (MinIO/S3, content-addressed)     │
      │        ▶ served via CDN (signed/expiring URLs)    │
      └───────────────────────────────────────────────────┘
```

### Component responsibilities

| Component | Responsibility | Scaling |
|---|---|---|
| **Web/API** | REST `/api/v1/*`, auth, permissions, media metadata, sync API | Stateless → N replicas |
| **Realtime** | socket.io gateway, all 16+ event types, presence, typing, WebRTC signaling, durable-event tail | Redis adapter → N instances |
| **Worker** | media variants, link previews, push dispatch, scheduled sends, retention cleanup | Horizontal by queue depth |
| **PostgreSQL** | authoritative relational store (users, chats, messages, events, jobs) | Primary + read replicas |
| **Redis** | rate limits, presence fan-out, socket.io adapter, queue (prod option) | Cache only — never truth |
| **Object storage** | immutable content-addressed media blobs | Versioning + lifecycle |
| **CDN** | signed, expiring media delivery | Edge caching |

## 2. Request flow (authenticated REST)

1. Client calls `/api/v1/**` with `HttpOnly` session cookie (or `Authorization: Bearer`).
2. `createApiHandler` assigns a `requestId` (uuid), parses cookies, enforces the default per-user rate limit, resolves the JWT access token (15 min) → loads the session row → validates revocation/expiry/ban → builds `ctx.auth`.
3. Router matches `method + segments` to a service function; services validate input with zod, run **server-side authorization** (membership + granular permission sets), and write through Prisma transactions.
4. Errors are a consistent envelope: `{ok:false, error:{code,message,details}, requestId}` with proper HTTP status (400/401/403/404/409/413/429/500).
5. Slow requests (>1s) and all admin calls emit structured JSON logs with the requestId (spec §27).

## 3. Message flow (send → deliver → read)

```
send (POST /chats/:id/messages)
 ├─ idempotency: clientMsgId unique per (chat,sender) → duplicate returns original
 ├─ checks: membership · role/perms · slow-mode · block-lists · size limits
 ├─ TX: message(seq=max+1) · attachments · unread+1 (except sender)
 │      · chat lastMessage cache · sender auto-read
 ├─ events: append MESSAGE_CREATED (durable, seq) + emit → realtime rooms
 ├─ jobs:  link.preview · push.send (worker)
 └─ client: optimistic bubble (pending) → confirmed by socket/sync response

delivery/read
 ├─ recipients' sockets auto-mark lastDeliveredSeq (MESSAGE_DELIVERED relayed)
 ├─ open chat → POST /chats/:id/read {upToSeq} → unread reset, mention reset
 └─ MESSAGE_READ event → sender sees ✓✓ (seen-by count in groups)
```

**Ordering guarantee:** a single transactional `seq` allocator (SQLite serializes writers; Postgres uses IDENTITY). Pagination cursors and the sync protocol both ride on this total order — out-of-order arrival cannot corrupt history.

## 4. Upload flow (media never touches the API in production — spec §8)

```
1. POST /media/upload-session  → validate kind/size/limits, create session
2. client uploads DIRECTLY:
   · s3 driver: presigned PUT (SigV4, 1h TTL) → object storage
   · local driver (dev): authorized PUT /media/upload/:id (parts supported)
3. POST /media/upload/:id/complete
   · server verifies: byte count, SHA-256 (declared vs actual), magic-byte
     sniffing (client MIME never trusted — spec §42)
   · moves to content-addressed key: media/<h2>/<sha256>/original
   · dedupes identical content globally
4. worker job media.process → sharp variants (thumb 320w, medium 1280w,
   webp) + blur placeholder → variants JSON on MediaObject
5. access = HMAC-signed URL (user-bound, 15-min expiry) through
   /api/v1/media/file; production CDN fronts the same URLs with
   immutable long cache headers (spec §36)
```

Download flow: signed URL → CDN → origin (object storage). The API process streams bytes only in local-dev mode, with Range support and `private, immutable` cache headers.

## 5. Authentication flow (spec §15)

```
phone → OTP (hashed sha256+salt, 5-min TTL, ≤5 attempts, rate-limited
per phone AND per IP) → verify →
  ├─ 2FA enabled? → twofa ticket (2-min JWT) → TOTP verify → session
  └─ session: refresh token (64B random, SHA-256 at rest, 30-day,
     rotation with reuse detection → family revocation) +
     access JWT (15-min, HttpOnly cookie + Bearer for native clients)
```

Tokens live in `HttpOnly; SameSite=Lax; Secure` cookies — never in localStorage. Device sessions are enumerable/revocable individually or all-at-once. Logout-all + ban flows revoke sessions immediately (JWT checks the session table on every request — a revoked refresh cannot mint new access tokens beyond the 15-min access window).

## 6. Reconnection & offline synchronization (spec §6, §33, §34)

```
WebSocket drops (network change / server restart)
 ├─ client keeps local state (IndexedDB outbox + in-memory messages)
 ├─ reconnect with exponential backoff (800ms → 30s cap), fresh socket token
 ├─ on connect: subscribe chat rooms → GET /api/v1/sync?since=<cursor>
 │   · durable Event log replays everything the device missed
 │   · affected chats re-fetched, unread counters converge
 └─ outbox flush: queued messages POST with clientMsgId (idempotent —
     a retry after a half-completed send cannot duplicate)
```

The server additionally tails the Event table every 4s and pushes anything the in-process emit path missed — no silent message loss even if an internal emit fails.

## 7. Calls (calls-ready — implemented for 1:1)

WebRTC peer-to-peer audio/video with:
- signaling: `CALL_OFFER / CALL_ANSWER / CALL_ICE / CALL_END` relayed through the realtime service (validated: both users must share a chat)
- STUN via public Google servers; TURN relay is a deployment-level addition (coturn) for strict-NAT networks
- screen sharing via `getDisplayMedia` + `RTCRtpSender.replaceTrack`
- group calls/scheduling remain architecture-ready (SFU section in scaling docs)

## 8. Security model (spec §16-17, §42)

- **Transport:** TLS everywhere (Caddy auto-HTTPS); HSTS, nosniff, frame-deny, restrictive Permissions-Policy.
- **Authorization:** every privileged operation re-checks membership + granular permission set server-side; the client is never trusted (`is_admin` from a client is ignored by design).
- **Rate limits:** per-route sliding windows (login, OTP, sends, uploads, username changes, group/channel creation, search) → HTTP 429 + Retry-After; Redis-backed store in production.
- **Media safety:** magic-byte sniffing, size caps per kind, filename sanitization (path-traversal safe), checksum verification, private bucket (no public write), signed short-lived access, optional AV-scan hook (`scanStatus`).
- **SSRF guard:** link-preview worker blocks loopback/private/link-local/metadata hosts, caps size and time.
- **Audit:** security-relevant actions (logins, bans, role changes, deletions, admin actions) land in `AuditLog`.
- **Honest encryption posture:** cloud chats are TLS + at-rest encrypted storage + ACL — **not** advertised as E2EE. Secret chats are architected for later with an audited protocol (spec Rule 13: never invent cryptography).

## 9. Data retention & privacy (spec §49)

- Account deletion: scheduled job → revoke sessions/push → leave chats → tombstone messages → anonymize user row (phone → `deleted-<id>`), audit-logged.
- Data export: `/api/v1/users/me/export` (profile, settings, privacy, memberships, messages, contacts).
- Event log pruned after `EVENT_RETENTION_DAYS` (default 7); finished jobs pruned hourly; expired upload sessions removed with their temp parts.
- Contact sync uploads SHA-256 hashes only — raw numbers never leave the device.

## 10. Cost-aware scaling path (spec §55)

1. **First bottleneck — DB writes** (single-node SQLite dev ≈ 100 msg/s): move to Postgres (compose included), add read replica.
2. **Second — fan-out**: Redis pub/sub adapter for realtime, move emit pipeline off the API process.
3. **Third — bandwidth**: CDN in front of object storage (compose ships MinIO + Caddy cache config); media bytes dominate egress by ~50:1 over API traffic.
4. **Fourth — queue depth**: run more worker replicas (already stateless); ffmpeg transcodes are the CPU-heavy class — autoscale on queue depth.
5. Only after all four: shard messages by chat_id ranges; none of the above requires application rewrites — every boundary (driver, adapter, service) is an interface today.
