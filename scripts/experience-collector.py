#!/usr/bin/env python3

"""Read-only POC contract for SmartDash family experience discovery.

This first step deliberately does not call OpenAI, scrape sources, write SQLite,
or apply membership/discount benefits. It defines and validates the request
contract that a later research provider will consume.
"""

import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
OUTPUT_FILE = DATA_DIR / "experiences-poc.json"

FAMILY_PROFILE = {
    "home": "Silkeborg",
    "children_ages": [7, 9],
    "language": "da",
    "country": "DK",
}

KNOWN_SOURCES = [
    "VisitAarhus",
    "AOA",
    "Silkeborg Bibliotekerne",
    "Silkeborg Handel",
    "Billetto",
    "Ticketmaster",
]

REQUIRED_RESULT_FIELDS = [
    "title",
    "start",
    "end",
    "venue",
    "city",
    "source",
    "source_url",
    "event_type",
    "age_min",
    "age_max",
    "price_family",
    "price_note",
    "special_event",
    "indoor_outdoor",
    "cluster_name",
    "why",
]


def parse_date(value):
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"Ugyldig dato {value!r}. Brug YYYY-MM-DD."
        ) from exc


def build_discovery_request(start_date, end_date):
    return {
        "task": "family_experience_discovery",
        "period": {
            "from": start_date.isoformat(),
            "to": end_date.isoformat(),
        },
        "family": FAMILY_PROFILE,
        "priorities": {
            "primary": [
                "family suitability",
                "age relevance",
                "special or time-limited events",
                "interesting or memorable experience",
                "reasonable travel time from Silkeborg",
            ],
            "secondary": [
                "normal family price",
                "indoor or outdoor suitability",
                "weather sensitivity",
            ],
            "exclude_from_ranking": [
                "LogBuy discount",
                "season pass benefits",
                "membership discounts",
            ],
        },
        "known_sources": KNOWN_SOURCES,
        "research_instruction": (
            "Search broadly for the most relevant and exciting family experiences "
            "for two adults and children aged 7 and 9, starting from Silkeborg. "
            "Use known sources, but also actively search beyond them for events "
            "and experiences they may have missed. Prefer special events and "
            "time-limited activities over ordinary evergreen attractions when "
            "quality is otherwise comparable. Do not rank based on discounts."
        ),
        "required_output_fields": REQUIRED_RESULT_FIELDS,
    }


def build_payload(start_date, end_date):
    return {
        "generated_at": datetime.now().astimezone().isoformat(),
        "request": build_discovery_request(start_date, end_date),
        "results": [],
    }


def main():
    parser = argparse.ArgumentParser(
        description="Read-only POC contract for family experience discovery."
    )
    parser.add_argument(
        "--from",
        dest="start_date",
        type=parse_date,
        required=True,
        help="Startdato YYYY-MM-DD",
    )
    parser.add_argument(
        "--to",
        dest="end_date",
        type=parse_date,
        required=True,
        help="Slutdato YYYY-MM-DD",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Gem POC-requesten i data/experiences-poc.json",
    )
    args = parser.parse_args()

    if args.end_date < args.start_date:
        parser.error("--to må ikke ligge før --from")

    request = build_discovery_request(args.start_date, args.end_date)

    print("=== EXPERIENCE COLLECTOR POC ===")
    print(f"Periode: {args.start_date} -> {args.end_date}")
    print(f"Udgangspunkt: {FAMILY_PROFILE['home']}")
    print(f"Børnealder: {', '.join(map(str, FAMILY_PROFILE['children_ages']))}")
    print()
    print(json.dumps(request, ensure_ascii=False, indent=2))

    if args.write:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        OUTPUT_FILE.write_text(
            json.dumps(
                build_payload(args.start_date, args.end_date),
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print()
        print(f"Skrevet: {OUTPUT_FILE}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
