#!/usr/bin/env python3

"""SmartDash family experience discovery POC.

The collector has two modes:
- contract: print the deterministic discovery request without external calls.
- openai: use the OpenAI Responses API with web search and return structured
  experience candidates.

Benefits such as LogBuy or season passes are deliberately excluded from
experience discovery and ranking. They belong to a later enrichment stage.
"""

import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from pathlib import Path

import requests


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
ENV_FILE = DATA_DIR / "experience-collector.env"
OUTPUT_FILE = DATA_DIR / "experiences-poc.json"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"

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

DISCOVERY_SEGMENTS = [
    {
        "name": "local",
        "instruction": (
            "Prioritize Silkeborg, Skanderborg, Aarhus and nearby areas. Search local "
            "event calendars, libraries, city-centre associations, culture houses and "
            "curated local media. Look especially for small events that broad national "
            "event databases often miss."
        ),
    },
    {
        "name": "culture",
        "instruction": (
            "Search broadly across Jutland for festivals, theatre, workshops, science, "
            "museums, hands-on culture and other special or time-limited family events. "
            "Quality may justify a longer drive from Silkeborg."
        ),
    },
    {
        "name": "attractions",
        "instruction": (
            "Search attractions and venues across Jutland for special activities, theme "
            "days, seasonal programmes and unusually strong evergreen experiences for "
            "children aged 7 and 9. Prefer concrete activities over generic venue pages."
        ),
    },
    {
        "name": "broad",
        "instruction": (
            "Do a broad gap-finding web search for excellent family experiences that the "
            "other searches could plausibly miss. Include ticket/event platforms and "
            "independent event pages, but verify every candidate against a credible page."
        ),
    },
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

RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "title": {"type": "string"},
                    "start": {"type": "string"},
                    "end": {"type": "string"},
                    "venue": {"type": "string"},
                    "city": {"type": "string"},
                    "source": {"type": "string"},
                    "source_url": {"type": "string"},
                    "event_type": {"type": "string"},
                    "age_min": {"type": ["integer", "null"]},
                    "age_max": {"type": ["integer", "null"]},
                    "price_family": {"type": ["number", "null"]},
                    "price_note": {"type": "string"},
                    "special_event": {"type": "boolean"},
                    "indoor_outdoor": {
                        "type": "string",
                        "enum": ["indoor", "outdoor", "mixed", "unknown"],
                    },
                    "cluster_name": {"type": ["string", "null"]},
                    "why": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": REQUIRED_RESULT_FIELDS,
            },
        }
    },
    "required": ["results"],
}


def parse_date(value):
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"Ugyldig dato {value!r}. Brug YYYY-MM-DD."
        ) from exc


def load_env():
    if not ENV_FILE.exists():
        return

    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def get_required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Mangler {name} i miljøet eller {ENV_FILE}")
    return value


def get_int_env(name, default, minimum=1, maximum=None):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} skal være et heltal") from exc
    if value < minimum or (maximum is not None and value > maximum):
        limit = f"{minimum}-{maximum}" if maximum is not None else f">= {minimum}"
        raise RuntimeError(f"{name} skal være {limit}")
    return value


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
            "quality is otherwise comparable. Verify dates, venue and source URL. "
            "Do not rank based on discounts, memberships or season passes. "
            "Cluster multiple activities that belong to the same festival or "
            "umbrella event using cluster_name rather than treating every subevent "
            "as an unrelated discovery."
        ),
        "required_output_fields": REQUIRED_RESULT_FIELDS,
    }


def build_openai_prompt(discovery_request, segment):
    return (
        "You are one focused discovery worker for a private Danish family dashboard.\n\n"
        + segment["instruction"]
        + "\n\nFind concrete experiences that actually take place in the requested period. "
        "Search the web and verify promising candidates against credible source pages. "
        "Favor memorable, unusual or time-limited family experiences. The source_url "
        "must point to a real page that supports the candidate. If an exact family "
        "price cannot be established, use null and explain what is known in price_note. "
        "Do not invent dates, prices, age ranges or URLs. Do not use discounts or "
        "membership benefits to decide what deserves discovery. Return only 4-8 strong "
        "candidates from this search focus; quality is more important than count.\n\n"
        "Discovery contract:\n"
        + json.dumps(discovery_request, ensure_ascii=False, indent=2)
    )


def extract_output_text(response_data):
    texts = []
    for item in response_data.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                texts.append(content["text"])

    if not texts:
        raise RuntimeError("OpenAI-svaret indeholdt ingen output_text")

    return "\n".join(texts)


def normalize_key_text(value):
    value = (value or "").casefold().strip()
    value = re.sub(r"[^a-z0-9æøå]+", " ", value)
    return " ".join(value.split())


def dedupe_results(results):
    deduped = []
    seen = set()
    for item in results:
        key = (
            normalize_key_text(item.get("title")),
            normalize_key_text(item.get("city")),
            (item.get("start") or "")[:10],
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def openai_segment(discovery_request, segment, api_key, model, search_context, timeout):
    payload = {
        "model": model,
        "store": False,
        "reasoning": {"effort": "none"},
        "tools": [
            {
                "type": "web_search",
                "search_context_size": search_context,
                "user_location": {
                    "type": "approximate",
                    "city": "Silkeborg",
                    "region": "Midtjylland",
                    "country": "DK",
                    "timezone": "Europe/Copenhagen",
                },
            }
        ],
        "input": build_openai_prompt(discovery_request, segment),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "smartdash_experience_discovery",
                "description": "Verified family experience candidates",
                "strict": True,
                "schema": RESULT_SCHEMA,
            }
        },
    }

    response = requests.post(
        OPENAI_RESPONSES_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=timeout,
    )

    if not response.ok:
        detail = response.text.strip()
        if len(detail) > 1500:
            detail = detail[:1500] + "..."
        raise RuntimeError(
            f"OpenAI Responses API fejlede for {segment['name']} "
            f"({response.status_code}): {detail}"
        )

    response_data = response.json()
    output_text = extract_output_text(response_data)

    try:
        parsed = json.loads(output_text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"OpenAI returnerede ikke gyldig JSON for {segment['name']}"
        ) from exc

    results = parsed.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"OpenAI-svaret mangler results for {segment['name']}")

    return {
        "segment": segment["name"],
        "response_id": response_data.get("id"),
        "results": results,
    }


def discover_with_openai(discovery_request):
    load_env()
    api_key = get_required_env("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"
    search_context = (
        os.environ.get("OPENAI_SEARCH_CONTEXT", "medium").strip().lower() or "medium"
    )
    if search_context not in {"low", "medium", "high"}:
        raise RuntimeError("OPENAI_SEARCH_CONTEXT skal være low, medium eller high")

    timeout = get_int_env("OPENAI_TIMEOUT_SECONDS", 120, minimum=30, maximum=600)
    workers = get_int_env(
        "OPENAI_DISCOVERY_WORKERS",
        len(DISCOVERY_SEGMENTS),
        minimum=1,
        maximum=len(DISCOVERY_SEGMENTS),
    )

    segment_results = []
    errors = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                openai_segment,
                discovery_request,
                segment,
                api_key,
                model,
                search_context,
                timeout,
            ): segment["name"]
            for segment in DISCOVERY_SEGMENTS
        }
        for future in as_completed(futures):
            segment_name = futures[future]
            try:
                segment_results.append(future.result())
            except (requests.RequestException, RuntimeError) as exc:
                errors.append(f"{segment_name}: {exc}")

    if not segment_results:
        raise RuntimeError("Alle discovery-søgninger fejlede: " + " | ".join(errors))

    all_results = []
    response_ids = []
    successful_segments = []
    for segment_result in segment_results:
        successful_segments.append(segment_result["segment"])
        if segment_result.get("response_id"):
            response_ids.append(segment_result["response_id"])
        all_results.extend(segment_result["results"])

    deduped = dedupe_results(all_results)
    return {
        "provider": "openai",
        "model": model,
        "search_context": search_context,
        "segments": successful_segments,
        "response_ids": response_ids,
        "partial_errors": errors,
        "raw_result_count": len(all_results),
        "deduped_result_count": len(deduped),
        "results": deduped,
    }


def build_payload(start_date, end_date, provider_result=None):
    discovery_request = build_discovery_request(start_date, end_date)
    return {
        "generated_at": datetime.now().astimezone().isoformat(),
        "request": discovery_request,
        "provider": provider_result.get("provider") if provider_result else None,
        "model": provider_result.get("model") if provider_result else None,
        "response_ids": provider_result.get("response_ids", []) if provider_result else [],
        "results": provider_result.get("results", []) if provider_result else [],
    }


def main():
    parser = argparse.ArgumentParser(
        description="POC collector for family experience discovery."
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
        "--provider",
        choices=("contract", "openai"),
        default="contract",
        help="contract viser requesten; openai udfører web discovery",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Gem resultatet i data/experiences-poc.json",
    )
    args = parser.parse_args()

    if args.end_date < args.start_date:
        parser.error("--to må ikke ligge før --from")

    discovery_request = build_discovery_request(args.start_date, args.end_date)

    print("=== EXPERIENCE COLLECTOR POC ===")
    print(f"Periode: {args.start_date} -> {args.end_date}")
    print(f"Udgangspunkt: {FAMILY_PROFILE['home']}")
    print(f"Børnealder: {', '.join(map(str, FAMILY_PROFILE['children_ages']))}")
    print(f"Provider: {args.provider}")
    print()

    provider_result = None

    if args.provider == "contract":
        print(json.dumps(discovery_request, ensure_ascii=False, indent=2))
    else:
        provider_result = discover_with_openai(discovery_request)
        print(json.dumps(provider_result, ensure_ascii=False, indent=2))

    if args.write:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        OUTPUT_FILE.write_text(
            json.dumps(
                build_payload(
                    args.start_date,
                    args.end_date,
                    provider_result=provider_result,
                ),
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
    try:
        sys.exit(main())
    except (requests.RequestException, RuntimeError) as exc:
        print(f"FEJL: {exc}", file=sys.stderr)
        sys.exit(1)
