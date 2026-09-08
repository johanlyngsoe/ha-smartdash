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
            updated_at TEXT NOT NULL
        )
        "
    );

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
                updated_at
            FROM monitored_products
            WHERE active = 1
            ORDER BY name COLLATE NOCASE
            "
        )->fetchAll();

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
                updated_at
            )
            VALUES (
                :name,
                :normalized_name,
                :search_term,
                1,
                :created_at,
                :updated_at
            )
            ON CONFLICT(normalized_name) DO UPDATE SET
                name = excluded.name,
                search_term = excluded.search_term,
                active = 1,
                updated_at = excluded.updated_at
            "
        );

        $stmt->execute([
            ":name" => $name,
            ":normalized_name" => $normalizedName,
            ":search_term" => $searchTerm,
            ":created_at" => $now,
            ":updated_at" => $now,
        ]);

        $stmt = $db->prepare(
            "
            SELECT
                id,
                name,
                search_term,
                active,
                created_at,
                updated_at
            FROM monitored_products
            WHERE normalized_name = :normalized_name
            "
        );

        $stmt->execute([
            ":normalized_name" => $normalizedName,
        ]);

        respond([
            "success" => true,
            "product" => $stmt->fetch(),
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
