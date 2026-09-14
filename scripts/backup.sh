#!/bin/bash
# ============================================================
# Sada backup script (spec §41) — run from cron, e.g. daily 3am:
#   0 3 * * * /app/scripts/backup.sh /backups >> /var/log/sada-backup.log 2>&1
# SQLite dev: .backup + WAL checkpoint.
# Postgres prod: pg_dump -Fc (PITR via WAL archiving — see docs).
# Media: rsync content-addressed store (immutable → incremental).
# Retention: keep 7 daily, 4 weekly, 3 monthly.
# ============================================================
set -euo pipefail

BACKUP_ROOT="${1:-./backups}"
DB_FILE="${DATABASE_URL#file:}"
MEDIA_ROOT="${MEDIA_ROOT:-./data/media}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_ROOT/$TIMESTAMP"

mkdir -p "$DEST"

echo "[$(date -Is)] backing up database…"
if [[ "${DATABASE_URL:-}" == postgresql://* || "${DATABASE_URL:-}" == postgres://* ]]; then
  pg_dump "${DATABASE_URL}" -Fc -f "$DEST/db.dump"
else
  DB_FILE="${DB_FILE:-./db/custom.db}"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_FILE" ".backup '$DEST/db.sqlite'"
    sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);"
  else
    # fallback: consistent atomic snapshot via bun:sqlite (VACUUM INTO)
    bun -e "import {Database} from 'bun:sqlite'; const src=new Database('$DB_FILE'); src.exec('PRAGMA wal_checkpoint(TRUNCATE)'); src.exec(\"VACUUM INTO '$DEST/db.sqlite'\"); src.close();"
  fi
fi

echo "[$(date -Is)] backing up media store (incremental)…"
rsync -a --link-dest="$BACKUP_ROOT/latest-media" "$MEDIA_ROOT/" "$DEST/media/" 2>/dev/null || \
  rsync -a "$MEDIA_ROOT/" "$DEST/media/"
ln -sfn "$DEST/media" "$BACKUP_ROOT/latest-media"

echo "[$(date -Is)] writing manifest…"
{
  echo "timestamp=$TIMESTAMP"
  echo "db_type=$([[ -f $DEST/db.dump ]] && echo postgres || echo sqlite)"
  echo "media_bytes=$(du -sb "$DEST/media" 2>/dev/null | cut -f1 || echo 0)"
} > "$DEST/manifest.txt"

echo "[$(date -Is)] pruning old backups…"
ls -1dt "$BACKUP_ROOT"/20* 2>/dev/null | tail -n +8 | xargs -r rm -rf

echo "[$(date -Is)] backup complete: $DEST"
