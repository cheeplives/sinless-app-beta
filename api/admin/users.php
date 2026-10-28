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

// Sinless's own queue (sinless_access): everyone who has signed in to Sinless. Someone who only uses Campaign Chronicle
// (which may share the users table) isn't listed. Until migration 005 is run, users.status as before.
$acc = has_access_table();
$cols = $acc
  ? 'u.id, u.provider, u.email, u.display_name, u.avatar_url, a.status, u.is_admin, a.requested_at AS created_at, a.approved_at
     FROM users u JOIN sinless_access a ON a.user_id = u.id'
  : 'u.id, u.provider, u.email, u.display_name, u.avatar_url, u.status, u.is_admin, u.created_at, u.approved_at FROM users u';
$col = $acc ? 'a.status' : 'u.status';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $status = $_GET['status'] ?? '';
  if ($status !== '' && !in_array($status, ['pending', 'approved', 'revoked'], true)) {
    json_error(400, 'bad_status');
  }
  if ($status !== '') {
    $st = db()->prepare("SELECT $cols WHERE $col = ? ORDER BY created_at DESC");
    $st->execute([$status]);
  } else {
    $st = db()->query("SELECT $cols ORDER BY created_at DESC");
  }
  json_out(['users' => $st->fetchAll()]);
}

// POST — approve / revoke
require_csrf();
rate_limit('admin', 'u' . $admin['id'], 60, 60);   // 60 admin actions / min
$body = read_json_body(4096);
$targetId = (int) ($body['user_id'] ?? 0);
$action   = (string) ($body['action'] ?? '');
if ($targetId <= 0 || !in_array($action, ['approve', 'revoke'], true)) {
  json_error(400, 'bad_request');
}
if ($targetId === (int) $admin['id']) {
  json_error(400, 'cannot_modify_self');   // don't let an admin lock themselves out
}

// Read prior state first so we only email on an ACTUAL status transition
// (re-approving / re-revoking must not re-send). The status is Sinless's own.
$sel = db()->prepare("SELECT u.email, u.display_name, $col AS status, u.is_admin FROM " . ($acc ? 'users u LEFT JOIN sinless_access a ON a.user_id = u.id' : 'users u') . ' WHERE u.id = ?');
$sel->execute([$targetId]);
$target = $sel->fetch();
if (!$target) json_error(404, 'user_not_found');

if ($action === 'approve') {
  if ($acc) db()->prepare("INSERT INTO sinless_access (user_id, status, approved_at) VALUES (?, 'approved', NOW())
                            ON DUPLICATE KEY UPDATE status = 'approved', approved_at = NOW()")->execute([$targetId]);
  else db()->prepare("UPDATE users SET status = 'approved', approved_at = NOW() WHERE id = ?")->execute([$targetId]);

  if (($target['status'] ?? '') !== 'approved' && !empty($target['email'])) {
    send_account_email('approved', (string) $target['email'], (string) ($target['display_name'] ?? ''));
  }
} else {
  // Admins can't be revoked (mirrored below so an admin target is never emailed).
  if (!(int) $target['is_admin']) {
    if ($acc) db()->prepare("INSERT INTO sinless_access (user_id, status) VALUES (?, 'revoked')
                              ON DUPLICATE KEY UPDATE status = 'revoked'")->execute([$targetId]);
    else db()->prepare("UPDATE users SET status = 'revoked' WHERE id = ? AND is_admin = 0")->execute([$targetId]);
  }

  // Only send on a real transition.
  if (!(int) $target['is_admin'] && ($target['status'] ?? '') !== 'revoked' && !empty($target['email'])) {
    send_account_email('revoked', (string) $target['email'], (string) ($target['display_name'] ?? ''));
  }
}
json_out(['ok' => true]);
