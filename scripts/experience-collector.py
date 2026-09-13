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
import sys
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


def build_openai_prompt(discovery_request):
    return (
        "You are the discovery provider for a private Danish family dashboard.\n\n"
        "Find concrete experiences that actually take place in the requested "
        "period. Search the web broadly and verify promising candidates against "
        "credible source pages. Favor memorable, unusual or time-limited family "
        "experiences, while still including excellent evergreen options when they "
        "are genuinely relevant. The source_url must point to a real page that "
        "supports the candidate. If an exact family price cannot be established, "
        "use null and explain what is known in price_note. Do not invent dates, "
        "prices, age ranges or URLs. Do not use discounts or membership benefits "
        "to decide what deserves discovery. Return roughly 10-20 strong candidates "
        "when the web supports that many.\n\n"
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


def discover_with_openai(discovery_request):
    load_env()
    api_key = get_required_env("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_MODEL", "gpt-5").strip() or "gpt-5"
    search_context = (
        os.environ.get("OPENAI_SEARCH_CONTEXT", "high").strip().lower() or "high"
    )
    if search_context not in {"low", "medium", "high"}:
        raise RuntimeError("OPENAI_SEARCH_CONTEXT skal være low, medium eller high")

    payload = {
        "model": model,
        "store": False,
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
        "input": build_openai_prompt(discovery_request),
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
        timeout=180,
    )

    if not response.ok:
        detail = response.text.strip()
        if len(detail) > 1500:
            detail = detail[:1500] + "..."
        raise RuntimeError(
            f"OpenAI Responses API fejlede ({response.status_code}): {detail}"
        )

    response_data = response.json()
    output_text = extract_output_text(response_data)

    try:
        parsed = json.loads(output_text)
    except json.JSONDecodeError as exc:
        raise RuntimeError("OpenAI returnerede ikke gyldig JSON") from exc

    results = parsed.get("results")
    if not isinstance(results, list):
        raise RuntimeError("OpenAI-svaret mangler results-listen")

    return {
        "provider": "openai",
        "model": model,
        "response_id": response_data.get("id"),
        "results": results,
    }


def build_payload(start_date, end_date, provider_result=None):
    discovery_request = build_discovery_request(start_date, end_date)
    return {
        "generated_at": datetime.now().astimezone().isoformat(),
        "request": discovery_request,
        "provider": provider_result.get("provider") if provider_result else None,
        "model": provider_result.get("model") if provider_result else None,
        "response_id": provider_result.get("response_id") if provider_result else None,
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
        print(
            json.dumps(
                provider_result,
                ensure_ascii=False,
                indent=2,
            )
        )

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
