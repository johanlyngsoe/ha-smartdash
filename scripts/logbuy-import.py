#!/usr/bin/env python3

"""Normalize a local Visma LogBuy activeDeals export for experience enrichment.

Supports either a JSON activeDeals response or a browser HAR containing it.
Normalized output contains only deal routing data; credentials/tokens are never copied.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = BASE_DIR / "data" / "logbuy-active-deals.json"


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"Mangler fil: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Ugyldig JSON i {path}: {exc}") from exc


def extract_deals(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    result = payload.get("result")
    if isinstance(result, dict) and isinstance(result.get("deals"), list):
        return result["deals"]
    if isinstance(payload.get("deals"), list):
        return payload["deals"]
    return []


def deals_from_har(payload):
    entries = ((payload.get("log") or {}).get("entries") or []) if isinstance(payload, dict) else []
    deals = []
    matched_responses = 0
    for entry in entries:
        request = entry.get("request") or {}
        if "/api/browserExtension/activeDeals" not in str(request.get("url") or ""):
            continue
        text = (((entry.get("response") or {}).get("content") or {}).get("text"))
        if not text:
            continue
        try:
            response_payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        matched_responses += 1
        deals.extend(extract_deals(response_payload))
    return deals, matched_responses


def supplier_info_id(detailurl):
    try:
        query = parse_qs(urlsplit(detailurl or "").query)
    except ValueError:
        return None
    for key, values in query.items():
        if key.casefold() == "supplierinfoid" and values:
            value = str(values[0]).strip()
            return value if re.fullmatch(r"\d+", value) else None
    return None


def normalize_deals(deals):
    """Deduplicate snapshots by SupplierInfoId, ignoring customer-specific detail URLs."""
    output = []
    seen = set()
    for deal in deals:
        if not isinstance(deal, dict):
            continue
        website = str(deal.get("website") or "").strip()
        detailurl = str(deal.get("detailurl") or "").strip()
        if not website and not detailurl:
            continue
        supplier_id = supplier_info_id(detailurl)
        if supplier_id:
            key = ("supplier", supplier_id)
        else:
            key = ("fallback", website.casefold(), detailurl.casefold())
        if key in seen:
            continue
        seen.add(key)
        output.append(
            {
                "supplier_info_id": supplier_id,
                "website": website,
                "detailurl": detailurl,
            }
        )
    return output


def import_payload(payload):
    if isinstance(payload, dict) and isinstance(payload.get("log"), dict):
        deals, responses = deals_from_har(payload)
        source_type = "har"
    else:
        deals = extract_deals(payload)
        responses = 1 if deals else 0
        source_type = "json"
    normalized = normalize_deals(deals)
    return {
        "source_type": source_type,
        "active_deal_responses": responses,
        "deal_count": len(normalized),
        "deals": normalized,
    }


def self_test():
    payload = {
        "statusCode": 200,
        "result": {
            "deals": [
                {
                    "website": "https://universe.dk",
                    "detailurl": "https://www.mylogbuy.com/WebPages/ShowDeal/Default.aspx?SupplierInfoId=21496&CustomerId=101023",
                },
                {
                    "website": "https://universe.dk",
                    "detailurl": "https://www.mylogbuy.com/WebPages/ShowDeal/Default.aspx?SupplierInfoId=21496&CustomerId=57566",
                },
            ]
        },
    }
    result = import_payload(payload)
    assert result["deal_count"] == 1
    assert result["deals"][0]["supplier_info_id"] == "21496"
    assert "CustomerId" in result["deals"][0]["detailurl"]
    assert set(result["deals"][0]) == {"supplier_info_id", "website", "detailurl"}
    print("LOGBUY IMPORT SELF-TEST OK")
    print("Customer-specific snapshots deduplicated by SupplierInfoId; no credentials copied")


def main():
    parser = argparse.ArgumentParser(description="Normalize LogBuy activeDeals JSON/HAR")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0
    if not args.input:
        parser.error("--input er påkrævet medmindre --self-test bruges")

    payload = load_json(args.input)
    result = import_payload(payload)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.write:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps({"deals": result["deals"]}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"Skrevet: {args.output}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, AssertionError) as exc:
        print(f"FEJL: {exc}", file=sys.stderr)
        sys.exit(1)
