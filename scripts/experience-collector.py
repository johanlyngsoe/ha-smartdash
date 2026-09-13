#!/usr/bin/env python3

"""SmartDash family experience discovery POC.

Modes:
- contract: print the deterministic discovery request without external calls.
- openai: use the OpenAI Responses API with web search, then deterministically
  de-duplicate, age-filter, rank and cluster candidates.
- self-test: validate deterministic age and travel scoring without external calls.

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
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

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
    "age_source",
    "age_evidence",
    "age_evidence_url",
    "price_family",
    "price_note",
    "special_event",
    "specialness_level",
    "specialness_reason",
    "indoor_outdoor",
    "cluster_name",
    "travel_minutes",
    "travel_distance_km",
    "travel_requires_ferry",
    "travel_source",
    "travel_evidence",
    "travel_evidence_url",
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
                    "age_source": {
                        "type": "string",
                        "enum": ["verified", "inferred", "unknown"],
                    },
                    "age_evidence": {"type": "string"},
                    "age_evidence_url": {"type": "string"},
                    "price_family": {"type": ["number", "null"]},
                    "price_note": {"type": "string"},
                    "special_event": {"type": "boolean"},
                    "specialness_level": {
                        "type": "string",
                        "enum": ["exceptional", "strong", "good", "standard"],
                    },
                    "specialness_reason": {"type": "string"},
                    "indoor_outdoor": {
                        "type": "string",
                        "enum": ["indoor", "outdoor", "mixed", "unknown"],
                    },
                    "cluster_name": {"type": ["string", "null"]},
                    "travel_minutes": {"type": ["integer", "null"]},
                    "travel_distance_km": {"type": ["number", "null"]},
                    "travel_requires_ferry": {"type": "boolean"},
                    "travel_source": {
                        "type": "string",
                        "enum": ["verified", "inferred", "unknown"],
                    },
                    "travel_evidence": {"type": "string"},
                    "travel_evidence_url": {"type": "string"},
                    "why": {"type": "array", "items": {"type": "string"}},
                },
                "required": REQUIRED_RESULT_FIELDS,
            },
        }
    },
    "required": ["results"],
}

FALLBACK_CITY_PROXIMITY = {
    "silkeborg": 100,
    "them": 96,
    "engesvang": 94,
    "ry": 92,
    "skanderborg": 88,
    "galten": 86,
    "hoerning": 84,
    "hørning": 84,
    "aarhus": 78,
    "århus": 78,
    "horsens": 78,
    "viborg": 75,
    "herning": 75,
    "randers": 65,
    "ebeltoft": 60,
    "esbjerg": 44,
    "christiansfeld": 44,
    "hadsund": 44,
    "storvorde": 40,
    "tistrup": 38,
    "jyderup": 28,
    "nordborg": 25,
    "samsoe": 12,
    "samsø": 12,
}

SPECIALNESS_SCORES = {
    "exceptional": 100,
    "strong": 90,
    "good": 80,
    "standard": 68,
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
        "period": {"from": start_date.isoformat(), "to": end_date.isoformat()},
        "family": FAMILY_PROFILE,
        "priorities": {
            "primary": [
                "family suitability",
                "age relevance",
                "special or time-limited events",
                "interesting or memorable experience",
                "practical one-way travel time from Silkeborg",
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
            "Search broadly for the most relevant and exciting family experiences for "
            "two adults and children aged 7 and 9, starting from Silkeborg. Verify dates, "
            "venue and source URL. Before returning any candidate, explicitly inspect the "
            "source for minimum, maximum or recommended ages. If the source contains an "
            "age restriction that excludes either child, still return the candidate with "
            "that verified age data so deterministic filtering can reject it. Mark "
            "age_source as verified only when age_evidence contains a concrete source fact "
            "and age_evidence_url points to the supporting page. Use inferred only for a "
            "reasoned estimate, otherwise unknown. Also estimate practical one-way travel "
            "time from Silkeborg, including ferry/waiting when a ferry is required. Mark "
            "travel_source as verified only with supporting route/travel evidence and URL; "
            "otherwise use inferred or unknown. Set travel_requires_ferry true whenever "
            "the trip requires a ferry, including Samsø. Do not rank based on discounts, "
            "memberships or season passes. Use one consistent cluster_name for every "
            "subevent under the same festival or umbrella event across the whole weekend."
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
        "must point to a real supporting page. Do not invent dates, prices, ages or URLs. "
        "AGE CHECK IS MANDATORY: inspect each candidate's source for explicit age wording. "
        "If there is a minimum, maximum or recommended age, capture it in age_min/age_max "
        "and summarize the concrete source fact in age_evidence. Use verified only when "
        "that evidence is explicit and provide the supporting page in age_evidence_url. "
        "If there is no explicit age statement, use inferred or unknown and leave "
        "age_evidence empty. Do not hide age-incompatible candidates; return them with the "
        "verified restriction so the deterministic layer can reject them.\n\n"
        "TRAVEL CHECK IS MANDATORY: estimate practical one-way travel from Silkeborg to the "
        "venue, not straight-line distance. Include realistic ferry/waiting time where "
        "relevant. Return travel_minutes and travel_distance_km when defensible. Set "
        "travel_requires_ferry=true for destinations such as Samsø that require a ferry. "
        "Use travel_source=verified only when travel_evidence and travel_evidence_url "
        "support the route/travel estimate; otherwise use inferred or unknown. Do not "
        "pretend an island or cross-country destination is an ordinary day-trip merely "
        "because its straight-line distance is short.\n\n"
        "SPECIALNESS: classify exceptional only for rare flagship, highly distinctive or "
        "especially memorable opportunities; strong for clearly special time-limited "
        "experiences; good for worthwhile local/family activities; standard for ordinary "
        "or evergreen options. Give a short specialness_reason.\n\n"
        "Use the same cluster_name for all items belonging to one festival/umbrella event, "
        "even when they occur on different dates or at different venues. Return only 4-8 "
        "strong candidates from this search focus; quality is more important than count.\n\n"
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


def canonical_url(value):
    if not value:
        return ""
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return value.strip().rstrip("/").casefold()
    return urlunsplit(
        (parts.scheme.casefold(), parts.netloc.casefold(), parts.path.rstrip("/"), "", "")
    )


def parse_event_day(value):
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def date_ranges_overlap(left, right):
    left_start = parse_event_day(left.get("start"))
    right_start = parse_event_day(right.get("start"))
    if not left_start or not right_start:
        return True
    left_end = parse_event_day(left.get("end")) or left_start
    right_end = parse_event_day(right.get("end")) or right_start
    return left_start <= right_end and right_start <= left_end


def title_similarity(left, right):
    a = normalize_key_text(left)
    b = normalize_key_text(right)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def are_duplicates(left, right):
    left_url = canonical_url(left.get("source_url"))
    right_url = canonical_url(right.get("source_url"))
    if left_url and left_url == right_url:
        return True
    if normalize_key_text(left.get("city")) != normalize_key_text(right.get("city")):
        return False
    if not date_ranges_overlap(left, right):
        return False
    return title_similarity(left.get("title"), right.get("title")) >= 0.80


def richness_score(item):
    score = 0
    for field in (
        "venue",
        "city",
        "source",
        "source_url",
        "event_type",
        "price_note",
        "specialness_reason",
        "travel_evidence",
    ):
        if item.get(field):
            score += 1
    score += min(len(item.get("why") or []), 4)
    if item.get("age_source") == "verified":
        score += 2
    if item.get("age_evidence"):
        score += 2
    if item.get("travel_source") == "verified":
        score += 2
    if "T" in (item.get("start") or ""):
        score += 1
    return score


def merge_duplicate(primary, duplicate):
    if richness_score(duplicate) > richness_score(primary):
        primary, duplicate = duplicate, primary
    duplicate_sources = set(primary.get("duplicate_sources") or [])
    for value in (duplicate.get("source"), duplicate.get("source_url")):
        if value:
            duplicate_sources.add(value)
    if duplicate_sources:
        primary["duplicate_sources"] = sorted(duplicate_sources)
    return primary


def dedupe_results(results):
    deduped = []
    for item in results:
        matched_index = None
        for index, existing in enumerate(deduped):
            if are_duplicates(item, existing):
                matched_index = index
                break
        if matched_index is None:
            deduped.append(dict(item))
        else:
            deduped[matched_index] = merge_duplicate(deduped[matched_index], dict(item))
    return deduped


def infer_explicit_age_from_text(item):
    text = " ".join(
        str(value or "")
        for value in (
            item.get("age_evidence"),
            item.get("price_note"),
            " ".join(item.get("why") or []),
        )
    ).casefold()
    minimum_patterns = [
        r"(?:fra|min(?:imum)?(?:salder)?|mindst)\s*(\d{1,2})\s*år",
        r"(\d{1,2})\s*\+",
    ]
    maximum_patterns = [
        r"(?:til|max(?:imum)?(?:salder)?|højst)\s*(\d{1,2})\s*år",
    ]
    minimum = maximum = None
    for pattern in minimum_patterns:
        match = re.search(pattern, text)
        if match:
            minimum = int(match.group(1))
            break
    for pattern in maximum_patterns:
        match = re.search(pattern, text)
        if match:
            maximum = int(match.group(1))
            break
    return minimum, maximum


def normalize_age_evidence(item):
    normalized = dict(item)
    source = normalized.get("age_source")
    evidence = (normalized.get("age_evidence") or "").strip()
    evidence_url = (normalized.get("age_evidence_url") or "").strip()
    age_min = normalized.get("age_min")
    age_max = normalized.get("age_max")
    text_min, text_max = infer_explicit_age_from_text(normalized)
    if age_min is None and text_min is not None:
        age_min = text_min
    if age_max is None and text_max is not None:
        age_max = text_max
    has_concrete_age = age_min is not None or age_max is not None
    has_verified_evidence = bool(evidence and evidence_url and has_concrete_age)
    if source == "verified" and not has_verified_evidence:
        source = "inferred" if has_concrete_age else "unknown"
    elif source != "verified" and has_concrete_age and evidence and evidence_url:
        source = "verified"
    normalized["age_source"] = source
    normalized["age_min"] = age_min
    normalized["age_max"] = age_max
    normalized["age_evidence"] = evidence
    normalized["age_evidence_url"] = evidence_url
    return normalized


def normalize_travel_evidence(item):
    normalized = dict(item)
    source = normalized.get("travel_source") or "unknown"
    evidence = (normalized.get("travel_evidence") or "").strip()
    evidence_url = (normalized.get("travel_evidence_url") or "").strip()
    minutes = normalized.get("travel_minutes")
    distance = normalized.get("travel_distance_km")
    ferry = bool(normalized.get("travel_requires_ferry"))

    if minutes is not None:
        minutes = max(0, int(minutes))
    if distance is not None:
        distance = max(0.0, float(distance))

    if source == "verified" and not (evidence and evidence_url and minutes is not None):
        source = "inferred" if minutes is not None else "unknown"
    elif source != "verified" and evidence and evidence_url and minutes is not None:
        source = "verified"

    normalized["travel_source"] = source
    normalized["travel_evidence"] = evidence
    normalized["travel_evidence_url"] = evidence_url
    normalized["travel_minutes"] = minutes
    normalized["travel_distance_km"] = distance
    normalized["travel_requires_ferry"] = ferry
    return normalized


def age_filter_reason(item):
    if item.get("age_source") != "verified":
        return None
    age_min = item.get("age_min")
    age_max = item.get("age_max")
    for child_age in FAMILY_PROFILE["children_ages"]:
        if age_min is not None and child_age < age_min:
            return f"verificeret minimumsalder {age_min} udelukker barn på {child_age} år"
        if age_max is not None and child_age > age_max:
            return f"verificeret maksimumsalder {age_max} udelukker barn på {child_age} år"
    return None


def proximity_from_minutes(minutes):
    if minutes <= 20:
        return 100
    if minutes <= 35:
        return 94
    if minutes <= 50:
        return 88
    if minutes <= 65:
        return 82
    if minutes <= 80:
        return 74
    if minutes <= 100:
        return 66
    if minutes <= 120:
        return 56
    if minutes <= 150:
        return 44
    if minutes <= 180:
        return 32
    return 20


def fallback_proximity(city):
    normalized = normalize_key_text(city)
    for key, score in FALLBACK_CITY_PROXIMITY.items():
        if normalize_key_text(key) in normalized:
            return score
    return 45


def proximity_score(item):
    minutes = item.get("travel_minutes")
    if minutes is not None:
        score = proximity_from_minutes(minutes)
    else:
        score = fallback_proximity(item.get("city"))

    if item.get("travel_requires_ferry"):
        score = min(score, 15)
    return score


def age_match_score(item):
    source = item.get("age_source")
    if source == "verified":
        return 100
    if source == "inferred":
        return 82
    return 68


def evidence_score(item):
    score = 50
    if item.get("source_url"):
        score += 15
    if item.get("source"):
        score += 10
    if item.get("venue"):
        score += 5
    if item.get("why"):
        score += min(len(item["why"]), 3) * 2
    if item.get("age_source") == "verified" and item.get("age_evidence"):
        score += 10
    if item.get("travel_source") == "verified" and item.get("travel_evidence"):
        score += 4
    return min(score, 100)


def specialness_score(item):
    level = item.get("specialness_level") or "standard"
    score = SPECIALNESS_SCORES.get(level, SPECIALNESS_SCORES["standard"])
    if not item.get("special_event"):
        score = min(score, 60)
    return score


def add_family_fit(item):
    age_score = age_match_score(item)
    special_score = specialness_score(item)
    near_score = proximity_score(item)
    source_score = evidence_score(item)
    total = round(
        age_score * 0.35
        + special_score * 0.35
        + near_score * 0.20
        + source_score * 0.10
    )

    reasons = []
    if item.get("age_source") == "verified":
        reasons.append("Aldersmatch er verificeret med konkret kildeevidens")
    elif item.get("age_source") == "inferred":
        reasons.append("Aldersmatch er vurderet, men ikke eksplicit dokumenteret")
    else:
        reasons.append("Aldersmatch er ukendt")

    level_labels = {
        "exceptional": "Sjælden eller usædvanligt stærk oplevelse",
        "strong": "Tydeligt særlig og mindeværdig oplevelse",
        "good": "God familieoplevelse",
        "standard": "Mere almindelig oplevelse",
    }
    reasons.append(level_labels.get(item.get("specialness_level"), "Oplevelsesværdi vurderet"))

    minutes = item.get("travel_minutes")
    if item.get("travel_requires_ferry"):
        reasons.append("Færge gør turen markant mindre egnet som spontan udflugt")
    elif minutes is not None:
        if minutes <= 35:
            reasons.append(f"Ca. {minutes} min. kørsel fra Silkeborg")
        elif minutes <= 80:
            reasons.append(f"Ca. {minutes} min. kørsel – realistisk dagstur")
        elif minutes <= 120:
            reasons.append(f"Ca. {minutes} min. kørsel hver vej")
        else:
            reasons.append(f"Ca. {minutes} min. rejse hver vej trækker tydeligt ned")
    elif near_score >= 90:
        reasons.append("Meget tæt på Silkeborg")
    elif near_score >= 75:
        reasons.append("Rimelig dagstursafstand fra Silkeborg")
    elif near_score < 50:
        reasons.append("Lang transport trækker ned")

    enriched = dict(item)
    enriched["family_fit"] = {
        "score": total,
        "age": age_score,
        "specialness": special_score,
        "proximity": near_score,
        "evidence": source_score,
        "travel_minutes": minutes,
        "travel_distance_km": item.get("travel_distance_km"),
        "travel_requires_ferry": bool(item.get("travel_requires_ferry")),
        "explanation": reasons,
    }
    return enriched


def cluster_key(item):
    name = normalize_key_text(item.get("cluster_name"))
    if not name:
        return None
    return (name, normalize_key_text(item.get("city")))


def earliest_start(items):
    values = [item.get("start") for item in items if item.get("start")]
    return min(values) if values else ""


def latest_end(items):
    values = [item.get("end") for item in items if item.get("end")]
    return max(values) if values else ""


def representative_for_cluster(items):
    return max(
        items,
        key=lambda item: (
            normalize_key_text(item.get("event_type")) in {"festival", "familiefestival"},
            item.get("family_fit", {}).get("score", 0),
            richness_score(item),
        ),
    )


def cluster_results(results):
    clusters = {}
    singles = []
    for item in results:
        key = cluster_key(item)
        if key is None:
            singles.append(item)
            continue
        clusters.setdefault(key, []).append(item)

    clustered = list(singles)
    for items in clusters.values():
        if len(items) == 1:
            clustered.append(items[0])
            continue
        items = sorted(
            items,
            key=lambda value: (
                value.get("start") or "",
                -(value.get("family_fit", {}).get("score", 0)),
            ),
        )
        representative = dict(representative_for_cluster(items))
        representative["title"] = representative.get("cluster_name") or representative["title"]
        representative["start"] = earliest_start(items)
        representative["end"] = latest_end(items)
        representative["cluster_size"] = len(items)
        representative["cluster_items"] = [
            {
                "title": item.get("title"),
                "start": item.get("start"),
                "end": item.get("end"),
                "venue": item.get("venue"),
                "source_url": item.get("source_url"),
                "family_fit_score": item.get("family_fit", {}).get("score"),
            }
            for item in items
        ]
        best_score = max(item.get("family_fit", {}).get("score", 0) for item in items)
        representative["family_fit"] = dict(representative["family_fit"])
        representative["family_fit"]["score"] = best_score
        representative["family_fit"]["explanation"] = list(
            representative["family_fit"].get("explanation") or []
        ) + [f"Samler {len(items)} relevante aktiviteter under samme event"]
        clustered.append(representative)

    return sorted(
        clustered,
        key=lambda value: value.get("family_fit", {}).get("score", 0),
        reverse=True,
    )


def postprocess_results(results):
    normalized = [
        normalize_travel_evidence(normalize_age_evidence(item))
        for item in results
    ]
    deduped = dedupe_results(normalized)
    rejected = []
    eligible = []

    for item in deduped:
        reason = age_filter_reason(item)
        if reason:
            rejected.append(
                {
                    "title": item.get("title"),
                    "source_url": item.get("source_url"),
                    "age_evidence": item.get("age_evidence"),
                    "age_evidence_url": item.get("age_evidence_url"),
                    "reason": reason,
                }
            )
            continue
        eligible.append(add_family_fit(item))

    return {
        "deduped": deduped,
        "rejected": rejected,
        "results": cluster_results(eligible),
    }


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
    try:
        parsed = json.loads(extract_output_text(response_data))
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

    processed = postprocess_results(all_results)
    return {
        "provider": "openai",
        "model": model,
        "search_context": search_context,
        "segments": successful_segments,
        "response_ids": response_ids,
        "partial_errors": errors,
        "raw_result_count": len(all_results),
        "deduped_result_count": len(processed["deduped"]),
        "age_filtered_out_count": len(processed["rejected"]),
        "clustered_result_count": len(processed["results"]),
        "age_filtered_out": processed["rejected"],
        "results": processed["results"],
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


def run_self_test():
    incompatible = {
        "age_source": "verified",
        "age_min": 14,
        "age_max": None,
    }
    assert age_filter_reason(incompatible) is not None

    assert proximity_score(
        {"city": "Silkeborg", "travel_minutes": 12, "travel_requires_ferry": False}
    ) == 100
    assert proximity_score(
        {"city": "Jyderup", "travel_minutes": 165, "travel_requires_ferry": False}
    ) == 32
    assert proximity_score(
        {"city": "Samsø", "travel_minutes": 170, "travel_requires_ferry": True}
    ) == 15
    assert fallback_proximity("Samsø") == 12
    assert fallback_proximity("Jyderup") == 28

    print("SELF-TEST OK")
    print("age filter: verified 14+ candidate rejected")
    print("travel: Silkeborg=100, Jyderup=32, Samsø ferry=15")


def main():
    parser = argparse.ArgumentParser(
        description="POC collector for family experience discovery."
    )
    parser.add_argument("--from", dest="start_date", type=parse_date, help="Startdato YYYY-MM-DD")
    parser.add_argument("--to", dest="end_date", type=parse_date, help="Slutdato YYYY-MM-DD")
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
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Kør deterministiske tests af aldersfilter og travel score",
    )
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
        return 0

    if args.start_date is None or args.end_date is None:
        parser.error("--from og --to er påkrævet medmindre --self-test bruges")
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
