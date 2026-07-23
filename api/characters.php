<?php
/**
 * characters.php — per-user character store + members-only public sharing.
 *
 * Private (owner-scoped, WHERE user_id = session user):
 *   GET                     → list [{slug,name,is_public,client_updated_at,updated_at}]
 *   GET    ?slug=<slug>      → {slug,name,data,is_public,...}
 *   PUT    ?slug=<slug>      body {data:<charObj>, client_updated_at:<ms>}
 *   POST   ?slug=<slug>      body {is_public:bool}   ← toggle sharing (owner only)
 *   DELETE ?slug=<slug>
 *
 * Public (cross-user, hard-gated on is_public=1 — the ONLY paths that return
 * another member's data; still require an approved login, i.e. members only):
 *   GET ?public=1           → gallery: [{id,name,owner,updated_at}]  (NO data)
 *   GET ?public_id=<int>    → {id,name,owner,data,updated_at} if that char is public
 *
 * PUT is last-write-wins by client_updated_at; sharing state is untouched by PUT.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

require_method('GET', 'POST', 'PUT', 'DELETE');
$user = require_approved();
$uid  = (int) $user['id'];
$method = $_SERVER['REQUEST_METHOD'];
$slug = isset($_GET['slug']) ? (string) $_GET['slug'] : '';

if ($method === 'GET') {
  // --- public gallery: metadata for every public character, any owner --------
  if (isset($_GET['public'])) {
    $st = db()->prepare(
      'SELECT c.id, c.name, u.display_name AS owner, UNIX_TIMESTAMP(c.updated_at) AS updated_at
       FROM characters c JOIN users u ON u.id = c.user_id
       WHERE c.is_public = 1 ORDER BY c.name');
    $st->execute();
    json_out(['characters' => $st->fetchAll()]);
  }
  // --- view one public character (full data) by global id, only if public ----
  if (isset($_GET['public_id'])) {
    $pid = (int) $_GET['public_id'];
    $st = db()->prepare(
      'SELECT c.id, c.name, c.data, u.display_name AS owner, UNIX_TIMESTAMP(c.updated_at) AS updated_at
       FROM characters c JOIN users u ON u.id = c.user_id
       WHERE c.id = ? AND c.is_public = 1 LIMIT 1');
    $st->execute([$pid]);
    $row = $st->fetch();
    if (!$row) json_error(404, 'not_found');
    $row['data'] = json_decode($row['data'], true);
    json_out($row);
  }
  // --- own list --------------------------------------------------------------
  if ($slug === '') {
    $st = db()->prepare(
      'SELECT slug, name, is_public, client_updated_at, UNIX_TIMESTAMP(updated_at) AS updated_at
       FROM characters WHERE user_id = ? ORDER BY name');
    $st->execute([$uid]);
    json_out(['characters' => $st->fetchAll()]);
  }
  // --- own single ------------------------------------------------------------
  if (!valid_slug($slug)) json_error(400, 'bad_slug');
  $st = db()->prepare(
    'SELECT slug, name, data, is_public, client_updated_at, UNIX_TIMESTAMP(updated_at) AS updated_at
     FROM characters WHERE user_id = ? AND slug = ? LIMIT 1');
  $st->execute([$uid, $slug]);
  $row = $st->fetch();
  if (!$row) json_error(404, 'not_found');
  $row['data'] = json_decode($row['data'], true);
  json_out($row);
}

// --- POST: toggle sharing on your OWN character ------------------------------
if ($method === 'POST') {
  require_csrf();
  rate_limit('write', 'u' . $uid, 120, 60);
  if (!valid_slug($slug)) json_error(400, 'bad_slug');
  $body = read_json_body(1024);
  $isPublic = !empty($body['is_public']) ? 1 : 0;
  $st = db()->prepare('UPDATE characters SET is_public = ? WHERE user_id = ? AND slug = ?');
  $st->execute([$isPublic, $uid, $slug]);
  json_out(['ok' => true, 'is_public' => (bool) $isPublic, 'updated' => $st->rowCount() > 0]);
}

// --- PUT / DELETE mutate → require CSRF + a valid slug -----------------------
require_csrf();
rate_limit('write', 'u' . $uid, 120, 60);   // 120 writes / min / user
if (!valid_slug($slug)) json_error(400, 'bad_slug');

if ($method === 'DELETE') {
  $st = db()->prepare('DELETE FROM characters WHERE user_id = ? AND slug = ?');
  $st->execute([$uid, $slug]);
  json_out(['ok' => true, 'deleted' => $st->rowCount() > 0]);
}

// PUT — upsert with last-write-wins. Sharing state (is_public) is deliberately
// NOT touched here, so an autosave can never change a character's visibility.
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
