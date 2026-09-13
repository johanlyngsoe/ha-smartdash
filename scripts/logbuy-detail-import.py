#!/usr/bin/env python3

"""Extract LogBuy supplier detail responses from a browser HAR.

This is deliberately an import-only tool: it does not replay credentials or call
LogBuy directly. Capture a HAR while opening a supplier/deal in LogBuy, then use
this script to retain only supplier-detail response payloads needed for local
benefit analysis. Request headers, cookies, tokens and form data are never copied.
"""

import argparse
import base64
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = BASE_DIR / "data" / "logbuy-supplier-details.json"
LOGBUY_API_HOST = "restapi.mylogbuy.com"


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"Mangler fil: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Ugyldig JSON i {path}: {exc}") from exc


def response_text(content):
    text = content.get("text")
    if text is None:
        return None
    if content.get("encoding") == "base64":
        try:
            return base64.b64decode(text).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            raise RuntimeError("Kunne ikke afkode base64-svar i HAR") from exc
    return text


def supplier_id_from_url(url):
    parts = urlsplit(url)
    path = parts.path

    match = re.search(r"/api/suppliers/(\d+)(?:/|$)", path, flags=re.IGNORECASE)
    if match:
        return int(match.group(1))

    query = parse_qs(parts.query)
    for key, values in query.items():
        if key.casefold() != "supplierid" or not values:
            continue
        try:
            return int(values[0])
        except (TypeError, ValueError):
            return None
    return None


def endpoint_kind(url):
    parts = urlsplit(url)
    path = parts.path.casefold()
    if "/api/suppliers/terms" in path:
        return "terms"
    if re.search(r"/api/suppliers/\d+/withaddresses", path):
        return "supplier_with_addresses"
    if re.search(r"/api/suppliers/\d+/info", path):
        return "supplier_info"
    if re.search(r"/api/suppliers/\d+", path):
        return "supplier_details"
    if "/api/suppliers/url" in path or "/api/suppliers/deallinkurl" in path:
        return "deal_url"
    return None


def decode_payload(text):
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def extract_supplier_details(har, supplier_ids=None):
    entries = ((har.get("log") or {}).get("entries") or []) if isinstance(har, dict) else []
    wanted = set(supplier_ids or [])
    results = []
    seen = set()

    for entry in entries:
        request = entry.get("request") or {}
        url = str(request.get("url") or "")
        parts = urlsplit(url)
        if (parts.hostname or "").casefold() != LOGBUY_API_HOST:
            continue

        kind = endpoint_kind(url)
        if kind is None:
            continue

        supplier_id = supplier_id_from_url(url)
        if wanted and supplier_id not in wanted:
            continue

        response = entry.get("response") or {}
        content = response.get("content") or {}
        text = response_text(content)
        if text is None:
            continue

        payload = decode_payload(text)
        fingerprint = (supplier_id, kind, url, text)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)

        results.append(
            {
                "supplier_info_id": supplier_id,
                "endpoint": kind,
                "url": url,
                "status": response.get("status"),
                "mime_type": content.get("mimeType"),
                "payload": payload,
            }
        )

    return results


def import_har(har, supplier_ids=None):
    responses = extract_supplier_details(har, supplier_ids=supplier_ids)
    suppliers = sorted(
        {item["supplier_info_id"] for item in responses if item.get("supplier_info_id") is not None}
    )
    return {
        "source_type": "har",
        "supplier_ids": suppliers,
        "response_count": len(responses),
        "responses": responses,
        "privacy_note": "Request headers, cookies, authorization tokens and request bodies are not copied.",
    }


def self_test():
    har = {
        "log": {
            "entries": [
                {
                    "request": {
                        "url": "https://restapi.mylogbuy.com/api/suppliers/21496?isLogClick=false"
                    },
                    "response": {
                        "status": 200,
                        "content": {
                            "mimeType": "application/json",
                            "text": json.dumps({"result": {"name": "Universe", "deals": [{"id": 7}]}}),
                        },
                    },
                },
                {
                    "request": {
                        "url": "https://restapi.mylogbuy.com/api/suppliers/terms?supplierId=21496&dealId=7"
                    },
                    "response": {
                        "status": 200,
                        "content": {
                            "mimeType": "application/json",
                            "text": json.dumps({"result": "Example terms"}),
                        },
                    },
                },
                {
                    "request": {
                        "url": "https://restapi.mylogbuy.com/api/browserExtension/activeDeals"
                    },
                    "response": {"status": 200, "content": {"text": "{}"}},
                },
            ]
        }
    }

    result = import_har(har, supplier_ids={21496})
    assert result["supplier_ids"] == [21496]
    assert result["response_count"] == 2
    assert {item["endpoint"] for item in result["responses"]} == {"supplier_details", "terms"}
    print("LOGBUY DETAIL IMPORT SELF-TEST OK")
    print("Universe supplier details + terms extracted; request credentials excluded")


def main():
    parser = argparse.ArgumentParser(description="Extract LogBuy supplier details from browser HAR")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--supplier-id", type=int, action="append", dest="supplier_ids")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0
    if not args.input:
        parser.error("--input er påkrævet medmindre --self-test bruges")

    har = load_json(args.input)
    if not isinstance(har, dict) or not isinstance(har.get("log"), dict):
        raise RuntimeError("Input skal være en browser HAR-fil")

    result = import_har(har, supplier_ids=set(args.supplier_ids or []))
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if args.write:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Skrevet: {args.output}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, AssertionError) as exc:
        print(f"FEJL: {exc}", file=sys.stderr)
        sys.exit(1)
