<?php
/**
 * admin/users.php — owner-only user administration.
 *   GET  [?status=pending]  → list users (default: all), newest first
 *   POST {user_id, action}  → action in {approve, revoke}
 * is_admin is deliberately NOT settable here — admins are seeded only via
 * $ADMIN_IDENTITIES in config.php.
 */
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_method('GET', 'POST');
$admin = require_admin();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $status = $_GET['status'] ?? '';
  if ($status !== '' && !in_array($status, ['pending', 'approved', 'revoked'], true)) {
    json_error(400, 'bad_status');
  }
  if ($status !== '') {
    $st = db()->prepare(
      'SELECT id, provider, email, display_name, avatar_url, status, is_admin, created_at, approved_at
       FROM users WHERE status = ? ORDER BY created_at DESC');
    $st->execute([$status]);
  } else {
    $st = db()->query(
      'SELECT id, provider, email, display_name, avatar_url, status, is_admin, created_at, approved_at
       FROM users ORDER BY created_at DESC');
  }
  json_out(['users' => $st->fetchAll()]);
}

// POST — approve / revoke
require_csrf();
$body = read_json_body(4096);
$targetId = (int) ($body['user_id'] ?? 0);
$action   = (string) ($body['action'] ?? '');
if ($targetId <= 0 || !in_array($action, ['approve', 'revoke'], true)) {
  json_error(400, 'bad_request');
}
if ($targetId === (int) $admin['id']) {
  json_error(400, 'cannot_modify_self');   // don't let an admin lock themselves out
}

if ($action === 'approve') {
  $st = db()->prepare("UPDATE users SET status = 'approved', approved_at = NOW() WHERE id = ?");
} else {
  $st = db()->prepare("UPDATE users SET status = 'revoked' WHERE id = ? AND is_admin = 0");
}
$st->execute([$targetId]);
json_out(['ok' => true]);
