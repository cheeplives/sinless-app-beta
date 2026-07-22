<?php
/**
 * custom-content.php — the user's homebrew blob (one row per user).
 *   GET → {data:<blob>|null, updated_at}
 *   PUT → body {data:<blob>}
 */
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_method('GET', 'PUT');
$user = require_approved();
$uid  = (int) $user['id'];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $st = db()->prepare('SELECT data, UNIX_TIMESTAMP(updated_at) AS updated_at FROM custom_content WHERE user_id = ? LIMIT 1');
  $st->execute([$uid]);
  $row = $st->fetch();
  json_out(['data' => $row ? json_decode($row['data'], true) : null,
            'updated_at' => $row ? (int) $row['updated_at'] : 0]);
}

// PUT
require_csrf();
$body = read_json_body((int) cfg('max_custom_bytes', 1048576));
$data = $body['data'] ?? null;
if (!is_array($data)) json_error(400, 'missing_data');
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if ($json === false) json_error(400, 'unserializable');

$up = db()->prepare(
  'INSERT INTO custom_content (user_id, data) VALUES (:uid, :data)
   ON DUPLICATE KEY UPDATE data = VALUES(data)');
$up->execute([':uid' => $uid, ':data' => $json]);
json_out(['ok' => true]);
