<?php

header("Content-Type: application/json; charset=utf-8");

$dataDir = __DIR__ . "/../data";
$dbFile = $dataDir . "/prices.db";

if (!is_dir($dataDir)) {
    mkdir($dataDir, 0775, true);
}

function respond($payload, $status = 200) {
    http_response_code($status);
    echo json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );
    exit;
}

function normalizeName($value) {
    $value = trim((string)$value);
    $value = preg_replace('/\s+/u', ' ', $value);
    return $value;
}

function normalizeTerms($value) {
    if (is_string($value)) {
        $value = preg_split('/[,\n]+/u', $value);
    }

    if (!is_array($value)) {
        return [];
    }

    $result = [];
    $seen = [];

    foreach ($value as $term) {
        $term = normalizeName($term);
        if ($term === '') {
            continue;
        }

        $key = mb_strtolower($term, 'UTF-8');
        if (isset($seen[$key])) {
            continue;
        }

        $seen[$key] = true;
        $result[] = $term;
    }

    return $result;
}

function encodeTerms($terms) {
    return json_encode(
        normalizeTerms($terms),
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );
}

function decodeTerms($value) {
    if ($value === null || $value === '') {
        return [];
    }

    $decoded = json_decode((string)$value, true);
    return normalizeTerms(is_array($decoded) ? $decoded : []);
}

function addRuleColumns(PDO $db) {
    $columns = [];
    foreach ($db->query("PRAGMA table_info(monitored_products)")->fetchAll() as $column) {
        $columns[$column['name']] = true;
    }

    $definitions = [
        'include_any' => "TEXT NOT NULL DEFAULT '[]'",
        'include_all' => "TEXT NOT NULL DEFAULT '[]'",
        'exclude_any' => "TEXT NOT NULL DEFAULT '[]'",
    ];

    foreach ($definitions as $name => $definition) {
        if (!isset($columns[$name])) {
            $db->exec("ALTER TABLE monitored_products ADD COLUMN {$name} {$definition}");
        }
    }
}

function presentProduct($row) {
    if (!$row) {
        return $row;
    }

    $row['include_any'] = decodeTerms($row['include_any'] ?? null);
    $row['include_all'] = decodeTerms($row['include_all'] ?? null);
    $row['exclude_any'] = decodeTerms($row['exclude_any'] ?? null);
    return $row;
}

try {
    $db = new PDO(
        "sqlite:" . $dbFile,
        null,
        null,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );

    $db->exec("PRAGMA journal_mode = WAL");
    $db->exec("PRAGMA foreign_keys = ON");

    $db->exec(
        "
        CREATE TABLE IF NOT EXISTS monitored_products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL UNIQUE,
            search_term TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            include_any TEXT NOT NULL DEFAULT '[]',
            include_all TEXT NOT NULL DEFAULT '[]',
            exclude_any TEXT NOT NULL DEFAULT '[]'
        )
        "
    );

    addRuleColumns($db);

    $db->exec(
        "
        CREATE TABLE IF NOT EXISTS price_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            monitored_product_id INTEGER NOT NULL,
            observed_at TEXT NOT NULL,
            observed_date TEXT NOT NULL,
            source_offer_id TEXT NOT NULL,
            store TEXT,
            heading TEXT,
            description TEXT,
            price REAL,
            quantity_value REAL,
            quantity_unit TEXT,
            unit_price REAL,
            offer_start TEXT,
            offer_end TEXT,
            classification TEXT,
            FOREIGN KEY(monitored_product_id)
                REFERENCES monitored_products(id),
            UNIQUE(
                monitored_product_id,
                observed_date,
                source_offer_id
            )
        )
        "
    );

    $db->exec(
        "
        CREATE INDEX IF NOT EXISTS idx_price_observations_product_date
        ON price_observations(monitored_product_id, observed_date)
        "
    );

    $method = $_SERVER["REQUEST_METHOD"] ?? "GET";

    if ($method === "GET") {
        $rows = $db->query(
            "
            SELECT
                id,
                name,
                search_term,
                active,
                created_at,
                updated_at,
                include_any,
                include_all,
                exclude_any
            FROM monitored_products
            WHERE active = 1
            ORDER BY name COLLATE NOCASE
            "
        )->fetchAll();

        $periodDays = 28;
        $localTimezone = new DateTimeZone("Europe/Copenhagen");
        $startDate = (new DateTimeImmutable("now", $localTimezone))
            ->modify("-" . ($periodDays - 1) . " days")
            ->format("Y-m-d");

        $statStmt = $db->prepare(
            "
            SELECT
                observed_date,
                CASE
                    WHEN lower(quantity_unit) IN ('g', 'kg', 'hg') THEN 'kg'
                    WHEN lower(quantity_unit) IN ('ml', 'cl', 'dl', 'l') THEN 'liter'
                    ELSE NULL
                END AS statistic_unit,
                MIN(unit_price) AS daily_best
            FROM price_observations
            WHERE monitored_product_id = :product_id
              AND observed_date >= :start_date
              AND classification = 'certain'
              AND unit_price IS NOT NULL
            GROUP BY
                observed_date,
                statistic_unit
            HAVING statistic_unit IS NOT NULL
            ORDER BY observed_date
            "
        );

        foreach ($rows as &$row) {
            $row = presentProduct($row);

            $statStmt->execute([
                ":product_id" => (int)$row["id"],
                ":start_date" => $startDate,
            ]);

            $dailyRows = $statStmt->fetchAll();
            $units = [];

            foreach ($dailyRows as $dailyRow) {
                $unit = (string)($dailyRow["statistic_unit"] ?? "");
                if ($unit !== "") {
                    $units[$unit] = true;
                }
            }

            $statistics = [
                "period_days" => $periodDays,
                "days" => 0,
                "unit" => null,
                "latest" => null,
                "latest_date" => null,
                "average" => null,
                "lowest" => null,
                "highest" => null,
            ];

            if (count($units) === 1) {
                $unit = array_key_first($units);
                $dailyPrices = [];
                $latestDate = null;
                $latestPrice = null;

                foreach ($dailyRows as $dailyRow) {
                    if (($dailyRow["statistic_unit"] ?? null) !== $unit) {
                        continue;
                    }

                    $price = (float)$dailyRow["daily_best"];
                    $dailyPrices[] = $price;
                    $latestDate = $dailyRow["observed_date"];
                    $latestPrice = $price;
                }

                if ($dailyPrices) {
                    $statistics = [
                        "period_days" => $periodDays,
                        "days" => count($dailyPrices),
                        "unit" => $unit,
                        "latest" => $latestPrice,
                        "latest_date" => $latestDate,
                        "average" => array_sum($dailyPrices) / count($dailyPrices),
                        "lowest" => min($dailyPrices),
                        "highest" => max($dailyPrices),
                    ];
                }
            }

            $row["statistics"] = $statistics;
        }
        unset($row);

        respond([
            "products" => $rows,
        ]);
    }

    if ($method === "POST") {
        $body = json_decode(
            file_get_contents("php://input"),
            true
        );

        if (!is_array($body)) {
            respond(["error" => "invalid_json"], 400);
        }

        $name = normalizeName($body["name"] ?? "");
        $searchTerm = normalizeName(
            $body["search_term"] ?? $name
        );

        if ($name === "" || $searchTerm === "") {
            respond(["error" => "name_required"], 400);
        }

        $includeAny = normalizeTerms($body['include_any'] ?? []);
        $includeAll = normalizeTerms($body['include_all'] ?? []);
        $excludeAny = normalizeTerms($body['exclude_any'] ?? []);

        $normalizedName = mb_strtolower($name, "UTF-8");
        $now = gmdate("c");

        $stmt = $db->prepare(
            "
            INSERT INTO monitored_products (
                name,
                normalized_name,
                search_term,
                active,
                created_at,
                updated_at,
                include_any,
                include_all,
                exclude_any
            )
            VALUES (
                :name,
                :normalized_name,
                :search_term,
                1,
                :created_at,
                :updated_at,
                :include_any,
                :include_all,
                :exclude_any
            )
            ON CONFLICT(normalized_name) DO UPDATE SET
                name = excluded.name,
                search_term = excluded.search_term,
                active = 1,
                updated_at = excluded.updated_at,
                include_any = excluded.include_any,
                include_all = excluded.include_all,
                exclude_any = excluded.exclude_any
            "
        );

        $stmt->execute([
            ":name" => $name,
            ":normalized_name" => $normalizedName,
            ":search_term" => $searchTerm,
            ":created_at" => $now,
            ":updated_at" => $now,
            ":include_any" => encodeTerms($includeAny),
            ":include_all" => encodeTerms($includeAll),
            ":exclude_any" => encodeTerms($excludeAny),
        ]);

        $stmt = $db->prepare(
            "
            SELECT
                id,
                name,
                search_term,
                active,
                created_at,
                updated_at,
                include_any,
                include_all,
                exclude_any
            FROM monitored_products
            WHERE normalized_name = :normalized_name
            "
        );

        $stmt->execute([
            ":normalized_name" => $normalizedName,
        ]);

        respond([
            "success" => true,
            "product" => presentProduct($stmt->fetch()),
        ]);
    }

    if ($method === "DELETE") {
        $body = json_decode(
            file_get_contents("php://input"),
            true
        );

        if (!is_array($body)) {
            respond(["error" => "invalid_json"], 400);
        }

        $id = (int)($body["id"] ?? 0);

        if ($id <= 0) {
            respond(["error" => "id_required"], 400);
        }

        $stmt = $db->prepare(
            "
            UPDATE monitored_products
            SET
                active = 0,
                updated_at = :updated_at
            WHERE id = :id
            "
        );

        $stmt->execute([
            ":id" => $id,
            ":updated_at" => gmdate("c"),
        ]);

        respond([
            "success" => true,
        ]);
    }

    respond(["error" => "method_not_allowed"], 405);

} catch (Throwable $e) {
    respond([
        "error" => "database_error",
        "message" => $e->getMessage(),
    ], 500);
}
