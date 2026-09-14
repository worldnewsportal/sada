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

---
Task ID: 3
Agent: Super Z (main)
Task: Fix "Cannot read properties of undefined (reading 'devCode')" on registration (user screenshot +999502222222) — stale PWA cache serving old client; harden dual registration (test +999 / real SMS) end-to-end

Work Log:
- User screenshot showed raw TypeError at auth request-otp despite backend returning correct envelope (verified via live curl: {"ok":true,"data":{...,delivery:"test",devCode}} — backend/OTP dual-mode code was already correct).
- ROOT CAUSE: public/sw.js v1 was CACHE-FIRST for all same-origin GETs including the app document "/" → devices that loaded the app before a deploy keep booting the stale HTML + stale JS chunks forever (old client read an older response shape → TypeError). Same class of issue as the Task-2 stale-SW incident, now fixed structurally.
- Fix 1 (public/sw.js → v2 "sada-shell-v2"): navigations now NETWORK-FIRST (cache "/" only as offline fallback); other same-origin GETs network-first with cache fallback; /api/* network-only with offline JSON envelope. Old cache name deleted on activate.
- Fix 2 (src/lib/client/push.ts): auto-reload ONCE on service worker controllerchange (sessionStorage-guarded against loops) + reg.update() on boot → devices recover from stale bundles without manual action.
- Fix 3 (auth-screen.tsx + i18n): defensive response-shape guards in requestOtp/verifyOtp/afterLogin → friendly localized t.badResponse error instead of raw TypeError; added badResponse key to ar+en dictionaries.
- Bonus bug found during security probing: invalid phone ("abc") returned 500 INTERNAL with stack in log — ZodError from route-level .parse() was unhandled. Fixed centrally in src/lib/server/api.ts catch: ZodError → 400 VALIDATION_ERROR (applies to all 87 routes).
- Browser verification (agent-browser, real flows): Flow A +999509999001 → OTP shown in-app → verify → profile setup (testdemo1) → chats ✅. Flow B +9647701122334 (real format, dev-echo delivery) → verify → profile (realuser1) → chats ✅. Re-tested user's exact number +999502222222 → OTP step → verify → logged in ✅. Zero console/page errors.
- Security probes via curl: wrong codes rejected ("Incorrect code", attempts++), correct code still accepted within cap, immediate resend → 429 RATE_LIMITED retryAfterS:42 (45s cooldown), hourly per-phone ceiling 10, invalid phone → 400 VALIDATION_ERROR.
- Gates: tsc --noEmit CLEAN, eslint CLEAN, bun test 25/25 PASS.
- Evidence: download/sada-test-number-flow-fixed.png

Stage Summary:
- Registration is dual-mode and fully working: test numbers "+999…" = instant in-app code (no SMS, never hits a provider, production-gated by ALLOW_TEST_PHONES); real numbers = pluggable SMS (Twilio / generic HTTP gateway; dev-echo fallback in non-production, auto-disabled in production, code never in response when a real provider sends).
- OTP hardening confirmed live: hashed+salted codes, 5-min TTL, 5-attempt cap, 45s resend cooldown, 10/hour ceiling, per-phone + per-IP rate limits, audit events.
- Devices stuck on stale PWA bundles now self-heal (SW v2 network-first + one-time auto-reload). Users with the old cache need ONE manual refresh to escape v1; from then on updates apply automatically.
- Rule added: never cache-first the app document in the service worker; client must defensively validate API response shapes at auth boundaries.

---
Task ID: 4
Agent: Super Z (main)
Task: Add real, secure email registration + multi-option login (phone/email × activation code/password) per user request

Work Log:
- Schema: User.phone/phoneHash → nullable (email-only accounts), +emailVerifiedAt, +passwordHash (bcrypt 12), +passwordFailCount/passwordLockedUntil (DB-backed lockout); new EmailOtp model (hashed code + salt, attempts, pendingPasswordHash, TTL index). db:push on dev + test DBs.
- src/lib/server/security/email.ts: EmailProvider layer — SMTP via nodemailer (real delivery: Brevo/SendGrid/Gmail/any SMTP; TLS auto by port, timeouts, no error-body leakage), console dev fallback, none→clear error; bilingual (AR-RTL + EN) welcome/activation HTML+text template with 10-min code.
- env.ts: SMTP_HOST/PORT/USER/PASS/SECURE, EMAIL_FROM, EMAIL_RESEND_COOLDOWN_S(60), EMAIL_MAX_PER_HOUR(10), PASSWORD_LOCK_ATTEMPTS(5), PASSWORD_LOCK_MINUTES(15). .env.example documents provider setup + SPF/DKIM note.
- auth.service: requestEmailOtp (signup/login unified — new email gets welcome+activation, known email gets sign-in code; response never reveals existence; optional signup password policy-checked THEN hashed and stored pending INSIDE the OTP row, applied only after activation), verifyEmailOtp (creates email-only user, emailVerifiedAt, applies pending password), loginPassword (identifier = email OR phone; uniform "Incorrect credentials"; lockout after 5 fails → 15 min incl. correct password), setPassword (set/change with current-password check), normalizeEmail.
- password.ts: validateUserPassword (min 8, letters+digits, common-password denylist) — admin policy unchanged (stronger).
- Routes: POST auth/request-email-otp, auth/verify-email-otp (sets session cookies), auth/login-password, GET/POST users/me/password (hasPassword + set/change); users/me now returns email; AuthContext.user + email + nullable phone; rate-limit table +3 named entries.
- Client: auth-screen rebuilt with 📱هاتف/✉️بريد tabs; email tab = إنشاء حساب (optional password + policy hint + "activation code + welcome" note) | تسجيل دخول (رمز التفعيل | كلمة المرور); OTP step shared with new ✉️ email-delivered note; settings-screen: new "كلمة مرور الدخول" section (set/change with current-password); profile card falls back username→phone→email; i18n ar+en ~20 new keys (dedup with existing `password` key).
- Fixed test infra: tests/setup.ts now sets OTP_DEV_ECHO=true (tests read devCode; prod never loads this file); pushed new schema to isolated test.db.
- Tests +3 (28/28 PASS): signup→activation→pending-password applied→password login; 5-fail lockout blocks even correct password→unlock→success; login-by-code does not duplicate accounts (isNew=false for existing).
- Browser verification (agent-browser, real flows): email signup demo.user@example.com + password → OTP step (welcome email code 900247 logged server-side) → activate → profile → in-app ✅; logout → login by email+password → in-app ✅; logout → login by email code → in-app ✅; settings password section renders change form ✅; phone regression via curl ✅; zero page errors.
- Gates: tsc --noEmit CLEAN, eslint CLEAN, bun test 28/28 PASS. Evidence: download/sada-email-signup-otp.png, sada-email-registered-in-app.png, sada-settings-password.png.

Stage Summary:
- Email auth is production-ready: real SMTP delivery the moment SMTP_* is set (Brevo/Gmail/SendGrid/any), dev-echo fallback auto-disabled in production, codes hashed+salted 10-min TTL 5 attempts, 60s resend cooldown + 10/hour cap per email, brute-force lockout 5→15min (DB-backed, survives restarts), uniform errors (no enumeration), pending signup password never stored plaintext.
- Login matrix now: phone+SMS/test-code, email+code, email/phone+password, 2FA on top — all sharing issueSession (sessions/2FA/audit unchanged).
- Rule: signup passwords live as pendingPasswordHash inside the EmailOtp row until activation; never on the user before verify.

---
Task ID: 5
Agent: main (Super Z)
Task: "ما المشكلة و الحل" — screenshot showed "Email delivery is not configured" on email signup (ghkv04885@gmail.com)

Work Log:
- Diagnosis: probed local :3000 (dev server) — request-email-otp works (devCode returned, logged in dev.log 17:23Z); user's screenshot domain 7zbgta1-d.space-z.ai resolves to external ALB and NOW returns HTTP 410 Gone → user was on a STALE previous-session preview running NODE_ENV=production with zero email config; that instance's hard-fail message is by-design (production must never silently fake mail).
- Root cause #2: even the current app has NO real email provider credentials — .env has only DB/JWT secrets. Real delivery requires user-supplied provider credentials (fundamental to email: unauthenticated send = spam-rejected).
- email.ts rewritten: resolution order resend → brevo → smtp → console(dev) → none(prod); added ResendApiProvider + BrevoApiProvider (pure fetch, 15s timeout, no key leakage); SmtpEmailProvider returns SentMessageInfo (diagnostics) + effectiveFrom auto-fix (Gmail rewrites mismatched From; placeholder domains → authenticated user); bilingual AR+EN not-configured + send-failure messages; resolveEmailProviderName() pure status helper; boot warn log when prod+none.
- env.ts: RESEND_API_KEY/BREVO_API_KEY getters + envFileGet() — cached .env-file fallback (quote-stripped) for ALL email vars so standalone deployments read project .env even when shell env is empty (process env always wins).
- scripts/test-email.ts: --status | --ethereal | real-send-to-address CLI.
- VERIFICATION (the "تأكد جيدا"): Ethereal end-to-end — created REAL SMTP account, sent through THIS app's SmtpEmailProvider → server "250 Accepted MSGID=aqguS1…"; fetched received mail page → contains "أهلاً بك في صدى" + "activation code: 155962". Preview: https://ethereal.email/message/aqguS1.qZeQKZiIXaqguT2BC2Znvdz2hAAAAAR1Thgo.gYoXXNhUKCTNE7k
- tests +7 new (35/35 PASS): provider env matrix (order, partial-config false-positive guard, prod none, dev console), bilingual template checks.
- .env.example §EMAIL rewritten: Options A/B/C (Resend / Brevo 300-day-free / SMTP-Gmail-app-password) with exact click paths + self-check command.
- Gates: tsc CLEAN, eslint CLEAN, bun test 35/35; live API regression 200 (devCode path); standalone rebuilt 17:28 (new code baked); prod-mode simulation: no-config→none, with-smtp→smtp real=true.

Stage Summary:
- Nothing was "broken" in the app: the screenshot came from a DEAD old preview link (410) + missing provider credentials. Feature verified working locally end-to-end.
- Real email activates the moment user adds ONE of: RESEND_API_KEY / BREVO_API_KEY / SMTP(Gmail app password) to .env — then `bun scripts/test-email.ts <addr>` proves it, rebuild + restart applies it.
- Rule: never tell the user "email works" without a provider-accepted message as evidence (250 Accepted / provider API 2xx).
