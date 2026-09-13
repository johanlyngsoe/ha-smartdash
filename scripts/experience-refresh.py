#!/usr/bin/env python3

"""Run the complete SmartDash experience pipeline.

Discovery -> ranking -> benefit enrichment -> persistent SQLite store -> de-duplication
-> JSON snapshot. The JSON snapshot remains the current UI contract, while SQLite
provides history and prevents good future events from disappearing just because one
discovery run misses them.
"""

import argparse
import importlib.util
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
CONFIG_FILE = BASE_DIR / "config" / "experience-known-sources.json"
RAW_OUTPUT = DATA_DIR / "experiences-poc.json"
ENRICHED_OUTPUT = DATA_DIR / "experiences-enriched.json"
DB_FILE = DATA_DIR / "experiences.db"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Kunne ikke indlæse modul: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_known_sources():
    try:
        payload = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Kunne ikke læse {CONFIG_FILE}: {exc}") from exc
    sources = payload.get("sources") if isinstance(payload, dict) else None
    if not isinstance(sources, list):
        raise RuntimeError("experience-known-sources.json mangler sources-listen")
    output = [str(item).strip() for item in sources if str(item).strip()]
    if not output:
        raise RuntimeError("experience-known-sources.json indeholder ingen kilder")
    return output


def default_lookahead_days():
    raw = os.environ.get("EXPERIENCE_LOOKAHEAD_DAYS", "28").strip()
    try:
        return max(7, min(90, int(raw)))
    except ValueError as exc:
        raise RuntimeError("EXPERIENCE_LOOKAHEAD_DAYS skal være et heltal") from exc


def enrich_payload(payload, benefits):
    catalog = benefits.load_json(benefits.CONFIG_FILE)
    logbuy_deals = benefits.parse_logbuy_deals()
    results = payload.get("results") or []
    enriched = [benefits.enrich_item(item, catalog, logbuy_deals) for item in results]
    enriched.sort(
        key=lambda item: (
            item.get("family_fit", {}).get("score", 0),
            item.get("value", {}).get("score") if item.get("value", {}).get("score") is not None else -1,
        ),
        reverse=True,
    )
    corrected = sum(
        item.get("value", {}).get("price_validation", {}).get("status") == "corrected"
        for item in enriched
    )
    possible = sum(
        any(b.get("program") == "Visma LogBuy" for b in item.get("benefits", []))
        for item in enriched
    )
    output = dict(payload)
    output["benefit_enrichment"] = {
        "catalog": str(benefits.CONFIG_FILE.relative_to(BASE_DIR)),
        "logbuy_active_deals_loaded": len(logbuy_deals),
        "logbuy_possible_matches": possible,
        "price_corrections": corrected,
        "djurs_pass_holders": benefits.program_holder_count(catalog["programs"][0]),
    }
    output["results"] = enriched
    return output


def add_coverage_segments(collector, sources):
    portal_sources = [
        value for value in sources
        if value in {"HvadErPå.dk", "Silkeborg Handel"}
    ]
    remaining_sources = [value for value in sources if value not in portal_sources]

    segments = list(collector.DISCOVERY_SEGMENTS)
    segments.append({
        "name": "local_retail_sources",
        "instruction": (
            "LOCAL/RETAIL COVERAGE: search broadly for small local one-off family activities "
            "that ordinary attraction/event searches often miss. Include independent retailers, "
            "bakeries, cafés, shopping centres, city-centre associations and local businesses' own "
            "event or campaign pages. Search especially for children's food workshops, chocolate "
            "or confectionery activities, decorating classes, craft events and free reservation "
            "events. Use local event portals as leads but verify candidates against credible pages. "
            + (("Explicitly include these useful local portals: " + ", ".join(portal_sources) + ". ") if portal_sources else "")
            + "Do not target or depend on any single retailer or brand."
        ),
    })
    if remaining_sources:
        segments.append({
            "name": "fixed_sources",
            "instruction": (
                "FIXED SOURCE COVERAGE: explicitly search EVERY source in this list before finishing: "
                + ", ".join(remaining_sources)
                + ". Do not assume the broad searches cover them. Look for concrete dated family "
                  "events in the requested period. Pay special attention to small local one-off "
                  "activities, workshops and children's events. Return the strongest candidates even "
                  "when they also appear on another site."
            ),
        })
    collector.DISCOVERY_SEGMENTS = segments


def run_refresh(start_date, end_date):
    collector = load_module("smartdash_experience_collector", BASE_DIR / "scripts" / "experience-collector.py")
    benefits = load_module("smartdash_experience_benefits", BASE_DIR / "scripts" / "experience-benefits.py")
    store = load_module("smartdash_experience_store", BASE_DIR / "scripts" / "experience-store.py")
    dedupe = load_module("smartdash_experience_dedupe", BASE_DIR / "scripts" / "experience-dedupe.py")

    sources = load_known_sources()
    collector.KNOWN_SOURCES = sources
    add_coverage_segments(collector, sources)

    discovery_request = collector.build_discovery_request(start_date, end_date)
    provider_result = collector.discover_with_openai(discovery_request)
    raw_payload = collector.build_payload(start_date, end_date, provider_result=provider_result)
    RAW_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    RAW_OUTPUT.write_text(json.dumps(raw_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    enriched_payload = enrich_payload(raw_payload, benefits)
    conn = store.connect(DB_FILE)
    refresh_id, _ = store.upsert_payload(conn, enriched_payload)
    dedupe_result = dedupe.dedupe(conn)
    active_count = conn.execute("SELECT COUNT(*) FROM experiences WHERE active=1").fetchone()[0]
    snapshot = store.export_snapshot(conn, enriched_payload, ENRICHED_OUTPUT)

    return {
        "period": {"from": start_date.isoformat(), "to": end_date.isoformat()},
        "known_sources": sources,
        "successful_segments": provider_result.get("segments", []),
        "partial_errors": provider_result.get("partial_errors", []),
        "raw_result_count": provider_result.get("raw_result_count"),
        "clustered_result_count": provider_result.get("clustered_result_count"),
        "incoming_enriched_count": len(enriched_payload.get("results") or []),
        "database_active_count": active_count,
        "duplicates_removed": dedupe_result.get("duplicates_removed", 0),
        "snapshot_count": len(snapshot.get("results") or []),
        "refresh_id": refresh_id,
        "database": str(DB_FILE),
        "snapshot": str(ENRICHED_OUTPUT),
    }


def self_test():
    collector = load_module("smartdash_experience_collector_test", BASE_DIR / "scripts" / "experience-collector.py")
    benefits = load_module("smartdash_experience_benefits_test", BASE_DIR / "scripts" / "experience-benefits.py")
    store = load_module("smartdash_experience_store_test", BASE_DIR / "scripts" / "experience-store.py")
    dedupe = load_module("smartdash_experience_dedupe_test", BASE_DIR / "scripts" / "experience-dedupe.py")
    sources = load_known_sources()
    assert "HvadErPå.dk" in sources
    assert all("Lagkagehuset" not in value for value in sources)
    assert "Bio Silkeborg" in sources
    assert "Jysk Musikteater" in sources
    original_count = len(collector.DISCOVERY_SEGMENTS)
    add_coverage_segments(collector, sources)
    added = collector.DISCOVERY_SEGMENTS[original_count:]
    added_names = [item.get("name") for item in added]
    assert "local_retail_sources" in added_names
    assert "fixed_sources" in added_names
    local_instruction = next(item["instruction"] for item in added if item.get("name") == "local_retail_sources")
    assert "single retailer or brand" in local_instruction
    assert "Lagkagehuset" not in local_instruction
    collector.run_self_test()
    benefits.self_test(benefits.load_json(benefits.CONFIG_FILE))
    store.self_test()
    dedupe.self_test()
    print("EXPERIENCE REFRESH SELF-TEST OK")
    print(f"fixed sources loaded: {len(sources)}; generic local/retail coverage enabled")


def main():
    parser = argparse.ArgumentParser(description="Refresh SmartDash experience discovery, benefits and SQLite store")
    parser.add_argument("--from", dest="start_date", type=date.fromisoformat)
    parser.add_argument("--to", dest="end_date", type=date.fromisoformat)
    parser.add_argument("--days", type=int, help="Lookahead days when --to is omitted")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0

    start_date = args.start_date or date.today()
    days = args.days if args.days is not None else default_lookahead_days()
    days = max(7, min(90, days))
    end_date = args.end_date or (start_date + timedelta(days=days))
    if end_date < start_date:
        parser.error("--to må ikke ligge før --from")

    result = run_refresh(start_date, end_date)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"FEJL: {exc}", file=sys.stderr)
        sys.exit(1)
