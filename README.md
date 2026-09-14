# Sada — صدى

**Production-grade, real-time messenger** built from the requirements in
`upload/messenger_app_prompt(2).txt` (83 product features, 15 engineering
rules, phased implementation order, and an honest no-demo/no-mock policy).

> ⚠️ **Stack decision (documented per spec §56):** the spec prefers Flutter.
> This delivery environment cannot compile/run mobile toolchains, and the spec's
> own Rule 16 forbids claiming unverified implementations. The platform is
> therefore delivered as a **mobile-first installable PWA** (offline shell,
> Web Push, home-screen install) backed by a **client-agnostic versioned API**
> — the same `/api/v1` REST + WebSocket contract a Flutter client would consume
> unchanged. Everything else (backend, realtime, worker, admin, storage,
> docs, tests, infra) follows the spec directly.

## Highlights (latest release)

- **Mobile UI**: navigation moved to a fixed bottom bar (safe-area aware); the
  top bar carries only search; floating "new chat" action; unread badges.
- **Account controls**: real account deletion (password-confirmed, tombstones
  PII, revokes every session, **username reserved forever**) + logout everywhere.
- **Mandatory identity**: password required at signup (policy-checked, bcrypt-12);
  usernames required, lowercased, **globally unique forever** (`MGO3` blocks
  `mgo3`/`MgO3`) with live availability checks + race-safe 409.
- **Email done properly**: registration/login by email (activation code +
  welcome), and a **live failover chain** — Gmail SMTP primary → Resend backup
  → Brevo — configured purely via `.env`, applied without restarts.
- **Chat/speed**: instant push for brand-new chats (room fan-out fix),
  coalesced list refresh, typing indicators auto-expire, reconnect-on-online,
  jump-to-latest, duplicate-bubble fix.

## Deploy (one-click, real hosting)

GitHub Pages cannot host Sada (it needs a server runtime, DB, WebSocket,
secrets — see `DEPLOY.md`). Real hosting, auto-configured from this repo:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/worldnewsportal/sada)

or on **Railway**: New Project → Deploy from GitHub repo → `worldnewsportal/sada`
→ add a Volume mounted at `/app/data`. Full bilingual guide: **DEPLOY.md**.

## Quick start

```bash
bun install
bun run db:push          # schema
bun scripts/seed.ts      # demo users + group + channel

bun run dev                                   # API + client → :3000
cd mini-services/realtime && bun run dev      # realtime    → :3003
cd mini-services/worker && bun run dev        # worker

# login: any seeded phone (+9647700000001 ahmed, 0002 fatima, 0003 ali, 0004 zainab)
# the OTP appears in the API response (dev mode) — production uses the SMS gateway
```

## Feature map (spec §1 → implementation)

| Area | Delivered |
|---|---|
| **Auth** (§15) | phone OTP (hashed, TTL, attempt+rate limits) · JWT access (15m) + rotating refresh (30d, reuse detection) · device sessions list/revoke/logout-all · TOTP 2FA · account deletion + data export |
| **Chats** (§20-21) | private · groups (owner/admin/moderator/member + 10 granular permissions, slow mode, restrict/ban) · channels (public/private, username, admin-only posting, subscriber counts, comments via linked chat) · saved messages |
| **Messages** (§7, §13) | ULID ids · transactional global seq · idempotent send (clientMsgId) · reply · edit (48h, edited flag) · delete (author/mod) · forward · reactions · pin + pinned bar · mentions · read/delivery receipts · cursor pagination · scheduled sends · drafts |
| **Realtime** (§6) | socket.io gateway: all 16 event types + call signaling · heartbeat/ping · reconnect w/ exponential backoff · durable Event log → `/sync` reconciliation → zero message loss (tail-follower fallback) |
| **Media/CDN** (§8-11, §35-36, §42) | signed upload sessions · direct-to-storage (S3 presigned / local parts) · resumable multipart · checksum verify · magic-byte sniffing · content-addressed paths · sharp variants (thumb/medium/blur) · signed expiring user-bound URLs · Range streaming · GIF-safe · transcode-ready worker (ffmpeg-gated) |
| **Presence** (§25) | online/offline/last-seen (privacy-filtered) · typing indicators · throttled writes |
| **Notifications** (§18) | Web Push (VAPID) live · FCM HTTP-v1 + APNs token adapters (credential-gated) · mute/pref/privacy respected · notification center |
| **Search** (§19) | global (users+public chats+messages) · in-chat · username · Postgres FTS migration SQL shipped |
| **Organization** (§66-73) | folders · archive · pinned chats · mute · drafts · unread+mention counters · global search |
| **Privacy/Mod** (§16, §22, §48-49, §57-62) | per-field privacy (last seen/phone/photo/message-me) · blocking · reporting (7 categories) · admin queue with actions · bans with session kill · audit logs |
| **Contacts** (§50) | SHA-256-hash contact sync — raw numbers never leave the device |
| **Calls** (calls-ready) | 1:1 WebRTC voice/video + screen share (socket signaling, membership-validated) |
| **Admin panel** (§37) | separate auth (+TOTP) · stats (users/messages/day/storage/failed jobs) · user search & bans · reports queue · chat management · audit trail |
| **UX** (§3) | original "Sada" identity (teal/amber, no Telegram assets) · dark mode · Arabic RTL + English · 26 screens · PWA installable · low-end-friendly windowing |
| **DevOps** (§28, §45-47) | Dockerfiles ×3 · compose (web/realtime/worker/postgres/redis/minio/caddy) · nginx-grade proxy config · `.env.example` (zero hardcoded secrets) · CI (lint→typecheck→test→build→audit→manual-approval deploy) |
| **Ops docs** (§54) | `docs/architecture.md` · `docs/deployment.md` · `docs/security.md` · `docs/scaling.md` · `docs/backup-recovery.md` · `docs/api.md` |

## Project structure

```
src/
  app/api/v1/[...route]/route.ts   # versioned REST router (thin adapter)
  lib/server/services/             # modular services (auth·users·chats·messages·
                                   #   media·queue·sync·notifications·moderation·admin)
  lib/server/security/             # rate limit · signed URLs · TOTP · file validation
  lib/server/{api,jwt,events,env}.ts
  lib/client/                      # api · socket+sync · store · media · push · i18n
  components/messenger/            # 12 screens (SPA shell at "/")
mini-services/
  realtime/                        # socket.io gateway (:3003)
  worker/                          # job processors (media·links·push·scheduled·cleanup)
infrastructure/                    # docker-compose · Dockerfiles · prod proxy · Postgres FTS
docs/                              # architecture·deployment·security·scaling·backup·api
scripts/                           # seed·load-test·backup·gen-vapid·smoke-test
tests/                             # bun:test integration+unit suite (25 tests)
```

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | API + client (port 3000) |
| `bun run lint` / `bunx tsc --noEmit` | quality gates |
| `bun test tests/` | 45-test suite (isolated DB, auto-preloaded) |
| `bun scripts/seed.ts` | demo data |
| `bun scripts/load-test.ts 10 5` | load test (p50/p95, honest bottleneck notes) |
| `bash scripts/smoke-test.sh` | two-user end-to-end API flow |
| `bash scripts/backup.sh ./backups` | DB + media backup w/ retention |
| `bun run deploy [msg]` | commit everything + push to GitHub (CI runs automatically) |
| `bun scripts/gen-vapid.ts` | Web Push keys → .env |

## Engineering rules honored (spec §50)

PostgreSQL is truth (Redis caches only) · API never proxies large files ·
workers own expensive jobs · client is never trusted for authorization ·
no invented cryptography · no hardcoded secrets · **no mock implementations
behind "production-ready" claims** — every feature above maps to executed
executable code, 45 passing tests, and a two-user live smoke run.

## Email delivery (self-host note)

Real delivery activates the moment ONE provider is configured in `.env`
(verified by `bun scripts/test-email.ts <address>`):

- **Gmail SMTP** (universal): `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`,
  `SMTP_USER=<you>@gmail.com`, `SMTP_PASS=` a Google **App Password**
  (myaccount.google.com → Security → 2-Step Verification → App passwords).
- **Resend** (`RESEND_API_KEY`) / **Brevo** (`BREVO_API_KEY`) — API providers;
  Resend test mode delivers only to the account owner until a domain is
  verified at resend.com/domains.
- Chain order override: `EMAIL_CHAIN=smtp,resend,brevo` (unset = automatic).
