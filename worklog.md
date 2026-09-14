# Worklog — Sada Messenger (صدى)

---
Task ID: 1
Agent: Super Z (main)
Task: Execute messenger_app_prompt(2).txt verbatim — build production-grade messenger platform (83 features, 15 engineering rules, phased order, no-demo policy)

Work Log:
- Phase 0: Read spec (1796 lines). Architecture decision: mobile-first PWA + versioned REST/WS API (documented stack adaptation, spec §56 rule). Installed socket.io, jose, bcryptjs, web-push, qrcode, qrcode.react.
- Phase 1: Full Prisma schema — 25 models (users, sessions, otp, chats, chat_members, channel_members, messages, reactions, attachments, pinned, media, upload_sessions, blocks, contacts, invites, join_requests, settings, privacy, drafts, folders, notifications, push_subs, reports, audit, admins, events, jobs, link_previews) + db:push.
- Phase 2: Core libs — ULID (monotonic), ApiError envelope, structured logger, env/secrets manager (auto-gen persisted), TOTP RFC-6238, HMAC signed URLs (user-bound, expiring, replay-protected internal HMAC), sliding-window rate limiter (Redis-swap interface), magic-byte file validation + filename sanitizer, bcrypt admin passwords.
- Phase 3-6: Services — auth (OTP hashed+salted, refresh rotation w/ reuse detection, sessions, 2FA setup/enable/disable, account deletion scheduling), users (profiles, username rules, privacy projection, blocks, hash-based contact sync, search, settings, export), chats (private/group/channel/saved, granular permission sets, invites+QR codes, join requests, folders, pins, archive, mute, read state, drafts, slow mode), messages (idempotent send, edit 48h, delete, forward, reactions, receipts via denormalized lastReadSeq, cursor pagination, scheduled sends, search), media (upload sessions → direct PUT → checksum+sniff → content-addressed storage → sharp variants via worker; signed serving w/ Range), sync (durable Event log), notifications (Web Push VAPID + FCM HTTP-v1 adapter + prefs), moderation (reports), admin (separate auth, stats, bans, reports queue, audit).
- API v1: single catch-all router (request-id, auth ctx, zod validation, consistent errors, rate limits) — 87 paths / 102 operations.
- Phase 7: Realtime mini-service (port 3003) — socket.io, JWT socket tokens, chat/user rooms, presence map w/ throttled last-seen, typing relay, delivery receipts, call signaling relay (membership-validated), HMAC internal emit + 4s Event-table tail-follower (zero message loss), health endpoint.
- Phase 8: Worker mini-service — DB-backed job queue (claim/complete/fail w/ backoff, dedupe keys): media.process (sharp thumbs/medium/blur), media.transcode (ffmpeg capability-gated, honest skip), link.preview (SSRF-guarded OG parser), push.send, scheduled.send, cleanup (jobs/uploads/events retention), account.delete handler.
- Phase 9: Web Push VAPID live + FCM/APNs credential-gated adapters; sync protocol (per-device cursor, scoped events, leak-proof).
- Phase 10: Client — SPA shell at "/" (26 screens): auth (phone→OTP→2FA→profile), chat list (folders/archive/pins/unread/mentions/search), chat view (bubbles w/ all states, reply/edit/reactions/pin, voice recorder w/ WebAudio peaks, stickers, schedule, attachments w/ progress, typing, pinned bar, read markers), group/channel info (members/roles/invites/QR/join-requests/slow-mode), contacts (hash sync), global search, settings (privacy/notifications/devices/storage/blocked/2FA/language/theme/delete/export), media viewer, admin panel (login/stats/users/bans/reports/chats/audit), WebRTC call overlay (voice/video/screen-share). Arabic RTL default + English. Original Sada brand (teal/amber), PWA manifest + service worker (offline shell + push), icons.
- Phase 13: seed.ts (4 users + group + channel), smoke-test.sh (two-user live API flow — ALL PASS incl. idempotency, block enforcement, sync), load-test.ts (p50/p95 + honest bottleneck notes), 25 bun:test integration+unit tests — 25/25 PASS (isolated test DB via bunfig preload).
- Phase 14: Dockerfiles ×3, docker-compose (web×2/realtime/worker×2/postgres/redis/minio+init/caddy), Caddyfile.prod (TLS/WS/media cache/security headers), Postgres FTS migration SQL, GitHub Actions CI (lint→tsc→prisma→tests→build→audit→manual-approval deploy), backup.sh (bun:sqlite fallback verified, 540KB snapshot), gen-vapid.ts, gen-openapi.ts (87 paths documented), .env.example, README, docs/ (architecture, deployment, security, scaling, backup-recovery, api).
- Verification: bunx tsc --noEmit CLEAN, bun run lint CLEAN, OTP auth flow verified via curl, two-user messaging smoke passed, realtime health OK, worker processed cleanup job, backup restored file verified.

Stage Summary:
- Deliverable: full monorepo (src/ + mini-services/ + infrastructure/ + docs/ + scripts/ + tests/)
- Key decisions: PWA client over unverifiable Flutter; SQLite dev + Postgres prod schema; DB-backed queue (Redis-ready); denormalized receipts (O(1) group read counts); global seq allocator (transactional); content-addressed media; durable event log as sync backbone; dev OTP echo (auto-disabled in production)
- All spec §53 quality-check items addressed in docs/architecture.md §10 + README feature map

---
Task ID: 2
Agent: Super Z (main)
Task: Continue from previous session stop point — fix ChatRow "getSnapshot should be cached" infinite loop (Zustand v5 + React 19) and re-run mandatory browser verification (user provided screenshot of prior session context)

Work Log:
- Diagnosed via browser automation (agent-browser): extracted exact error from Next.js dev overlay — "The result of getSnapshot should be cached to avoid an infinite loop" at chat-list.tsx:166 ChatRow `useStore((s) => s.onlineUsers)`.
- Root cause: zustand `set()` with object partial ALWAYS creates a new state object and notifies all listeners, even for semantically identical values. `setOnline`/`setTyping` recreated Set/Record on every redundant presence/typing event; connect-time event bursts (presence + receipts + sync) churned `onlineUsers` identity mid-render → React 19 useSyncExternalStore detected unstable getSnapshot → infinite loop → Fast Refresh full reload (matched dev.log warnings).
- Patch 1 (store.ts): no-op guards returning same state object (`return s`) in setOnline, setTyping, setConnectionState, setLoadingMessages, setChatsLoading, setHasMore, setUnreadNotifications — zustand's Object.is check now skips notification on redundant writes.
- Patch 2 (chat-list.tsx ChatRow): replaced container selectors with primitive-returning selectors (`selectPeerOnline` → boolean via Set.has, `selectIsTyping` → boolean scan); removed unused `me` + EMPTY_TYPING.
- Patch 3 (chat-view.tsx): same primitive-selector treatment — `anyTyping` boolean selector (replaces typingMap + typingNames), `peerOnline` boolean; updated effect deps + JSX; removed unused EMPTY_TYPING/me.
- Fixed scripts/load-test.ts TS error (chatId made optional in sessions array type — assigned later in phase 2).
- Fixed tests/main.test.ts lint error (require("crypto") → ESM createHmac import).
- Mandatory browser verification PASSED: loaded app (cleared stale PWA service-worker cache first), chat list renders (فريق صدى / أخبار صدى / Saved Messages), opened group chat, sent real message "مرحباً! هذه رسالة اختبار بعد إصلاح خطأ getSnapshot ✅" → bubble appeared, MESSAGE_READ/DELIVERED receipts flowed via /sync, chat-list preview updated LIVE ("now أحمد: …") with ZERO getSnapshot errors after 8s under realtime event pressure.
- Final gates: tsc --noEmit CLEAN, eslint CLEAN, bun test 25/25 PASS.
- Evidence screenshot: download/sada-verification-chat.png

Stage Summary:
- ChatRow infinite-loop bug FIXED and verified end-to-end in a real browser as a real user.
- Rule established for the codebase: Zustand v5 + React 19 selectors must return primitives or stable store references; ephemeral mutators (presence/typing/connection) must no-op on redundant writes.
- Services running: web :3000 (200), realtime :3003 /internal/health {"ok":true}, DB seeded (4 users + group + channel + extras).
