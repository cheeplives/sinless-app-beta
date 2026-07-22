<?php
/**
 * me.php — the client's auth probe.
 *   200 {user + csrf}          when signed in
 *   401 {error, providers[]}   when signed out (providers = which buttons to show)
 * A network error / 404 (no backend at all) is how the client detects
 * "local-only mode" and skips the login gate entirely.
 */
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_method('GET');

/** Which providers have credentials configured (so the login UI shows the
 * right buttons). Only the public client_id presence is exposed. */
function configured_providers(): array {
  $out = [];
  foreach ((array) cfg('oauth', []) as $name => $conf) {
    if (!empty($conf['client_id'])) $out[] = $name;
  }
  return $out;
}

$u = current_user();
if (!$u) {
  json_out(['error' => 'not_authenticated', 'providers' => configured_providers()], 401);
}

json_out([
  'id'       => (int) $u['id'],
  'email'    => $u['email'],
  'name'     => $u['display_name'],
  'avatar'   => $u['avatar_url'],
  'status'   => $u['status'],       // pending | approved | revoked
  'is_admin' => (bool) (int) $u['is_admin'],
  'csrf'     => csrf_token(),
]);
