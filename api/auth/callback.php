<?php
/**
 * callback.php — OAuth redirect target. Verifies `state`, exchanges the code for
 * a token over TLS-verified cURL, fetches the (verified) email + profile, upserts
 * the user, establishes the session, and redirects back into the app.
 *
 * New users land as `status='pending'` (unless their identity is in
 * $ADMIN_IDENTITIES, which auto-approves + flags admin); a new pending user
 * triggers a fire-and-forget signup webhook.
 */
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_method('GET');

function auth_fail(string $reason): void {
  error_log('oauth callback failed: ' . $reason);
  // Return to the app (which reads ?auth_error and shows a retry message), using
  // the configured base_url so this works under a subpath (e.g. /sinless/).
  header('Location: ' . rtrim((string) cfg('base_url'), '/') . '/?auth_error=1', true, 302);
  exit;
}

// The provider may bounce back an error (user declined, etc.).
if (isset($_GET['error'])) auth_fail('provider_error:' . (string) $_GET['error']);

// --- verify state (one-time, constant-time) --------------------------------
$sess = $_SESSION['oauth'] ?? null;
unset($_SESSION['oauth']);                 // single use, regardless of outcome
$state = (string) ($_GET['state'] ?? '');
$code  = (string) ($_GET['code'] ?? '');
if (!$sess || $code === '' || $state === '' || !hash_equals((string) $sess['state'], $state)) {
  auth_fail('bad_state');
}
$provider = (string) $sess['provider'];
$oauth = cfg('oauth', []);
if (empty($oauth[$provider]['client_id'])) auth_fail('provider_unconfigured');

$redirectUri = rtrim((string) cfg('base_url'), '/') . '/api/auth/callback.php';
$clientId     = $oauth[$provider]['client_id'];
$clientSecret = $oauth[$provider]['client_secret'];

// --- exchange code -> access token (TLS verified) --------------------------
$identity = null;   // ['provider_user_id','email','name','avatar']

if ($provider === 'google') {
  $tok = http_request('POST', 'https://oauth2.googleapis.com/token', [
    'headers'     => ['Content-Type: application/x-www-form-urlencoded'],
    'post_fields' => http_build_query([
      'code' => $code, 'client_id' => $clientId, 'client_secret' => $clientSecret,
      'redirect_uri' => $redirectUri, 'grant_type' => 'authorization_code',
    ]),
  ]);
  if ($tok['status'] !== 200) auth_fail('google_token:' . $tok['status']);
  $access = json_decode($tok['body'], true)['access_token'] ?? '';
  if (!$access) auth_fail('google_no_token');

  $ui = http_request('GET', 'https://openidconnect.googleapis.com/v1/userinfo', [
    'headers' => ['Authorization: Bearer ' . $access],
  ]);
  if ($ui['status'] !== 200) auth_fail('google_userinfo:' . $ui['status']);
  $p = json_decode($ui['body'], true) ?: [];
  if (empty($p['sub'])) auth_fail('google_no_sub');
  if (empty($p['email']) || ($p['email_verified'] ?? false) !== true) auth_fail('google_email_unverified');
  $identity = [
    'provider_user_id' => (string) $p['sub'],
    'email'  => (string) $p['email'],
    'name'   => (string) ($p['name'] ?? ''),
    'avatar' => (string) ($p['picture'] ?? ''),
  ];

} else { // github
  $tok = http_request('POST', 'https://github.com/login/oauth/access_token', [
    'headers'     => ['Accept: application/json', 'Content-Type: application/x-www-form-urlencoded'],
    'post_fields' => http_build_query([
      'code' => $code, 'client_id' => $clientId, 'client_secret' => $clientSecret,
      'redirect_uri' => $redirectUri,
    ]),
  ]);
  if ($tok['status'] !== 200) auth_fail('github_token:' . $tok['status']);
  $access = json_decode($tok['body'], true)['access_token'] ?? '';
  if (!$access) auth_fail('github_no_token');

  $ghHeaders = [
    'Authorization: Bearer ' . $access,
    'Accept: application/vnd.github+json',
    'User-Agent: sinless-app',                 // GitHub requires a UA
  ];
  $ui = http_request('GET', 'https://api.github.com/user', ['headers' => $ghHeaders]);
  if ($ui['status'] !== 200) auth_fail('github_user:' . $ui['status']);
  $p = json_decode($ui['body'], true) ?: [];
  if (empty($p['id'])) auth_fail('github_no_id');

  // Pick the primary, verified email (the /user email can be null/private).
  $em = http_request('GET', 'https://api.github.com/user/emails', ['headers' => $ghHeaders]);
  $email = '';
  if ($em['status'] === 200) {
    foreach ((json_decode($em['body'], true) ?: []) as $row) {
      if (!empty($row['primary']) && !empty($row['verified'])) { $email = (string) $row['email']; break; }
    }
  }
  if ($email === '') auth_fail('github_email_unverified');
  $identity = [
    'provider_user_id' => (string) $p['id'],
    'email'  => $email,
    'name'   => (string) ($p['name'] ?: ($p['login'] ?? '')),
    'avatar' => (string) ($p['avatar_url'] ?? ''),
  ];
}

// --- upsert the user -------------------------------------------------------
$pdo = db();
$sel = $pdo->prepare('SELECT * FROM users WHERE provider = ? AND provider_user_id = ? LIMIT 1');
$sel->execute([$provider, $identity['provider_user_id']]);
$user = $sel->fetch();

if ($user) {
  $upd = $pdo->prepare('UPDATE users SET email = ?, display_name = ?, avatar_url = ?, last_login_at = NOW() WHERE id = ?');
  $upd->execute([$identity['email'], $identity['name'], $identity['avatar'], $user['id']]);
  $userId = (int) $user['id'];
} else {
  // Auto-approve + admin if this identity is configured as an owner.
  $admins = array_map('strtolower', (array) cfg('admin_identities', []));
  $isAdmin = in_array(strtolower($identity['email']), $admins, true)
          || in_array(strtolower($provider . ':' . $identity['provider_user_id']), $admins, true);
  $status = $isAdmin ? 'approved' : 'pending';

  $ins = $pdo->prepare(
    'INSERT INTO users (provider, provider_user_id, email, display_name, avatar_url, status, is_admin, approved_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ' . ($isAdmin ? 'NOW()' : 'NULL') . ', NOW())');
  $ins->execute([$provider, $identity['provider_user_id'], $identity['email'],
                 $identity['name'], $identity['avatar'], $status, $isAdmin ? 1 : 0]);
  $userId = (int) $pdo->lastInsertId();

  if (!$isAdmin) {
    post_signup_webhook(sprintf(
      "🆕 Sinless access request\nName: %s\nEmail: %s\nProvider: %s\nApprove in the app's Admin panel.",
      $identity['name'] !== '' ? $identity['name'] : '(none)', $identity['email'], $provider));
  }
}

// --- establish session + return to the app ---------------------------------
session_login($userId);
header('Location: ' . safe_return_path($sess['return'] ?? '/'), true, 302);
exit;
