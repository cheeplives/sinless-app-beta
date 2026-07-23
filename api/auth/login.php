<?php
/**
 * login.php — start the OAuth authorization-code flow.
 *   GET /api/auth/login.php?provider=google|github[&return=/relative/path]
 * Generates a one-time CSRF `state`, stashes it (with the provider + return
 * target) in the session, and redirects to the provider's consent screen.
 */
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_method('GET');
rate_limit('login', client_ip(), 20, 300);   // 20 sign-in starts / 5 min / IP

$provider = $_GET['provider'] ?? '';
$oauth = cfg('oauth', []);
if (!isset($oauth[$provider]) || empty($oauth[$provider]['client_id'])) {
  json_error(400, 'unknown_provider');
}

$state = bin2hex(random_bytes(32));
$_SESSION['oauth'] = [
  'state'    => $state,
  'provider' => $provider,
  'return'   => safe_return_path($_GET['return'] ?? '/'),
  'ts'       => time(),
];

$redirectUri = rtrim((string) cfg('base_url'), '/') . '/api/auth/callback.php';
$clientId = $oauth[$provider]['client_id'];

if ($provider === 'google') {
  $url = 'https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query([
    'client_id'     => $clientId,
    'redirect_uri'  => $redirectUri,
    'response_type' => 'code',
    'scope'         => 'openid email profile',
    'state'         => $state,
    'access_type'   => 'online',
    'prompt'        => 'select_account',
  ]);
} else { // github
  $url = 'https://github.com/login/oauth/authorize?' . http_build_query([
    'client_id'    => $clientId,
    'redirect_uri' => $redirectUri,
    'scope'        => 'read:user user:email',
    'state'        => $state,
    'allow_signup' => 'false',
  ]);
}

header('Location: ' . $url, true, 302);
exit;
