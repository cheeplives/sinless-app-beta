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
// Preference order (first that exists wins), so secrets can live ABOVE the web
// root — no path editing needed, just move the file up:
//   1. $SINLESS_CONFIG env var (explicit absolute path)
//   2. <one level above the document root>/sinless-config.php   (e.g. ~/sinless-config.php)
//   3. $HOME/sinless-config.php
//   4. api/config.php  (in-tree fallback — protected by .htaccess, but least ideal)
$__candidates = [];
$__envCfg = getenv('SINLESS_CONFIG') ?: ($_SERVER['SINLESS_CONFIG'] ?? '');
if ($__envCfg !== '') $__candidates[] = $__envCfg;
if (!empty($_SERVER['DOCUMENT_ROOT']))
  $__candidates[] = dirname($_SERVER['DOCUMENT_ROOT']) . '/sinless-config.php';
$__home = getenv('HOME') ?: ($_SERVER['HOME'] ?? '');
if ($__home !== '') $__candidates[] = rtrim($__home, '/') . '/sinless-config.php';
$__candidates[] = __DIR__ . '/config.php';

$__CONFIG_PATH = '';
foreach ($__candidates as $__c) {
  if ($__c !== '' && is_file($__c)) { $__CONFIG_PATH = $__c; break; }
}
if ($__CONFIG_PATH === '') {
  http_response_code(500);
  header('Content-Type: application/json');
  echo json_encode(['error' => 'server_not_configured',
                    'detail' => 'Copy api/config.example.php to api/config.php (or ~/sinless-config.php).']);
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

/**
 * A private directory to keep session files in, or null to leave PHP's default
 * alone. Owning the directory is the reliable half of the issue-#25 fix: the
 * shared default (/tmp or /var/lib/php/sessions) is swept on a schedule we do
 * not control -- a cron sweep ignores our gc_maxlifetime, and on shared hosting
 * another tenant's sweep can delete our files outright.
 *
 * `session.save_path` in config wins. Otherwise derive one from the parent of
 * the web root, which on shared hosts (DreamHost included) is the account home
 * -- outside the web root, and ours. The session name is appended so two
 * instances on one account (say beta and live) never share a directory.
 *
 * Falls back to PHP's default whenever the directory can't be used, because a
 * save_path that doesn't exist or isn't writable takes down every login. An
 * explicitly configured path that fails is logged; a failed auto-derivation is
 * not, since it just means the host doesn't allow it (open_basedir, say).
 */
function session_dir(array $s): ?string {
  $configured = trim((string) ($s['save_path'] ?? ''));
  $dir = $configured;
  if ($dir === '') {
    $root = rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), '/');
    if ($root === '') return null;
    $parent = dirname($root);
    // dirname('/foo') is '/' -- refuse to plant a directory at the filesystem
    // root, and don't bother if the parent isn't there.
    if ($parent === '' || $parent === '/' || $parent === '.' || !is_dir($parent)) return null;
    $name = (string) preg_replace('/[^A-Za-z0-9_.-]/', '', (string) ($s['name'] ?? 'sinless_sid'));
    if ($name === '') $name = 'sinless_sid';
    $dir = $parent . '/.sinless-sessions/' . $name;
  }

  if (!is_dir($dir)) @mkdir($dir, 0700, true);
  if (!is_dir($dir) || !is_writable($dir)) {
    if ($configured !== '')
      error_log("session.save_path '$dir' is not a writable directory — "
        . 'falling back to the PHP default, which may be swept early (issue #25).');
    return null;
  }
  @chmod($dir, 0700);
  // Only matters if the derivation ever lands inside the web root; the files are
  // 0600 under a 0700 dir regardless, so this is belt-and-braces.
  $ht = $dir . '/.htaccess';
  if (!file_exists($ht)) @file_put_contents($ht, "Require all denied\n");
  return $dir;
}

function boot_session(): void {
  if (session_status() === PHP_SESSION_ACTIVE) return;
  $s = cfg('session', []);
  $ownDir = session_dir($s);
  if ($ownDir !== null) {
    session_save_path($ownDir);
    // Once the files are ours, PHP's own GC is the only thing that will ever
    // clean them. Hosts that sweep from cron ship gc_probability=0, which would
    // otherwise leave every session file here forever, so make sure GC runs.
    if ((int) ini_get('session.gc_probability') < 1) {
      ini_set('session.gc_probability', '1');
      ini_set('session.gc_divisor', '100');
    }
  }

  ini_set('session.use_strict_mode', '1');   // reject attacker-supplied session ids
  ini_set('session.use_only_cookies', '1');
  ini_set('session.cookie_httponly', '1');

  $idle = (int) ($s['idle_timeout'] ?? 1209600);
  $abs  = (int) ($s['absolute_timeout'] ?? 5184000);
  // How long the browser keeps the cookie. 0 means "until the browser closes",
  // which silently overrode the idle_timeout above and logged people out roughly
  // daily whenever they restarted their browser (issue #25). Default it to the
  // idle window so the declared policy is the one that actually applies; set it
  // to 0 in config to deliberately get browser-session cookies back.
  $cookieLife = array_key_exists('cookie_lifetime', $s)
    ? (int) $s['cookie_lifetime'] : $idle;

  // PHP garbage-collects session FILES on its own schedule -- the default
  // gc_maxlifetime is 1440s (24 min), so the server could drop a session long
  // before the cookie or idle_timeout said it should. Keep the files at least as
  // long as the idle window. NB on distros where GC runs from cron instead of
  // PHP (Debian/Ubuntu packaging), this ini has no effect and a private
  // session.save_path is the reliable fix -- see docs/HOSTING.md.
  ini_set('session.gc_maxlifetime', (string) max($idle, 1440));

  session_name($s['name'] ?? 'sinless_sid');
  session_set_cookie_params([
    'lifetime' => $cookieLife,
    'path'     => '/',
    'secure'   => (bool) ($s['cookie_secure'] ?? true),
    'httponly' => true,
    'samesite' => 'Lax',
  ]);
  session_start();

  // Idle + absolute timeout enforcement.
  $now = time();
  if (isset($_SESSION['user_id'])) {
    $expired = ($now - ($_SESSION['last_seen'] ?? $now)) > $idle
            || ($now - ($_SESSION['created'] ?? $now)) > $abs;
    if ($expired) { destroy_session(); }
  }
  if (isset($_SESSION['user_id'])) {
    $_SESSION['last_seen'] = $now;
    // PHP only emits the cookie when it creates or regenerates a session, so a
    // persistent cookie would otherwise expire a fixed idle_timeout after LOGIN
    // no matter how active the user was. Re-send it to slide the window, but not
    // past the session's absolute deadline.
    if ($cookieLife > 0) {
      $deadline = ($_SESSION['created'] ?? $now) + $abs;
      $life = min($cookieLife, max(0, $deadline - $now));
      if ($life > 0) {
        setcookie(session_name(), session_id(), [
          'expires'  => $now + $life, 'path' => '/',
          'secure'   => (bool) ($s['cookie_secure'] ?? true),
          'httponly' => true, 'samesite' => 'Lax',
        ]);
      }
    }
  }
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
/** Whether migration 005 has been run: Sinless keeps its own approvals in sinless_access. Until it has, users.status
 * (which Campaign Chronicle may share) still decides, as before. */
function has_access_table(): bool {
  static $has = null;
  return $has ??= (bool) db()->query("SHOW TABLES LIKE 'sinless_access'")->fetchColumn();
}

/** Current user row (or null), its status being their standing in Sinless. Cached per request. */
function current_user(): ?array {
  static $u = false;
  if ($u !== false) return $u;
  if (empty($_SESSION['user_id'])) return $u = null;
  $st = db()->prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
  $st->execute([$_SESSION['user_id']]);
  $row = $st->fetch();
  if ($row && has_access_table()) {
    $a = db()->prepare('SELECT status FROM sinless_access WHERE user_id = ?');
    $a->execute([$row['id']]);
    $row['status'] = (string) ($a->fetchColumn() ?: 'pending');
  }
  return $u = ($row ?: null);
}

/**
 * Make sure user $userId has a say in Sinless: an admin is approved; anyone else with no sinless_access row gets a
 * 'pending' one and the signup alert goes out, naming Sinless, so it can't be mistaken for a Campaign Chronicle
 * request. Someone already approved, waiting or revoked here is left as they are. Before migration 005 only a brand
 * new account ($new) is announced, as before.
 */
function sinless_access_request(int $userId, bool $isAdmin, string $provider, array $identity, bool $new): void {
  $pdo = db();
  $alert = $new;
  if (has_access_table()) {
    if ($isAdmin) {
      $pdo->prepare("INSERT INTO sinless_access (user_id, status, approved_at) VALUES (?, 'approved', NOW())
                     ON DUPLICATE KEY UPDATE status = 'approved', approved_at = COALESCE(approved_at, NOW())")->execute([$userId]);
      return;
    }
    $ins = $pdo->prepare("INSERT IGNORE INTO sinless_access (user_id, status) VALUES (?, 'pending')");
    $ins->execute([$userId]);
    $alert = $ins->rowCount() > 0;
  }
  if ($alert && !$isAdmin) {
    post_signup_webhook(sprintf(
      "🆕 Sinless access request\nName: %s\nEmail: %s\nProvider: %s\nApprove in Sinless's Admin panel (not Campaign Chronicle).",
      $identity['name'] !== '' ? $identity['name'] : '(none)', $identity['email'], $provider));
  }
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

/** Notify a user (by email) that an admin changed their account status —
 * $kind is 'approved' or 'revoked'. Fire-and-forget: never throws, and a mail
 * failure must never break the admin action. Uses PHP mail(), which works on
 * shared hosting (e.g. DreamHost) when the From is an address on a domain the
 * host is authorized to send for, so SPF/DKIM align and it doesn't land in spam.
 *
 * Both events share one on/off switch: off unless the config 'approval_email'
 * block sets enabled=true and a 'from' address — existing deployments whose
 * config predates this key simply don't send. User input (to address) is
 * validated and never placed in a header, so there is no header-injection
 * surface; $displayName only ever appears in the body. */
function send_account_email(string $kind, string $toEmail, string $displayName): void {
  $cfg = (array) cfg('approval_email', []);
  if (empty($cfg['enabled']) || empty($cfg['from'])) return;
  $toEmail = trim($toEmail);
  if (!filter_var($toEmail, FILTER_VALIDATE_EMAIL)) return;

  $from   = (string) $cfg['from'];
  $appUrl = rtrim((string) cfg('base_url', ''), '/') . '/';
  $name   = trim($displayName) !== '' ? trim($displayName) : 'there';

  if ($kind === 'revoked') {
    $subject = (string) ($cfg['revoke_subject'] ?? 'Your Sinless account access was removed');
    $body = "Hi $name,\n\n"
          . "Your access to the Sinless Character Dossier has been removed by an "
          . "administrator. Your saved characters are kept and will be available "
          . "again if your access is restored.\n\n"
          . "If you think this was a mistake, reach out to whoever runs your group.\n";
  } else {
    $subject = (string) ($cfg['subject'] ?? 'Your Sinless account is approved');
    $body = "Hi $name,\n\n"
          . "Good news — your Sinless Character Dossier account has been approved. "
          . "You can sign in and start building characters now:\n\n"
          . "  $appUrl\n\n"
          . "See you in the sprawl.\n";
  }

  // Envelope sender (-f) improves deliverability and routes bounces; pull the
  // bare address out of a possible "Name <addr>" From value.
  $envelope = $from;
  if (preg_match('/<([^>]+)>/', $from, $m)) $envelope = $m[1];

  $headers = [
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'From: ' . $from,
    'Auto-Submitted: auto-generated',      // suppress auto-replies/vacation loops
    'X-Auto-Response-Suppress: All',
  ];
  if (!empty($cfg['reply_to'])) $headers[] = 'Reply-To: ' . (string) $cfg['reply_to'];

  try {
    $params = filter_var($envelope, FILTER_VALIDATE_EMAIL) ? '-f' . $envelope : '';
    if (@mail($toEmail, $subject, $body, implode("\r\n", $headers), $params) === false) {
      error_log("account email ($kind): mail() returned false for " . $toEmail);
    }
  } catch (Throwable $e) {
    error_log("account email ($kind) failed: " . $e->getMessage());
  }
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
