#!/usr/bin/env python3

"""Reconcile duplicate SmartDash experiences in the persistent SQLite store.

The web discovery layer can rediscover the same event through different URLs or slightly
different titles. This script conservatively collapses those duplicates after each refresh
without touching clearly distinct sub-events.
"""

import argparse
import json
import re
import sqlite3
import sys
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urlsplit

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB = BASE_DIR / "data" / "experiences.db"


def normalize_text(value):
    value = str(value or "").casefold().strip()
    value = re.sub(r"[^a-z0-9æøå]+", " ", value)
    return " ".join(value.split())


def normalized_host(value):
    if not value:
        return ""
    raw = str(value).strip()
    if "://" not in raw:
        raw = "https://" + raw
    try:
        host = (urlsplit(raw).hostname or "").casefold()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def similarity(left, right):
    a, b = normalize_text(left), normalize_text(right)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def same_day(left, right):
    return str(left.get("start") or "")[:10] == str(right.get("start") or "")[:10]


def likely_duplicate(left, right):
    if not same_day(left, right):
        return False

    title_a = normalize_text(left.get("title"))
    title_b = normalize_text(right.get("title"))
    if not title_a or not title_b:
        return False
    if title_a == title_b:
        return True

    title_score = similarity(title_a, title_b)
    venue_score = similarity(left.get("venue"), right.get("venue"))
    city_a, city_b = normalize_text(left.get("city")), normalize_text(right.get("city"))
    same_city = bool(city_a and city_b and (city_a == city_b or city_a in city_b or city_b in city_a))
    same_host = normalized_host(left.get("source_url")) == normalized_host(right.get("source_url"))

    # Title variants of the same event, e.g. "Askepot – The Musical" vs
    # "Askepot – The Musical Aarhus 2026", should merge when venue/city/source agrees.
    if title_score >= 0.84 and (venue_score >= 0.78 or same_city or same_host):
        return True
    if title_score >= 0.76 and venue_score >= 0.92:
        return True
    return False


def richness(item):
    score = 0
    for key in ("source_url", "venue", "city", "source", "price_note", "age_evidence", "travel_evidence"):
        if item.get(key):
            score += 1
    score += min(len(item.get("why") or []), 4)
    score += min(len(item.get("benefits") or []), 3)
    score += min(len(item.get("cluster_items") or []), 4)
    return score


def preferred(left, right):
    def key(item):
        fit = (item.get("family_fit") or {}).get("score")
        evidence = (item.get("family_fit") or {}).get("evidence")
        return (
            float(fit) if fit is not None else -1.0,
            float(evidence) if evidence is not None else -1.0,
            richness(item),
        )
    return left if key(left) >= key(right) else right


def merge_provenance(winner, loser):
    merged = dict(winner)
    sources = []
    for item in (winner, loser):
        for value in (
            item.get("source"),
            item.get("source_url"),
        ):
            if value and value not in sources:
                sources.append(value)
        for value in item.get("store_duplicate_sources") or []:
            if value and value not in sources:
                sources.append(value)
    if sources:
        merged["store_duplicate_sources"] = sources
    return merged


def dedupe(conn):
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, title, start, venue, city, source, source_url, family_fit_score, value_score, payload_json "
        "FROM experiences WHERE active=1 ORDER BY substr(start,1,10), family_fit_score DESC"
    ).fetchall()
    entries = []
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        entries.append({"row": row, "payload": payload})

    removed = 0
    merged_pairs = []
    consumed = set()
    for index, left_entry in enumerate(entries):
        left_id = left_entry["row"]["id"]
        if left_id in consumed:
            continue
        for right_entry in entries[index + 1:]:
            right_id = right_entry["row"]["id"]
            if right_id in consumed:
                continue
            left = left_entry["payload"]
            right = right_entry["payload"]
            if not likely_duplicate(left, right):
                continue

            winner_payload = preferred(left, right)
            loser_payload = right if winner_payload is left else left
            winner_entry = left_entry if winner_payload is left else right_entry
            loser_entry = right_entry if winner_payload is left else left_entry
            merged = merge_provenance(winner_payload, loser_payload)

            conn.execute(
                "UPDATE experiences SET title=?, start=?, end=?, venue=?, city=?, source=?, source_url=?, "
                "family_fit_score=?, value_score=?, payload_json=? WHERE id=?",
                (
                    merged.get("title"), merged.get("start"), merged.get("end"), merged.get("venue"),
                    merged.get("city"), merged.get("source"), merged.get("source_url"),
                    (merged.get("family_fit") or {}).get("score"), (merged.get("value") or {}).get("score"),
                    json.dumps(merged, ensure_ascii=False, separators=(",", ":")), winner_entry["row"]["id"],
                ),
            )
            conn.execute("DELETE FROM experiences WHERE id=?", (loser_entry["row"]["id"],))
            consumed.add(loser_entry["row"]["id"])
            if winner_entry is right_entry:
                left_entry = right_entry
            removed += 1
            merged_pairs.append([winner_payload.get("title"), loser_payload.get("title")])

    conn.commit()
    return {"duplicates_removed": removed, "merged_pairs": merged_pairs}


def self_test():
    assert likely_duplicate(
        {"title": "Solfestival på Fugledegaard ved Tissø", "start": "2026-09-19T10:00:00", "city": "Hvidebæk"},
        {"title": "Solfestival på Fugledegaard ved Tissø", "start": "2026-09-19T11:00:00", "city": "Kalundborg-området"},
    )
    assert likely_duplicate(
        {"title": "Askepot – The Musical Aarhus 2026", "start": "2026-09-19T15:00:00", "venue": "Musikhuset Aarhus", "city": "Aarhus"},
        {"title": "Askepot – The Musical", "start": "2026-09-19T15:00:00", "venue": "Musikhuset Aarhus", "city": "Aarhus"},
    )
    assert not likely_duplicate(
        {"title": "Horsens Teaterfestival 2026", "start": "2026-09-19T10:00:00", "city": "Horsens"},
        {"title": "HAVÅND – gratis udendørs teater på Horsens Teaterfestival", "start": "2026-09-19T11:00:00", "city": "Horsens"},
    )
    assert not likely_duplicate(
        {"title": "Askepot – The Musical", "start": "2026-09-19T15:00:00", "city": "Aarhus"},
        {"title": "Askepot – The Musical", "start": "2026-09-20T14:00:00", "city": "Aarhus"},
    )
    print("EXPERIENCE DEDUPE SELF-TEST OK")
    print("same-day Solfestival/Askepot variants merge; distinct sub-events/dates stay separate")


def main():
    parser = argparse.ArgumentParser(description="Reconcile duplicate experiences in experiences.db")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    conn = sqlite3.connect(args.db)
    result = dedupe(conn)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (sqlite3.Error, AssertionError) as exc:
        print(f"FEJL: {exc}", file=sys.stderr)
        sys.exit(1)
