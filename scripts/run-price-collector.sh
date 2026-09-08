#!/bin/sh
set -eu

BASE="/mnt/APPS_NEW/SmartDash/config/www"
LOG_DIR="$BASE/data/logs"
LOG_FILE="$LOG_DIR/price-collector.log"

mkdir -p "$LOG_DIR"

{
    echo
    echo "============================================================"
    echo "START $(date -Iseconds)"
    cd "$BASE"
    /usr/bin/python3 scripts/price-collector.py --write
    echo "END   $(date -Iseconds)"
} >> "$LOG_FILE" 2>&1
