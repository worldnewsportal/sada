# Security Documentation (spec §16-17, §42)

## Threat model & controls

| Threat | Control | Where |
|---|---|---|
| Credential brute force | OTP: 5-min TTL, ≤5 attempts, per-phone + per-IP rate limits; admin login rate-limited; password policy ≥12 chars mixed classes | `auth.service`, `rate-limit.ts` |
| Session theft | HttpOnly+SameSite+Secure cookies; refresh rotation with **reuse detection** (family revocation); every request revalidates the session row (revocation is instant, not token-lifetime) | `auth.service`, `api.ts` |
| Privilege escalation | Client-claimed roles are never read; permission sets resolved server-side per request (`resolvePerms(role, override, chat defaults)`); ownership checks on every mutation | `chats.service`, `messages.service` |
| SQL injection | Prisma parameterized queries only; no string-built SQL | all services |
| XSS | React escaping; no `dangerouslySetInnerHTML` in chat rendering; URLs rendered as `<a rel="noopener noreferrer">`; nosniff + frame-deny headers | client + Caddyfile |
| CSRF | SameSite=Lax cookies + JSON-only API (no form-encoded state changes); state-changing verbs require session cookie AND JSON content-type | `api.ts` |
| Malicious uploads | Server-side magic-byte sniffing (client MIME/filename ignored), per-kind size caps, filename sanitization, checksum verify, ZIP-family refinement, private bucket | `file-validation.ts`, `media.service` |
| Path traversal | Storage keys are server-generated (hash-based); filenames sanitized (`sanitizeFilename` strips paths/control chars) | `storage.ts`, `file-validation.ts` |
| Signed-URL abuse | HMAC-SHA256, user-bound, 15-min expiry, timing-safe compare; expired/tampered → 403 | `signed-url.ts` |
| Internal API abuse | service-to-service calls signed with `INTERNAL_SECRET` + 60s replay window | `signed-url.ts` |
| SSRF via link previews | loopback/private/link-local/metadata ranges blocked; http(s) only; 1 MB / 6 s caps | `link-preview.ts` |
| Spam/abuse | per-route rate tables (send 25/10s, uploads 60/min, username 5/day, reports 20/h), slow-mode per chat, group bans | `constants.ts` |
| Data exposure on deletion | deletion job: session revocation, membership wipe, message tombstones, profile anonymization, audit entry | `account-delete.ts` |

## Secrets handling (spec §14, §45)

- All secrets via environment; **zero hardcoded credentials** in the repo.
- Dev secrets auto-generate once (JWT/INTERNAL/APP_PEPPER) and persist to local `.env` (git-ignored); `.env.example` documents every key.
- Media access uses capability URLs — object-storage credentials never reach any client.

## Encryption posture (honest — spec §17)

- **In transit:** TLS 1.2+ (Caddy auto-HTTPS), HSTS preload header.
- **At rest:** disk/volume encryption (deployment-level), private buckets, ACLs.
- **Not E2EE:** ordinary chats are cloud chats. We do **not** label them end-to-end encrypted. The secret-chat design (reserved `devicesToken` column + future Signal-style double-ratchet using audited primitives) is documented in the roadmap; no custom crypto exists anywhere in this codebase — HMAC/TOTP/SHA-256/AES all come from platform libraries.

## Audit trail

`AuditLog` records: logins (success/failure), OTP requests, 2FA changes, blocks, chat creation/deletion, role changes, bans, message deletions by moderators, report resolutions, admin logins and every admin action — each with actor, target, IP and timestamp, exposed via the admin panel.
