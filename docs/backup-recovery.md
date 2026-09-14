# Backup & Disaster Recovery (spec §41)

## What is backed up

| Data | Method | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | `pg_dump -Fc` + WAL archiving (PITR) | nightly full; continuous WAL | 7 daily / 4 weekly / 3 monthly |
| SQLite (dev) | `sqlite3 .backup` + WAL checkpoint | nightly | same |
| Media store | `rsync --link-dest` incremental (content-addressed = immutable → hardlink-efficient) | nightly | same |
| Config/secrets | `.env` (operator-managed vault; **not** in backups) | on change | — |

Script: `scripts/backup.sh <backup_root>` (cron: `0 3 * * *`). It writes
`<ts>/db.dump|db.sqlite + media/ + manifest.txt`, then prunes old sets.

## Point-in-time recovery (production)

1. Enable `archive_mode=on`, `archive_command='test ! -f /wal/%f && cp %p /wal/%f'`.
2. PITR = restore base backup + replay WAL to `recovery_target_time`.
3. Object storage: versioning ON for the media bucket; lifecycle rules expire noncurrent versions after 90 days; replication to a second region for redundancy.

## Recovery objectives

- **RPO:** ≤ 5 minutes (WEL archive shipping)
- **RTO:** ≤ 30 minutes (restore dump → `prisma migrate deploy` → start services; media re-rsync continues in background — chat history is authoritative in the DB, blobs backfill)
- **Consistency note:** messages reference media by content hash; after a media-bucket restore, any missing blob re-fetches as 404 in UI with a retry state — never a crash (spec §30).

## Disaster scenarios

| Scenario | Procedure |
|---|---|
| Accidental user deletion | PITR to pre-delete timestamp on a scratch instance → export + re-import user data |
| Corrupt media blob | checksum mismatch detected on read → re-upload by sender, or drop variant (original remains) |
| DB host loss | promote replica / PITR restore; sessions survive (hashed) — devices transparently refresh |
| Full region loss | restore to second region from replicated backups + bucket replication |
| Worker queue backlog | jobs persist in `Job` table; workers are stateless — restart replays with exponential backoff |

Verification: monthly restore drill — `bun test tests/` against a restored
snapshot must pass, plus a manual two-user message round-trip on the restored
instance.
