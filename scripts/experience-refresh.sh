#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/data/logs"
LOCK_FILE="$ROOT/data/experience-refresh.lock"
STATUS_FILE=""
ARGS=()
mkdir -p "$LOG_DIR"

while (($#)); do
  case "$1" in
    --status-file)
      STATUS_FILE="${2:-}"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

write_status() {
  [[ -z "$STATUS_FILE" ]] && return 0
  local state="$1" progress="$2" message="$3"
  python3 - "$STATUS_FILE" "$state" "$progress" "$message" <<'PY'
import json, os, sys
from datetime import datetime
path, state, progress, message = sys.argv[1:]
payload = {"state": state, "progress": int(progress), "message": message, "updated_at": datetime.now().astimezone().isoformat(timespec="seconds")}
if os.path.exists(path):
    try:
        old = json.load(open(path, encoding="utf-8"))
        if old.get("started_at"):
            payload["started_at"] = old["started_at"]
    except Exception:
        pass
if state == "running" and "started_at" not in payload:
    payload["started_at"] = payload["updated_at"]
if state in {"done", "error"}:
    payload["finished_at"] = payload["updated_at"]
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY
}

export OPENAI_DISCOVERY_WORKERS="${OPENAI_DISCOVERY_WORKERS:-3}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date --iso-8601=seconds) experience refresh already running; skipping" >> "$LOG_DIR/experience-refresh.log"
  write_status running 5 "En opdatering kører allerede"
  exit 0
fi

trap 'rc=$?; if ((rc != 0)); then write_status error 100 "Opdateringen fejlede – se loggen"; fi' EXIT
write_status running 8 "Starter søgning efter oplevelser"

{
  echo "=== $(date --iso-8601=seconds) EXPERIENCE REFRESH START ==="
  echo "args: ${ARGS[*]:-<default>}"
  echo "workers: $OPENAI_DISCOVERY_WORKERS"
  cd "$ROOT"
  write_status running 20 "Søger og verificerer familieoplevelser på nettet"
  python3 scripts/experience-refresh.py "${ARGS[@]}"
  write_status running 92 "Gemmer, rydder dubletter og opdaterer SmartDash"
  echo "=== $(date --iso-8601=seconds) EXPERIENCE REFRESH OK ==="
} >> "$LOG_DIR/experience-refresh.log" 2>&1

write_status done 100 "Oplevelser er opdateret"
trap - EXIT
