<?php
/**
 * config.example.php — copy to config.php and fill in.
 *
 *   cp api/config.example.php api/config.php
 *
 * config.php holds secrets (DB password, OAuth client secrets) and is
 * gitignored. On Apache the bundled .htaccess denies direct access to it, but
 * the most robust option is to keep it ABOVE the web root. lib.php looks for the
 * config in this order (first match wins), so no path editing is needed:
 *   1. the $SINLESS_CONFIG env var (absolute path)
 *   2. <one level above DOCUMENT_ROOT>/sinless-config.php   (e.g. ~/sinless-config.php)
 *   3. $HOME/sinless-config.php
 *   4. api/config.php  (this in-tree location)
 * So to harden: `mv api/config.php ~/sinless-config.php` and it just works.
 * Never commit the real config.
 *
 * This file returns a plain array; lib.php reads it via require.
 */

return [

  // --- Database (MySQL) -----------------------------------------------------
  'db' => [
    'host'     => '127.0.0.1',
    'port'     => 3306,
    'name'     => 'sinless',
    'user'     => 'sinless_app',
    'password' => 'CHANGE_ME',
    'charset'  => 'utf8mb4',
  ],

  // --- Where the app lives --------------------------------------------------
  // Absolute base URL of the site (no trailing slash), used to build the OAuth
  // redirect_uri and to validate post-login redirects as same-origin.
  'base_url' => 'https://example.com',

  // --- OAuth providers ------------------------------------------------------
  // Register each app with the provider and set the callback to:
  //   <base_url>/api/auth/callback.php
  // Leave a provider's client_id empty to hide its sign-in button.
  'oauth' => [
    'google' => [
      'client_id'     => '',
      'client_secret' => '',
    ],
    'github' => [
      'client_id'     => '',
      'client_secret' => '',
    ],
  ],

  // --- First admin(s) -------------------------------------------------------
  // Identities here are auto-approved AND flagged admin on first sign-in, so the
  // owner can get in and approve everyone else. Match either the verified email
  // or the "provider:provider_user_id" form (e.g. "github:1432").
  'admin_identities' => [
    // 'you@gmail.com',
    // 'github:0000000',
  ],

  // --- Signup notification --------------------------------------------------
  // Discord or Slack "incoming webhook" URL. When a NEW user lands in the
  // pending queue, the server POSTs a short alert here (fire-and-forget).
  // Leave empty to disable notifications.
  'approval_webhook_url' => '',

  // --- Session / cookie -----------------------------------------------------
  'session' => [
    'name'            => 'sinless_sid',
    'idle_timeout'    => 60 * 60 * 24 * 14,   // seconds of inactivity before logout (14d)
    'absolute_timeout'=> 60 * 60 * 24 * 60,   // hard cap on a session's life (60d)
    // Set false ONLY for local http testing; MUST be true in production (HTTPS).
    'cookie_secure'   => true,
    // Optional dedicated session file dir (recommended on shared hosting so
    // other tenants can't read session files). Must be writable, outside webroot.
    'save_path'       => '',
  ],

  // --- Limits ---------------------------------------------------------------
  'max_character_bytes' => 262144,   // 256 KB cap on a single character payload
  'max_custom_bytes'    => 1048576,  // 1 MB cap on the homebrew blob

  // Per-IP throttling on sign-in + per-user throttling on writes (needs the
  // rate_limits table from db/schema.sql). Leave true; set false only to debug.
  'rate_limit_enabled' => true,

  // Set true only while debugging locally — leaks errors to the client. Keep
  // false in production (errors go to the PHP error log instead).
  'debug' => false,
];
