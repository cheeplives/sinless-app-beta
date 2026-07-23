<?php
/**
 * lib.php — shared backend: config, PDO, hardened sessions, auth guards,
 * JSON I/O, security headers, and TLS-verified HTTP helpers.
 *
 * Every endpoint does `require __DIR__ . '/lib.php';` first. PHP 7.4+ / 8.x.
 *
 * Security posture (see the plan's hardening section):
 *  - PDO prepared statements only, emulate_prepares off, utf8mb4.
 *  - Sessions: strict mode, cookie Secure/HttpOnly/SameSite=Lax, id regenerated
 *    on privilege change, idle + absolute timeouts enforced.
 *  - Object access is ALWAYS scoped to the session user (see endpoints).
 *  - CSRF: synchronizer token required on mutations.
 *  - Outbound OAuth/webhook calls verify TLS (peer + host).
 */

declare(strict_types=1);

// --- config ----------------------------------------------------------------
$__CONFIG_PATH = __DIR__ . '/config.php';               // move above webroot if you can
if (!is_file($__CONFIG_PATH)) {
  http_response_code(500);
  header('Content-Type: application/json');
  echo json_encode(['error' => 'server_not_configured',
                    'detail' => 'Copy api/config.example.php to api/config.php.']);
  exit;
}
$GLOBALS['__CFG'] = require $__CONFIG_PATH;

function cfg(?string $key = null, $default = null) {
  $c = $GLOBALS['__CFG'];
  if ($key === null) return $c;
  return array_key_exists($key, $c) ? $c[$key] : $default;
}

// --- error handling --------------------------------------------------------
$__debug = (bool) cfg('debug', false);
error_reporting(E_ALL);
ini_set('display_errors', $__debug ? '1' : '0');
ini_set('log_errors', '1');

// --- security headers (also enforced site-wide by .htaccess) ---------------
function send_security_headers(): void {
  // API/data responses must never be cached by shared caches or the SW.
  header('Cache-Control: no-store');
  header('X-Content-Type-Options: nosniff');
  header('Referrer-Policy: strict-origin-when-cross-origin');
  header('X-Frame-Options: DENY');
  // No CORS headers on purpose: the API is same-origin only.
  header_remove('X-Powered-By');
}
send_security_headers();

// --- database (PDO) --------------------------------------------------------
function db(): PDO {
  static $pdo = null;
  if ($pdo instanceof PDO) return $pdo;
  $d = cfg('db');
  $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=%s',
    $d['host'], (int) ($d['port'] ?? 3306), $d['name'], $d['charset'] ?? 'utf8mb4');
  try {
    $pdo = new PDO($dsn, $d['user'], $d['password'], [
      PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
      PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
      PDO::ATTR_EMULATE_PREPARES   => false,   // real prepared statements
    ]);
  } catch (Throwable $e) {
    error_log('DB connect failed: ' . $e->getMessage());
    json_error(500, 'db_unavailable');
  }
  return $pdo;
}

// --- hardened session ------------------------------------------------------
function boot_session(): void {
  if (session_status() === PHP_SESSION_ACTIVE) return;
  $s = cfg('session', []);
  if (!empty($s['save_path'])) session_save_path($s['save_path']);

  ini_set('session.use_strict_mode', '1');   // reject attacker-supplied session ids
  ini_set('session.use_only_cookies', '1');
  ini_set('session.cookie_httponly', '1');

  session_name($s['name'] ?? 'sinless_sid');
  session_set_cookie_params([
    'lifetime' => 0,                          // session cookie (dies with browser)
    'path'     => '/',
    'secure'   => (bool) ($s['cookie_secure'] ?? true),
    'httponly' => true,
    'samesite' => 'Lax',
  ]);
  session_start();

  // Idle + absolute timeout enforcement.
  $now = time();
  $idle = (int) ($s['idle_timeout'] ?? 1209600);
  $abs  = (int) ($s['absolute_timeout'] ?? 5184000);
  if (isset($_SESSION['user_id'])) {
    $expired = ($now - ($_SESSION['last_seen'] ?? $now)) > $idle
            || ($now - ($_SESSION['created'] ?? $now)) > $abs;
    if ($expired) { destroy_session(); }
  }
  if (isset($_SESSION['user_id'])) $_SESSION['last_seen'] = $now;
  if (!isset($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

function destroy_session(): void {
  $_SESSION = [];
  if (ini_get('session.use_cookies')) {
    $p = session_get_cookie_params();
    setcookie(session_name(), '', [
      'expires' => time() - 42000, 'path' => $p['path'],
      'secure' => $p['secure'], 'httponly' => true, 'samesite' => 'Lax',
    ]);
  }
  session_destroy();
}

/** Call right after establishing/raising privilege (login) to prevent fixation. */
function session_login(int $userId): void {
  session_regenerate_id(true);
  $_SESSION['user_id'] = $userId;
  $_SESSION['created'] = time();
  $_SESSION['last_seen'] = time();
  $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

// --- JSON I/O --------------------------------------------------------------
function json_out($data, int $status = 200): void {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}
function json_error(int $status, string $code, string $detail = ''): void {
  $body = ['error' => $code];
  if ($detail !== '' && cfg('debug', false)) $body['detail'] = $detail;
  json_out($body, $status);
}

/** Read + decode a JSON request body, enforcing a byte cap and content-type. */
function read_json_body(int $maxBytes): array {
  $ct = $_SERVER['CONTENT_TYPE'] ?? '';
  if (stripos($ct, 'application/json') === false) json_error(415, 'expected_json');
  $raw = file_get_contents('php://input');
  if ($raw === false) json_error(400, 'no_body');
  if (strlen($raw) > $maxBytes) json_error(413, 'payload_too_large');
  $data = json_decode($raw, true);
  if (!is_array($data)) json_error(400, 'invalid_json');
  return $data;
}

function require_method(string ...$allowed): void {
  $m = $_SERVER['REQUEST_METHOD'] ?? 'GET';
  if (!in_array($m, $allowed, true)) {
    header('Allow: ' . implode(', ', $allowed));
    json_error(405, 'method_not_allowed');
  }
}

// --- auth guards -----------------------------------------------------------
/** Current user row (or null). Cached per request. */
function current_user(): ?array {
  static $u = false;
  if ($u !== false) return $u;
  if (empty($_SESSION['user_id'])) return $u = null;
  $st = db()->prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
  $st->execute([$_SESSION['user_id']]);
  $row = $st->fetch();
  return $u = ($row ?: null);
}

function require_login(): array {
  $u = current_user();
  if (!$u) json_error(401, 'not_authenticated');
  return $u;
}
function require_approved(): array {
  $u = require_login();
  if ($u['status'] !== 'approved') json_error(403, 'not_approved');
  return $u;
}
function require_admin(): array {
  $u = require_approved();
  if (!(int) $u['is_admin']) json_error(403, 'not_admin');
  return $u;
}

function csrf_token(): string {
  return $_SESSION['csrf'] ?? '';
}
/** Mutations must present the session CSRF token in the X-CSRF-Token header. */
function require_csrf(): void {
  $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
  if ($sent === '' || !hash_equals(csrf_token(), $sent)) json_error(403, 'bad_csrf');
}

// --- validation ------------------------------------------------------------
function valid_slug(string $s): bool {
  return (bool) preg_match('/^[A-Za-z0-9_-]{1,80}$/', $s);
}

/** Reduce a caller-supplied post-login target to a safe same-origin path. */
function safe_return_path(?string $p): string {
  if (!is_string($p) || $p === '') return '/';
  // Only allow a site-relative path; reject anything scheme/host-like.
  if ($p[0] !== '/' || (isset($p[1]) && $p[1] === '/')) return '/';
  if (strpos($p, "\\") !== false || strpos($p, "\n") !== false) return '/';
  return $p;
}

// --- rate limiting (DB-backed fixed window) --------------------------------
/** Best-effort client IP. Uses REMOTE_ADDR only — X-Forwarded-For is spoofable
 * and would let an attacker evade or poison the limiter. (Behind a trusted proxy
 * like Cloudflare you'd switch to its verified header.) */
function client_ip(): string {
  $ip = $_SERVER['REMOTE_ADDR'] ?? '';
  return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : '0.0.0.0';
}

/** Fixed-window limiter: allow up to $max hits per $windowSec for (bucket,id);
 * on exceed, respond 429 and exit. Fails OPEN on any DB error — a limiter glitch
 * must never lock the whole app out (auth/IDOR are the real controls). Toggle
 * off with config 'rate_limit_enabled' => false. */
function rate_limit(string $bucket, string $id, int $max, int $windowSec): void {
  if (!cfg('rate_limit_enabled', true)) return;
  $now = time();
  $win = (int) (floor($now / $windowSec) * $windowSec);
  try {
    $pdo = db();
    // Distinct placeholders because real prepared statements can't reuse a name.
    $pdo->prepare(
      'INSERT INTO rate_limits (bucket, id, window_start, hits) VALUES (:b, :i, :w1, 1)
       ON DUPLICATE KEY UPDATE hits = IF(window_start = :w2, hits + 1, 1), window_start = :w3'
    )->execute([':b' => $bucket, ':i' => $id, ':w1' => $win, ':w2' => $win, ':w3' => $win]);
    $sel = $pdo->prepare('SELECT hits FROM rate_limits WHERE bucket = ? AND id = ? LIMIT 1');
    $sel->execute([$bucket, $id]);
    $hits = (int) $sel->fetchColumn();
    // Occasional GC so the table can't grow unbounded (~1% of calls).
    if (random_int(1, 100) === 1) {
      $pdo->prepare('DELETE FROM rate_limits WHERE window_start < ?')->execute([$now - 86400]);
    }
  } catch (Throwable $e) {
    error_log('rate_limit error: ' . $e->getMessage());
    return;   // fail open
  }
  if ($hits > $max) {
    header('Retry-After: ' . $windowSec);
    json_error(429, 'rate_limited');
  }
}

// --- outbound HTTP (TLS-verified) -----------------------------------------
function http_request(string $method, string $url, array $opts = []): array {
  $ch = curl_init($url);
  $headers = $opts['headers'] ?? [];
  curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_SSL_VERIFYPEER => true,     // never disable — MITM of the token exchange = full compromise
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_CONNECTTIMEOUT => (int) ($opts['connect_timeout'] ?? 5),
    CURLOPT_TIMEOUT        => (int) ($opts['timeout'] ?? 10),
    CURLOPT_HTTPHEADER     => $headers,
  ]);
  if (isset($opts['post_fields'])) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $opts['post_fields']);
  }
  $body = curl_exec($ch);
  $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $err = curl_error($ch);
  curl_close($ch);
  return ['status' => $status, 'body' => (string) $body, 'error' => $err];
}

/** Fire-and-forget signup alert to a Discord/Slack incoming webhook. Never
 * throws into the caller and uses tight timeouts so a slow hook can't stall
 * (or break) the login redirect. Both Discord and Slack accept {"content"|"text"}. */
function post_signup_webhook(string $text): void {
  $url = (string) cfg('approval_webhook_url', '');
  if ($url === '') return;
  try {
    http_request('POST', $url, [
      'headers'     => ['Content-Type: application/json'],
      'post_fields' => json_encode(['content' => $text, 'text' => $text]),
      'connect_timeout' => 2,
      'timeout'         => 3,
    ]);
  } catch (Throwable $e) {
    error_log('signup webhook failed: ' . $e->getMessage());
  }
}

// Every endpoint runs inside a session.
boot_session();
