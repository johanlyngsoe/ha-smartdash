#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/data"
REQUEST_FILE="$DATA_DIR/experience-refresh-request.json"
STATUS_FILE="$DATA_DIR/experience-refresh-status.json"
WORKER_LOCK="$DATA_DIR/experience-refresh-worker.lock"
mkdir -p "$DATA_DIR"

exec 8>"$WORKER_LOCK"
if ! flock -n 8; then
  exit 0
fi

[[ -f "$REQUEST_FILE" ]] || exit 0

read_request() {
  python3 - "$REQUEST_FILE" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
mode = data.get("mode", "quick")
days = data.get("days", 14)
if mode not in {"quick", "full"}:
    mode = "quick"
try:
    days = int(days)
except Exception:
    days = 14
days = max(7, min(90, days))
print(mode)
print(days)
PY
}

mapfile -t REQUEST < <(read_request)
MODE="${REQUEST[0]:-quick}"
DAYS="${REQUEST[1]:-14}"

# Claim the request before starting so repeated worker invocations do not re-run it.
CLAIM_FILE="$REQUEST_FILE.running"
mv "$REQUEST_FILE" "$CLAIM_FILE"

cleanup() {
  rm -f "$CLAIM_FILE"
}
trap cleanup EXIT

cd "$ROOT"
/usr/bin/bash scripts/experience-refresh.sh --days "$DAYS" --status-file "$STATUS_FILE"
