#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/data/logs"
LOCK_FILE="$ROOT/data/experience-refresh.lock"
mkdir -p "$LOG_DIR"

# Keep the same total discovery coverage, but avoid bursting every segment at once.
# This materially reduces TPM spikes and 429s without lowering model quality.
export OPENAI_DISCOVERY_WORKERS="${OPENAI_DISCOVERY_WORKERS:-3}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date --iso-8601=seconds) experience refresh already running; skipping" >> "$LOG_DIR/experience-refresh.log"
  exit 0
fi

{
  echo "=== $(date --iso-8601=seconds) EXPERIENCE REFRESH START ==="
  echo "args: ${*:-<default>}"
  echo "workers: $OPENAI_DISCOVERY_WORKERS"
  cd "$ROOT"
  python3 scripts/experience-refresh.py "$@"
  echo "=== $(date --iso-8601=seconds) EXPERIENCE REFRESH OK ==="
} >> "$LOG_DIR/experience-refresh.log" 2>&1
