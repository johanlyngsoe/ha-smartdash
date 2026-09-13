<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$baseDir = dirname(__DIR__);
$dataDir = $baseDir . '/data';
$statusFile = $dataDir . '/experience-refresh-status.json';
$script = $baseDir . '/scripts/experience-refresh.sh';

function readStatus(string $file): array {
    if (!is_file($file)) return ['state' => 'idle', 'message' => 'Klar til opdatering'];
    $raw = @file_get_contents($file);
    $data = $raw !== false ? json_decode($raw, true) : null;
    return is_array($data) ? $data : ['state' => 'idle', 'message' => 'Klar til opdatering'];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo json_encode(['ok' => true, 'status' => readStatus($statusFile)], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Metoden understøttes ikke.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$status = readStatus($statusFile);
if (($status['state'] ?? '') === 'running') {
    echo json_encode(['ok' => true, 'started' => false, 'status' => $status], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$body = json_decode(file_get_contents('php://input') ?: '{}', true);
$mode = is_array($body) ? ($body['mode'] ?? 'quick') : 'quick';
$days = $mode === 'full' ? 56 : 14;
@unlink($statusFile);
$command = sprintf(
    'cd %s && nohup /usr/bin/bash %s --days %d --status-file %s >/dev/null 2>&1 </dev/null & echo $!',
    escapeshellarg($baseDir), escapeshellarg($script), $days, escapeshellarg($statusFile)
);
$output = [];
$exitCode = 0;
exec($command, $output, $exitCode);
if ($exitCode !== 0 || empty($output)) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Kunne ikke starte opdateringen fra webserveren.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$started = false;
$status = ['state' => 'idle', 'message' => 'Afventer processtart'];
for ($i = 0; $i < 12; $i++) {
    usleep(250000);
    $status = readStatus($statusFile);
    if (($status['state'] ?? '') === 'running') { $started = true; break; }
    if (($status['state'] ?? '') === 'error') break;
}
if (!$started) {
    http_response_code(500);
    echo json_encode([
        'ok' => false,
        'error' => 'Processen blev startet, men skrev ingen status. Webserver-brugeren mangler sandsynligvis adgang til data-mappen eller scripts.',
        'pid' => trim((string)($output[0] ?? '')),
        'status' => $status,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

echo json_encode(['ok' => true, 'started' => true, 'mode' => $mode === 'full' ? 'full' : 'quick', 'days' => $days, 'status' => $status], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
