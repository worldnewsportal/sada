#!/usr/bin/env bash
# ── Sada صدى — one-command auto-publish to GitHub ─────────────────────────────
# Usage:  bun run deploy            → commit all changes + push to origin/main
#         bun run deploy "message"  → same, with a custom commit message
# Requires: remote "origin" already configured (token embedded locally in .git/config)
set -euo pipefail
cd "$(dirname "$0")/.."

git add -A

if git diff --cached --quiet; then
  echo "✔ Nothing new to publish — working tree clean."
else
  MSG="${1:-auto-publish: $(date '+%Y-%m-%d %H:%M')}"
  git commit --quiet -m "$MSG"
  echo "✔ Committed: $MSG"
fi

git push origin main
echo "✔ Published → https://github.com/worldnewsportal/sada"
echo "  CI will now run: lint → typecheck → tests → build → docker"
