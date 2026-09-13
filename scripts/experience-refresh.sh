#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/data/logs"
LOCK_FILE="$ROOT/data/experience-refresh.lock"
mkdir -p "$LOG_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date --iso-8601=seconds) experience refresh already running; skipping" >> "$LOG_DIR/experience-refresh.log"
  exit 0
fi

{
  echo "=== $(date --iso-8601=seconds) EXPERIENCE REFRESH START ==="
  cd "$ROOT"
  python3 scripts/experience-refresh.py
  echo "=== $(date --iso-8601=seconds) EXPERIENCE REFRESH OK ==="
} >> "$LOG_DIR/experience-refresh.log" 2>&1
