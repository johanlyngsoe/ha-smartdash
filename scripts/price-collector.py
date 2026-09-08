#!/usr/bin/env python3

import argparse
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests


BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / "data" / "price-collector.env"
DB_FILE = BASE_DIR / "data" / "prices.db"

ETILBUDSAVIS_URL = "https://api.etilbudsavis.dk/v2/offers/search"
LOCAL_TZ = ZoneInfo("Europe/Copenhagen")


def load_env():
    if not ENV_FILE.exists():
        raise RuntimeError(f"Mangler config: {ENV_FILE}")

    for raw_line in ENV_FILE.read_text().splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        os.environ[key.strip()] = value.strip()


def get_required_env(name):
    value = os.environ.get(name, "").strip()

    if not value:
        raise RuntimeError(f"Mangler {name} i {ENV_FILE}")

    return value


def parse_api_datetime(value):
    if not value:
        return None

    value = str(value).strip()

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        pass

    for fmt in (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S.%f%z",
    ):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue

    return None


def is_current_offer(offer):
    now = datetime.now(timezone.utc)

    start = parse_api_datetime(offer.get("run_from"))
    end = parse_api_datetime(offer.get("run_till"))

    if start and start.astimezone(timezone.utc) > now:
        return False

    if end and end.astimezone(timezone.utc) < now:
        return False

    return True


def get_ha_location(session, ha_url, ha_token):
    response = session.get(
        f"{ha_url.rstrip('/')}/api/config",
        headers={
            "Authorization": f"Bearer {ha_token}",
            "Accept": "application/json",
        },
        timeout=15,
    )
    response.raise_for_status()

    config = response.json()

    latitude = config.get("latitude")
    longitude = config.get("longitude")

    if latitude is None or longitude is None:
        raise RuntimeError("Home Assistant returnerede ingen gyldig lokation")

    return {
        "name": config.get("location_name"),
        "latitude": float(latitude),
        "longitude": float(longitude),
    }


def get_active_products(db):
    return db.execute(
        """
        SELECT id, name, search_term
        FROM monitored_products
        WHERE active = 1
        ORDER BY id
        """
    ).fetchall()


def search_offers(session, term, location, radius, limit):
    response = session.get(
        ETILBUDSAVIS_URL,
        params={
            "r_lat": location["latitude"],
            "r_lng": location["longitude"],
            "r_radius": radius,
            "r_locale": "da_DK",
            "api_av": "0.3.0",
            "query": term,
            "offset": 0,
            "limit": limit,
        },
        headers={"Accept": "application/json"},
        timeout=20,
    )
    response.raise_for_status()

    data = response.json()

    if not isinstance(data, list):
        raise RuntimeError(f"Uventet API-svar for {term!r}")

    return [offer for offer in data if is_current_offer(offer)]


def text_for_offer(offer):
    heading = str(offer.get("heading") or "")
    description = str(offer.get("description") or "")
    return f"{heading} {description}".casefold()


def classify_offer(product_name, offer):
    product = product_name.casefold()
    text = text_for_offer(offer)

    if product == "pasta":
        negatives = (
            "pastasalat",
            "færdigret",
            "gryderet",
            "dinner kit",
            "rejer",
            "laks",
            "fisk",
            "kalvekød",
        )

        if any(word in text for word in negatives):
            return "rejected"

        positives = (
            "pasta",
            "spaghetti",
            "fusilli",
            "penne",
            "farfalle",
            "fettuccine",
            "tagliatelle",
            "lasagneplader",
        )

        if any(word in text for word in positives):
            return "certain"

        return "rejected"

    if product == "hakket oksekød":
        negatives = (
            "grøntsag",
            "vegetar",
            "vegansk",
            "plante",
            "kylling",
            "svinekød",
            "gris",
        )

        if any(word in text for word in negatives):
            return "rejected"

        if "hakket" in text and "oksekød" in text:
            return "certain"

        return "possible"

    if product == "kærgården smør":
        if "kærgården" in text:
            return "certain"

        return "possible"

    search_words = [
        word
        for word in product.split()
        if len(word) >= 3
    ]

    if search_words and all(word in text for word in search_words):
        return "certain"

    return "possible"


def get_quantity(offer):
    quantity = offer.get("quantity") or {}

    size = quantity.get("size") or {}
    pieces = quantity.get("pieces") or {}
    unit = quantity.get("unit") or {}

    try:
        size_from = float(size.get("from"))
        size_to = float(size.get("to"))
        pieces_from = float(pieces.get("from", 1))
        pieces_to = float(pieces.get("to", pieces_from))
    except (TypeError, ValueError):
        return None, None, None

    if size_from <= 0 or pieces_from <= 0:
        return None, None, None

    if size_from != size_to or pieces_from != pieces_to:
        return None, None, None

    symbol = str(unit.get("symbol") or "").lower()
    total = size_from * pieces_from

    try:
        price = float((offer.get("pricing") or {}).get("price"))
    except (TypeError, ValueError):
        price = None

    if price is None or price <= 0:
        return total, symbol or None, None

    factors = {
        "g": ("kg", 0.001),
        "kg": ("kg", 1.0),
        "hg": ("kg", 0.1),
        "ml": ("liter", 0.001),
        "cl": ("liter", 0.01),
        "dl": ("liter", 0.1),
        "l": ("liter", 1.0),
    }

    factor = factors.get(symbol)

    if not factor:
        return total, symbol or None, None

    normalized_quantity = total * factor[1]

    if normalized_quantity <= 0:
        return total, symbol or None, None

    unit_price = price / normalized_quantity

    return total, symbol, unit_price


def observation_from_offer(product_id, product_name, offer, observed_at):
    pricing = offer.get("pricing") or {}
    branding = offer.get("branding") or {}

    try:
        price = float(pricing.get("price"))
    except (TypeError, ValueError):
        price = None

    quantity_value, quantity_unit, unit_price = get_quantity(offer)

    source_offer_id = str(offer.get("id") or "").strip()

    if not source_offer_id:
        raise RuntimeError(
            f"Tilbud mangler id: {offer.get('heading')!r}"
        )

    return {
        "monitored_product_id": product_id,
        "observed_at": observed_at.astimezone(timezone.utc).isoformat(),
        "observed_date": observed_at.astimezone(LOCAL_TZ).date().isoformat(),
        "source_offer_id": source_offer_id,
        "store": branding.get("name"),
        "heading": offer.get("heading"),
        "description": offer.get("description"),
        "price": price,
        "quantity_value": quantity_value,
        "quantity_unit": quantity_unit,
        "unit_price": unit_price,
        "offer_start": offer.get("run_from"),
        "offer_end": offer.get("run_till"),
        "classification": classify_offer(product_name, offer),
    }


def save_observation(db, observation):
    cursor = db.execute(
        """
        INSERT OR IGNORE INTO price_observations (
            monitored_product_id,
            observed_at,
            observed_date,
            source_offer_id,
            store,
            heading,
            description,
            price,
            quantity_value,
            quantity_unit,
            unit_price,
            offer_start,
            offer_end,
            classification
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            observation["monitored_product_id"],
            observation["observed_at"],
            observation["observed_date"],
            observation["source_offer_id"],
            observation["store"],
            observation["heading"],
            observation["description"],
            observation["price"],
            observation["quantity_value"],
            observation["quantity_unit"],
            observation["unit_price"],
            observation["offer_start"],
            observation["offer_end"],
            observation["classification"],
        ),
    )

    return cursor.rowcount == 1


def main():
    parser = argparse.ArgumentParser(
        description="SmartDash price collector"
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Gem observationer i databasen",
    )
    args = parser.parse_args()

    load_env()

    ha_url = get_required_env("HA_URL")
    ha_token = get_required_env("HA_TOKEN")

    radius = int(os.environ.get("OFFER_RADIUS", "10000"))
    limit = int(os.environ.get("OFFER_LIMIT", "20"))

    session = requests.Session()

    location = get_ha_location(
        session,
        ha_url,
        ha_token,
    )

    print(
        f"HA location: {location['name']} "
        f"({location['latitude']:.6f}, "
        f"{location['longitude']:.6f})"
    )
    print(f"Radius: {radius} m")
    print(f"Mode: {'WRITE' if args.write else 'DRY-RUN'}")
    print()

    db = sqlite3.connect(DB_FILE)

    try:
        products = get_active_products(db)

        if not products:
            print("Ingen aktive produkter.")
            return

        observed_at = datetime.now(timezone.utc)

        total_found = 0
        total_saved = 0

        for product_id, product_name, search_term in products:
            print("=" * 72)
            print(f"{product_name}  [search: {search_term}]")

            offers = search_offers(
                session,
                search_term,
                location,
                radius,
                limit,
            )

            print(f"Aktuelle resultater: {len(offers)}")

            counts = {
                "certain": 0,
                "possible": 0,
                "rejected": 0,
            }

            for offer in offers:
                observation = observation_from_offer(
                    product_id,
                    product_name,
                    offer,
                    observed_at,
                )

                classification = observation["classification"]
                counts[classification] += 1
                total_found += 1

                unit_price = observation["unit_price"]

                if unit_price is None:
                    unit_text = "-"
                else:
                    unit_text = f"{unit_price:.2f}/kg/l"

                price = observation["price"]
                price_text = "-" if price is None else f"{price:.2f} kr"

                print(
                    f"  {classification:8} | "
                    f"{observation['store'] or '-':12} | "
                    f"{price_text:10} | "
                    f"{unit_text:12} | "
                    f"{observation['heading'] or '-'}"
                )

                if args.write:
                    if save_observation(db, observation):
                        total_saved += 1

            print(
                "Klassifikation: "
                f"certain={counts['certain']}, "
                f"possible={counts['possible']}, "
                f"rejected={counts['rejected']}"
            )
            print()

        if args.write:
            db.commit()
            print(
                f"Færdig: {total_found} observationer fundet, "
                f"{total_saved} nye gemt."
            )
        else:
            print(
                f"DRY-RUN færdig: {total_found} observationer fundet. "
                "Intet er skrevet til databasen."
            )

    finally:
        db.close()


if __name__ == "__main__":
    main()
