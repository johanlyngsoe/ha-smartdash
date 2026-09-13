#!/usr/bin/env python3

"""Enrich ranked SmartDash experiences with family benefit programmes.

Discovery/Experience Score is never changed here. This stage validates price data,
adds benefit matches, effective family price and a separate Value Score.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
CONFIG_FILE = BASE_DIR / "config" / "experience-benefits.json"
DEFAULT_INPUT = DATA_DIR / "experiences-poc.json"
DEFAULT_OUTPUT = DATA_DIR / "experiences-enriched.json"
LOGBUY_ACTIVE_DEALS = DATA_DIR / "logbuy-active-deals.json"

LOGBUY_GENERIC_LABELS = {
    "shop", "store", "online", "billet", "billetter", "booking", "event", "events",
    "park", "huset", "house", "center", "centret", "danmark", "denmark", "mini",
    "museum", "museet", "ticket", "tickets", "visit", "official", "web", "www",
}


def normalize_text(value):
    value = (value or "").casefold()
    value = re.sub(r"[^a-z0-9æøå]+", " ", value)
    return " ".join(value.split())


def event_match_text(item):
    return normalize_text(" ".join(str(item.get(f) or "") for f in ("title", "venue", "city", "source")))


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"Mangler fil: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Ugyldig JSON i {path}: {exc}") from exc


def program_holder_count(program):
    if program.get("id") == "djurs-season-pass-2026":
        raw = os.environ.get("DJURS_SEASON_PASS_HOLDERS", "").strip()
        if raw:
            try:
                return max(0, int(raw))
            except ValueError as exc:
                raise RuntimeError("DJURS_SEASON_PASS_HOLDERS skal være et heltal") from exc
    return max(0, int(program.get("holder_count") or 0))


def active_for_event(program, item):
    event_date = (item.get("start") or "")[:10]
    if not event_date:
        return True
    return (program.get("valid_from") or "0000-01-01") <= event_date <= (program.get("valid_to") or "9999-12-31")


def match_catalog_benefits(item, catalog):
    text = normalize_text(" ".join(str(item.get(f) or "") for f in ("title", "venue", "city", "source", "source_url")))
    matches = []
    for program in catalog.get("programs", []):
        if not program.get("owned") or not active_for_event(program, item):
            continue
        holders = program_holder_count(program)
        for benefit in program.get("benefits", []):
            terms = [normalize_text(v) for v in benefit.get("match_terms", [])]
            if not any(term and term in text for term in terms):
                continue
            matches.append({
                "program_id": program.get("id"), "program": program.get("name"),
                "venue": benefit.get("venue"), "type": benefit.get("type"),
                "discount_pct": benefit.get("discount_pct"), "holder_count": holders,
                "source_url": program.get("source_url"), "verified": True,
            })
    return matches


def parse_logbuy_deals():
    if not LOGBUY_ACTIVE_DEALS.exists():
        return []
    payload = load_json(LOGBUY_ACTIVE_DEALS)
    deals = payload if isinstance(payload, list) else ((payload.get("result") or {}).get("deals") or payload.get("deals") or [])
    output = []
    for deal in deals:
        if not isinstance(deal, dict):
            continue
        website = str(deal.get("website") or "").strip()
        detailurl = str(deal.get("detailurl") or "").strip()
        supplier_id = str(deal.get("supplier_info_id") or "").strip() or None
        if website or detailurl:
            output.append({"supplier_info_id": supplier_id, "website": website, "detailurl": detailurl})
    return output


def normalized_host(url_or_domain):
    value = (url_or_domain or "").strip()
    if not value:
        return ""
    if "://" not in value:
        value = "https://" + value
    try:
        host = (urlsplit(value).hostname or "").casefold()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def host_matches(left, right):
    """Exact/subdomain host match; never token-intersection matching."""
    a, b = normalized_host(left), normalized_host(right)
    if not a or not b:
        return False
    return a == b or a.endswith("." + b) or b.endswith("." + a)


def domain_label(website):
    host = normalized_host(website)
    if not host:
        return ""
    labels = host.split(".")
    return labels[-2] if len(labels) >= 2 else labels[0]


def strong_name_match(item, website):
    """Allow a domain-name match only for a distinctive label present as a whole word."""
    label = normalize_text(domain_label(website))
    if not label or len(label) < 6 or label in LOGBUY_GENERIC_LABELS:
        return False
    text_words = set(event_match_text(item).split())
    return label in text_words


def match_logbuy(item, deals):
    matches = []
    source_url = item.get("source_url")
    for deal in deals:
        website = deal.get("website")
        exact_domain = host_matches(source_url, website)
        distinctive_name = strong_name_match(item, website)
        if not (exact_domain or distinctive_name):
            continue
        matches.append({
            "program": "Visma LogBuy", "type": "possible_deal",
            "supplier_info_id": deal.get("supplier_info_id"),
            "website": website, "detailurl": deal.get("detailurl"),
            "match_method": "domain" if exact_domain else "distinctive_name",
            "verified": False,
            "note": "Aktiv LogBuy-aftale fundet; rabatens størrelse/vilkår skal hentes fra aftaledetaljen før prisberegning.",
        })
    return matches


def parse_danish_number(value):
    return float(str(value).replace(".", "").replace(",", "."))


def explicit_price_equation(price_note):
    text = (price_note or "").replace("*", "×")
    equation = re.search(
        r"(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(?:kr\.?)?\s*\+\s*"
        r"(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(?:kr\.?)?"
        r"(?:\s*=\s*(\d+(?:[.,]\d+)?)\s*(?:kr\.?)?)?", text, flags=re.IGNORECASE,
    )
    if not equation:
        return None
    count_a, price_a, count_b, price_b, stated = equation.groups()
    computed = int(count_a) * parse_danish_number(price_a) + int(count_b) * parse_danish_number(price_b)
    stated_value = parse_danish_number(stated) if stated else None
    return {"computed": round(computed, 2), "stated": round(stated_value, 2) if stated_value is not None else None, "expression": equation.group(0)}


def validate_family_price(item):
    raw = item.get("price_family")
    try:
        raw_value = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        raw_value = None
    equation = explicit_price_equation(item.get("price_note"))
    if equation is None:
        return {"status": "unverified" if raw_value is not None else "unknown", "original": raw_value, "validated": raw_value, "reason": "Ingen deterministisk prisformel fundet i price_note."}
    computed, stated = equation["computed"], equation["stated"]
    inconsistencies = []
    if raw_value is not None and abs(raw_value - computed) > 0.01:
        inconsistencies.append(f"price_family={raw_value:g} afviger fra beregnet {computed:g}")
    if stated is not None and abs(stated - computed) > 0.01:
        inconsistencies.append(f"angivet sum={stated:g} afviger fra beregnet {computed:g}")
    return {"status": "corrected" if inconsistencies else "verified", "original": raw_value, "validated": computed, "reason": "; ".join(inconsistencies) if inconsistencies else "Prisformlen stemmer matematisk.", "expression": equation["expression"]}


def best_price(normal, benefit_matches):
    if normal is None:
        return None, None, None
    try:
        normal = float(normal)
    except (TypeError, ValueError):
        return None, None, None
    best_effective, best_saving, best_match = normal, 0.0, None
    family_size = 4
    for match in benefit_matches:
        pct = match.get("discount_pct")
        holders = min(max(int(match.get("holder_count") or 0), 0), family_size)
        if pct is None or holders <= 0:
            continue
        saving = normal * (float(pct) / 100.0) * (holders / family_size)
        effective = max(0.0, normal - saving)
        if effective < best_effective:
            best_effective, best_saving, best_match = effective, saving, match
    return round(best_effective, 2), round(best_saving, 2), best_match


def value_score(normal_price, effective_price, saving):
    if effective_price is None:
        return None
    if effective_price <= 0:
        return 100
    affordability = max(0.0, 100.0 - min(effective_price, 1200.0) / 12.0)
    saving_pct = min(100.0, (saving / normal_price) * 100.0) if normal_price and normal_price > 0 and saving else 0.0
    return round(affordability * 0.55 + saving_pct * 0.45)


def enrich_item(item, catalog, logbuy_deals):
    enriched = dict(item)
    catalog_matches = match_catalog_benefits(item, catalog)
    logbuy_matches = match_logbuy(item, logbuy_deals)
    validation = validate_family_price(item)
    normal = validation["validated"]
    effective, saving, applied = best_price(normal, catalog_matches)
    enriched["benefits"] = catalog_matches + logbuy_matches
    enriched["value"] = {
        "normal_family_price": normal, "effective_family_price": effective, "saving": saving,
        "score": value_score(normal, effective, saving),
        "applied_program": applied.get("program") if applied else None,
        "applied_discount_pct": applied.get("discount_pct") if applied else None,
        "price_validation": validation,
        "note": "Experience Score er uændret; Value Score vurderer kun valideret pris/besparelse.",
    }
    return enriched


def self_test(catalog):
    universe = {"title": "Mini Spionerne", "venue": "Universe Science Park", "city": "Nordborg", "source": "Universe Science Park", "source_url": "https://universe.dk/oplevelser/events/mini-spionerne/", "start": "2026-09-19T10:00:00+02:00", "price_family": 740, "price_note": "4 × 185 = 740 kr."}
    catalog_matches = match_catalog_benefits(universe, catalog)
    validation = validate_family_price(universe)
    effective, saving, applied = best_price(validation["validated"], catalog_matches)
    assert applied and applied["discount_pct"] == 50 and effective == 370.0 and saving == 370.0
    logbuy = [{"supplier_info_id": "21496", "website": "https://universe.dk", "detailurl": "https://mylogbuy.example/?SupplierInfoId=21496"}, {"supplier_info_id": "22196", "website": "https://www.q-park.dk/da", "detailurl": "x"}, {"supplier_info_id": "349", "website": "https://mini-lease.dk/", "detailurl": "y"}]
    matches = match_logbuy(universe, logbuy)
    assert len(matches) == 1 and matches[0]["supplier_info_id"] == "21496"
    skraldival = {"title": "Skraldival 2026", "venue": "Silkeborg Bibliotek", "city": "Silkeborg", "source": "Silkeborg Bibliotekerne", "source_url": "https://silkeborgbib.dk/arrangementer/skraldival"}
    noisy = [{"supplier_info_id": "19088", "website": "https://shop.zoo.dk/da/billetter", "detailurl": "x"}, {"supplier_info_id": "19457", "website": "https://shop.tivoli.dk/da/login/logbuyaps", "detailurl": "y"}]
    assert match_logbuy(skraldival, noisy) == []
    solfestival = {"price_family": 315, "price_note": "Voksne 125 kr. hver og børn under 12 år 65 kr. hver; 2 × 125 + 2 × 65 = 380 kr."}
    validation = validate_family_price(solfestival)
    assert validation["status"] == "corrected" and validation["validated"] == 380.0
    print("BENEFIT SELF-TEST OK")
    print("Universe: only universe.dk LogBuy deal matched; Q-Park/Mini-Lease rejected")
    print("Skraldival: unrelated LogBuy deals rejected")
    print("Price validation: Solfestival 315 kr corrected to 380 kr")


def main():
    parser = argparse.ArgumentParser(description="Enrich experiences with benefits and Value Score")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    catalog = load_json(CONFIG_FILE)
    if args.self_test:
        self_test(catalog); return 0
    payload = load_json(args.input)
    results = payload.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"{args.input} mangler results-listen")
    logbuy_deals = parse_logbuy_deals()
    enriched = [enrich_item(item, catalog, logbuy_deals) for item in results]
    enriched.sort(key=lambda item: (item.get("family_fit", {}).get("score", 0), item.get("value", {}).get("score") if item.get("value", {}).get("score") is not None else -1), reverse=True)
    corrected = sum(item.get("value", {}).get("price_validation", {}).get("status") == "corrected" for item in enriched)
    possible = sum(any(b.get("program") == "Visma LogBuy" for b in item.get("benefits", [])) for item in enriched)
    output = dict(payload)
    output["benefit_enrichment"] = {"catalog": str(CONFIG_FILE.relative_to(BASE_DIR)), "logbuy_active_deals_loaded": len(logbuy_deals), "logbuy_possible_matches": possible, "price_corrections": corrected, "djurs_pass_holders": program_holder_count(catalog["programs"][0])}
    output["results"] = enriched
    print(json.dumps(output, ensure_ascii=False, indent=2))
    if args.write:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Skrevet: {args.output}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, AssertionError) as exc:
        print(f"FEJL: {exc}", file=sys.stderr); sys.exit(1)
