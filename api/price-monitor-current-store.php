<?php

header("Content-Type: application/json; charset=utf-8");

$dataDir = __DIR__ . "/../data";
$dbFile = $dataDir . "/prices.db";

function respond($payload, $status = 200) {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    if (!is_file($dbFile)) {
        respond(["stores" => []]);
    }

    $db = new PDO(
        "sqlite:" . $dbFile,
        null,
        null,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );

    $periodDays = 28;
    $localTimezone = new DateTimeZone("Europe/Copenhagen");
    $periodStart = (new DateTimeImmutable("now", $localTimezone))
        ->modify("-" . ($periodDays - 1) . " days")
        ->format("Y-m-d");

    $products = $db->query(
        "SELECT id, statistics_from_date FROM monitored_products WHERE active = 1"
    )->fetchAll();

    $unitsStmt = $db->prepare(
        "
        SELECT DISTINCT
            CASE
                WHEN lower(quantity_unit) IN ('g', 'kg', 'hg') THEN 'kg'
                WHEN lower(quantity_unit) IN ('ml', 'cl', 'dl', 'l') THEN 'liter'
                ELSE NULL
            END AS statistic_unit
        FROM price_observations
        WHERE monitored_product_id = :product_id
          AND observed_date >= :start_date
          AND classification = 'certain'
          AND unit_price IS NOT NULL
        "
    );

    $latestStmt = $db->prepare(
        "
        SELECT
            store,
            heading,
            observed_date,
            unit_price
        FROM price_observations
        WHERE monitored_product_id = :product_id
          AND observed_date = (
              SELECT MAX(observed_date)
              FROM price_observations
              WHERE monitored_product_id = :product_id_inner
                AND observed_date >= :start_date
                AND classification = 'certain'
                AND unit_price IS NOT NULL
                AND CASE
                    WHEN lower(quantity_unit) IN ('g', 'kg', 'hg') THEN 'kg'
                    WHEN lower(quantity_unit) IN ('ml', 'cl', 'dl', 'l') THEN 'liter'
                    ELSE NULL
                END = :statistic_unit_inner
          )
          AND classification = 'certain'
          AND unit_price IS NOT NULL
          AND CASE
              WHEN lower(quantity_unit) IN ('g', 'kg', 'hg') THEN 'kg'
              WHEN lower(quantity_unit) IN ('ml', 'cl', 'dl', 'l') THEN 'liter'
              ELSE NULL
          END = :statistic_unit
        ORDER BY unit_price ASC, id DESC
        LIMIT 1
        "
    );

    $result = [];

    foreach ($products as $product) {
        $effectiveStart = $periodStart;
        $customStart = trim((string)($product['statistics_from_date'] ?? ''));
        if ($customStart !== '' && $customStart > $effectiveStart) {
            $effectiveStart = $customStart;
        }

        $unitsStmt->execute([
            ':product_id' => (int)$product['id'],
            ':start_date' => $effectiveStart,
        ]);

        $units = array_values(array_filter(array_map(
            fn($row) => $row['statistic_unit'] ?? null,
            $unitsStmt->fetchAll()
        )));
        $units = array_values(array_unique($units));

        if (count($units) !== 1) {
            continue;
        }

        $unit = $units[0];
        $latestStmt->execute([
            ':product_id' => (int)$product['id'],
            ':product_id_inner' => (int)$product['id'],
            ':start_date' => $effectiveStart,
            ':statistic_unit_inner' => $unit,
            ':statistic_unit' => $unit,
        ]);

        $row = $latestStmt->fetch();
        if (!$row) {
            continue;
        }

        $result[(string)$product['id']] = [
            'store' => $row['store'] ?: null,
            'heading' => $row['heading'] ?: null,
            'observed_date' => $row['observed_date'] ?: null,
            'unit_price' => $row['unit_price'] !== null ? (float)$row['unit_price'] : null,
            'unit' => $unit,
        ];
    }

    respond(["stores" => $result]);
} catch (Throwable $e) {
    respond([
        "error" => "database_error",
        "message" => $e->getMessage(),
    ], 500);
}
