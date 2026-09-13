<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$baseDir = dirname(__DIR__);
$dataDir = $baseDir . '/data';
$statusFile = $dataDir . '/experience-refresh-status.json';
$requestFile = $dataDir . '/experience-refresh-request.json';
$requestRunningFile = $requestFile . '.running';

function readJsonFile(string $file, array $fallback): array {
    if (!is_file($file)) return $fallback;
    $raw = @file_get_contents($file);
    $data = $raw !== false ? json_decode($raw, true) : null;
    return is_array($data) ? $data : $fallback;
}

function readStatus(string $statusFile, string $requestFile, string $requestRunningFile): array {
    $status = readJsonFile($statusFile, []);
    if (($status['state'] ?? '') === 'running') return $status;
    if (is_file($requestFile) || is_file($requestRunningFile)) {
        $request = readJsonFile(is_file($requestFile) ? $requestFile : $requestRunningFile, []);
        return [
            'state' => 'queued',
            'progress' => 4,
            'message' => 'Opdatering er sat i kø på TrueNAS',
            'requested_at' => $request['requested_at'] ?? null,
            'mode' => $request['mode'] ?? null,
            'days' => $request['days'] ?? null,
        ];
    }
    return $status ?: ['state' => 'idle', 'message' => 'Klar til opdatering'];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo json_encode(['ok' => true, 'status' => readStatus($statusFile, $requestFile, $requestRunningFile)], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Metoden understøttes ikke.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$status = readStatus($statusFile, $requestFile, $requestRunningFile);
if (in_array($status['state'] ?? '', ['queued', 'running'], true)) {
    echo json_encode(['ok' => true, 'started' => false, 'status' => $status], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$body = json_decode(file_get_contents('php://input') ?: '{}', true);
$mode = is_array($body) && ($body['mode'] ?? '') === 'full' ? 'full' : 'quick';
$days = $mode === 'full' ? 56 : 14;
$request = [
    'mode' => $mode,
    'days' => $days,
    'requested_at' => date(DATE_ATOM),
];
$tmp = $requestFile . '.tmp';
$encoded = json_encode($request, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if (@file_put_contents($tmp, $encoded . "\n", LOCK_EX) === false || !@rename($tmp, $requestFile)) {
    @unlink($tmp);
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Kunne ikke skrive refresh-request til data-mappen.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$status = [
    'state' => 'queued',
    'progress' => 4,
    'message' => 'Opdatering er sat i kø på TrueNAS',
    'requested_at' => $request['requested_at'],
    'mode' => $mode,
    'days' => $days,
];
echo json_encode(['ok' => true, 'started' => true, 'mode' => $mode, 'days' => $days, 'status' => $status], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
