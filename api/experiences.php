<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$baseDir = dirname(__DIR__);
$candidates = [
    $baseDir . '/data/experiences-enriched.json',
    $baseDir . '/data/experiences-poc.json',
];

$source = null;
foreach ($candidates as $candidate) {
    if (is_file($candidate)) {
        $source = $candidate;
        break;
    }
}

if ($source === null) {
    http_response_code(404);
    echo json_encode([
        'ok' => false,
        'error' => 'Ingen oplevelsesdata fundet. Kør experience collector/enrichment først.'
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$raw = file_get_contents($source);
if ($raw === false) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Kunne ikke læse oplevelsesdata.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$data = json_decode($raw, true);
if (!is_array($data) || !isset($data['results']) || !is_array($data['results'])) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Oplevelsesdata har ugyldigt format.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$results = array_values(array_filter($data['results'], static function ($item) {
    return is_array($item) && !empty($item['title']);
}));

echo json_encode([
    'ok' => true,
    'source' => basename($source),
    'generated_at' => $data['generated_at'] ?? $data['created_at'] ?? null,
    'benefit_enrichment' => $data['benefit_enrichment'] ?? null,
    'results' => $results,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
