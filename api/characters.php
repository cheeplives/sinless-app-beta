<?php
/**
 * characters.php — per-user character store. Every query is scoped to the
 * session user, so a slug alone never reaches another account's data.
 *
 *   GET                     → list [{slug,name,client_updated_at,updated_at}]
 *   GET    ?slug=<slug>      → {slug,name,data,client_updated_at,updated_at}
 *   PUT    ?slug=<slug>      body {data:<charObj>, client_updated_at:<ms>}
 *   DELETE ?slug=<slug>
 *
 * PUT is last-write-wins by client_updated_at: an incoming write older than the
 * stored copy is ignored and the stored copy is returned (`stale: true`).
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

require_method('GET', 'PUT', 'DELETE');
$user = require_approved();
$uid  = (int) $user['id'];
$method = $_SERVER['REQUEST_METHOD'];
$slug = isset($_GET['slug']) ? (string) $_GET['slug'] : '';

if ($method === 'GET') {
  if ($slug === '') {
    $st = db()->prepare(
      'SELECT slug, name, client_updated_at, UNIX_TIMESTAMP(updated_at) AS updated_at
       FROM characters WHERE user_id = ? ORDER BY name');
    $st->execute([$uid]);
    json_out(['characters' => $st->fetchAll()]);
  }
  if (!valid_slug($slug)) json_error(400, 'bad_slug');
  $st = db()->prepare(
    'SELECT slug, name, data, client_updated_at, UNIX_TIMESTAMP(updated_at) AS updated_at
     FROM characters WHERE user_id = ? AND slug = ? LIMIT 1');
  $st->execute([$uid, $slug]);
  $row = $st->fetch();
  if (!$row) json_error(404, 'not_found');
  $row['data'] = json_decode($row['data'], true);   // return parsed JSON
  json_out($row);
}

// PUT / DELETE mutate → require CSRF + a valid slug.
require_csrf();
if (!valid_slug($slug)) json_error(400, 'bad_slug');

if ($method === 'DELETE') {
  $st = db()->prepare('DELETE FROM characters WHERE user_id = ? AND slug = ?');
  $st->execute([$uid, $slug]);
  json_out(['ok' => true, 'deleted' => $st->rowCount() > 0]);
}

// PUT — upsert with last-write-wins.
$body = read_json_body((int) cfg('max_character_bytes', 262144));
$data = $body['data'] ?? null;
if (!is_array($data)) json_error(400, 'missing_data');
$clientUpdated = (int) ($body['client_updated_at'] ?? 0);
$name = substr((string) ($data['name'] ?? ''), 0, 191);
$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if ($json === false) json_error(400, 'unserializable');

$cur = db()->prepare('SELECT client_updated_at FROM characters WHERE user_id = ? AND slug = ? LIMIT 1');
$cur->execute([$uid, $slug]);
$existing = $cur->fetch();
if ($existing && (int) $existing['client_updated_at'] > $clientUpdated) {
  // The server holds a newer copy — reject this stale write, tell the client to pull.
  json_out(['ok' => false, 'stale' => true, 'server_client_updated_at' => (int) $existing['client_updated_at']], 409);
}

$up = db()->prepare(
  'INSERT INTO characters (user_id, slug, name, data, client_updated_at)
   VALUES (:uid, :slug, :name, :data, :cua)
   ON DUPLICATE KEY UPDATE name = VALUES(name), data = VALUES(data),
                           client_updated_at = VALUES(client_updated_at)');
$up->execute([':uid' => $uid, ':slug' => $slug, ':name' => $name,
              ':data' => $json, ':cua' => $clientUpdated]);
json_out(['ok' => true]);
