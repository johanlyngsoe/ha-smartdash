#!/usr/bin/env python3

"""Persistent SQLite store for SmartDash family experiences.

Future events are retained when a later discovery run misses them. Only events whose
known end date is in the past are retired automatically.
"""

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DEFAULT_DB = DATA_DIR / "experiences.db"
DEFAULT_INPUT = DATA_DIR / "experiences-enriched.json"
DEFAULT_EXPORT = DATA_DIR / "experiences-enriched.json"

SCHEMA = """
CREATE TABLE IF NOT EXISTS refresh_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    period_from TEXT,
    period_to TEXT,
    provider TEXT,
    model TEXT,
    incoming_count INTEGER NOT NULL DEFAULT 0,
    stored_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS experiences (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start TEXT,
    end TEXT,
    venue TEXT,
    city TEXT,
    source TEXT,
    source_url TEXT,
    family_fit_score REAL,
    value_score REAL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_refresh_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT NOT NULL,
    FOREIGN KEY(last_refresh_id) REFERENCES refresh_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_experiences_start ON experiences(start);
CREATE INDEX IF NOT EXISTS idx_experiences_active ON experiences(active);
CREATE INDEX IF NOT EXISTS idx_experiences_score ON experiences(family_fit_score DESC);
"""


def now_iso():
    return datetime.now().astimezone().isoformat()


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"Mangler fil: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Ugyldig JSON i {path}: {exc}") from exc


def normalize_text(value):
    value = str(value or "").casefold().strip()
    value = re.sub(r"[^a-z0-9æøå]+", " ", value)
    return " ".join(value.split())


def canonical_url(value):
    if not value:
        return ""
    try:
        parts = urlsplit(str(value).strip())
    except ValueError:
        return str(value).strip().casefold().rstrip("/")
    return urlunsplit((parts.scheme.casefold(), parts.netloc.casefold(), parts.path.rstrip("/"), "", ""))


def event_id(item):
    key = "|".join([
        canonical_url(item.get("source_url")),
        str(item.get("start") or "")[:10],
        normalize_text(item.get("title")),
        normalize_text(item.get("city")),
    ])
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]


def connect(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def nested_number(item, *parts):
    value = item
    for part in parts:
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def begin_refresh(conn, payload):
    request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    period = request.get("period") if isinstance(request.get("period"), dict) else {}
    cursor = conn.execute(
        """INSERT INTO refresh_runs(started_at, period_from, period_to, provider, model, incoming_count)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            now_iso(), period.get("from"), period.get("to"), payload.get("provider"),
            payload.get("model"), len(payload.get("results") or []),
        ),
    )
    return cursor.lastrowid


def upsert_payload(conn, payload, today=None):
    results = payload.get("results")
    if not isinstance(results, list):
        raise RuntimeError("Payload mangler results-listen")
    today = today or date.today()
    refresh_id = begin_refresh(conn, payload)
    timestamp = now_iso()

    for item in results:
        if not isinstance(item, dict) or not item.get("title"):
            continue
        identifier = event_id(item)
        conn.execute(
            """INSERT INTO experiences(
                   id, title, start, end, venue, city, source, source_url,
                   family_fit_score, value_score, first_seen_at, last_seen_at,
                   last_refresh_id, active, payload_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
               ON CONFLICT(id) DO UPDATE SET
                   title=excluded.title, start=excluded.start, end=excluded.end,
                   venue=excluded.venue, city=excluded.city, source=excluded.source,
                   source_url=excluded.source_url,
                   family_fit_score=excluded.family_fit_score,
                   value_score=excluded.value_score,
                   last_seen_at=excluded.last_seen_at,
                   last_refresh_id=excluded.last_refresh_id,
                   active=1, payload_json=excluded.payload_json""",
            (
                identifier, item.get("title"), item.get("start"), item.get("end"),
                item.get("venue"), item.get("city"), item.get("source"), item.get("source_url"),
                nested_number(item, "family_fit", "score"), nested_number(item, "value", "score"),
                timestamp, timestamp, refresh_id,
                json.dumps(item, ensure_ascii=False, separators=(",", ":")),
            ),
        )

    # Missing future events are deliberately retained. Web discovery is probabilistic.
    conn.execute(
        """UPDATE experiences SET active=0
           WHERE active=1
             AND substr(COALESCE(NULLIF(end, ''), start), 1, 10) <> ''
             AND substr(COALESCE(NULLIF(end, ''), start), 1, 10) < ?""",
        (today.isoformat(),),
    )
    stored_count = conn.execute("SELECT COUNT(*) FROM experiences WHERE active=1").fetchone()[0]
    conn.execute(
        "UPDATE refresh_runs SET completed_at=?, stored_count=?, status='ok' WHERE id=?",
        (now_iso(), stored_count, refresh_id),
    )
    conn.commit()
    return refresh_id, stored_count


def current_items(conn, today=None):
    today = today or date.today()
    rows = conn.execute(
        """SELECT payload_json FROM experiences
           WHERE active=1
             AND (
                 substr(COALESCE(NULLIF(end, ''), start), 1, 10) = ''
                 OR substr(COALESCE(NULLIF(end, ''), start), 1, 10) >= ?
             )
           ORDER BY COALESCE(family_fit_score, 0) DESC,
                    COALESCE(value_score, -1) DESC,
                    start ASC""",
        (today.isoformat(),),
    ).fetchall()
    output = []
    for row in rows:
        try:
            output.append(json.loads(row["payload_json"]))
        except json.JSONDecodeError:
            continue
    return output


def export_snapshot(conn, template_payload, path):
    output = dict(template_payload)
    output["results"] = current_items(conn)
    output["store"] = {
        "type": "sqlite",
        "database": "data/experiences.db",
        "exported_at": now_iso(),
        "active_count": len(output["results"]),
        "retention": "future events remain until their known end date even if a later discovery run misses them",
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def self_test():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    base = {
        "generated_at": "2026-09-13T20:00:00+02:00",
        "request": {"period": {"from": "2026-09-19", "to": "2026-09-20"}},
        "provider": "test",
        "model": "test",
        "results": [
            {"title": "Flødebolleskole", "start": "2026-09-20T10:00:00+02:00", "end": "2026-09-20T12:00:00+02:00", "city": "Silkeborg", "source_url": "https://example.dk/floedebolle", "family_fit": {"score": 90}},
            {"title": "Skraldival", "start": "2026-09-19T10:00:00+02:00", "end": "2026-09-19T14:00:00+02:00", "city": "Silkeborg", "source_url": "https://example.dk/skraldival", "family_fit": {"score": 93}},
        ],
    }
    upsert_payload(conn, base, today=date(2026, 9, 13))
    second = dict(base)
    second["results"] = [base["results"][1]]
    upsert_payload(conn, second, today=date(2026, 9, 13))
    titles = [item["title"] for item in current_items(conn, today=date(2026, 9, 13))]
    assert "Flødebolleskole" in titles
    upsert_payload(conn, second, today=date(2026, 9, 21))
    titles = [item["title"] for item in current_items(conn, today=date(2026, 9, 21))]
    assert "Flødebolleskole" not in titles
    print("EXPERIENCE STORE SELF-TEST OK")
    print("future event survives a later miss; past event retires by end date")


def main():
    parser = argparse.ArgumentParser(description="Persist enriched experiences in SQLite")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--export", type=Path, default=DEFAULT_EXPORT)
    parser.add_argument("--write", action="store_true", help="Write SQLite store and consolidated JSON snapshot")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0

    payload = load_json(args.input)
    conn = connect(args.db)
    if not args.write:
        print(json.dumps({"active_count": len(current_items(conn)), "database": str(args.db)}, ensure_ascii=False, indent=2))
        return 0

    refresh_id, stored_count = upsert_payload(conn, payload)
    output = export_snapshot(conn, payload, args.export)
    print(json.dumps({
        "refresh_id": refresh_id,
        "incoming_count": len(payload.get("results") or []),
        "active_count": stored_count,
        "exported_count": len(output.get("results") or []),
        "database": str(args.db),
        "snapshot": str(args.export),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, sqlite3.Error, AssertionError) as exc:
        print(f"FEJL: {exc}", file=sys.stderr)
        sys.exit(1)
