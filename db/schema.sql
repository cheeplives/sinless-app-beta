-- schema.sql — Sinless server-side storage (MySQL 5.7+/8+, utf8mb4).
--
-- Import once into the app's database, e.g.:
--   mysql -u <user> -p <database> < db/schema.sql
-- or paste into phpMyAdmin's SQL tab.
--
-- Three tables: accounts (users), their characters, and one homebrew blob each.
-- Character/homebrew payloads are opaque JSON produced by the client engine —
-- the server never interprets them, it only stores and serves them per user.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- users — one row per (OAuth provider identity). Keyed on the provider's
-- stable user id, never on email (emails change / can be unverified).
-- New sign-ups land as 'pending' until an admin approves them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider          VARCHAR(16)  NOT NULL,              -- 'google' | 'github'
  provider_user_id  VARCHAR(191) NOT NULL,              -- stable id at the provider
  email             VARCHAR(191) NOT NULL,
  display_name      VARCHAR(191) NOT NULL DEFAULT '',
  avatar_url        VARCHAR(512) NOT NULL DEFAULT '',
  status            ENUM('pending','approved','revoked') NOT NULL DEFAULT 'pending',
  is_admin          TINYINT(1)   NOT NULL DEFAULT 0,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at       DATETIME     NULL DEFAULT NULL,
  last_login_at     DATETIME     NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_identity (provider, provider_user_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- characters — one row per (user, slug). `slug` is the sanitized street name
-- (the client's storage key); `name` is the display street name. `data` is the
-- full character JSON. `client_updated_at` is the client's edit timestamp, used
-- for last-write-wins on sync.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS characters (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  slug              VARCHAR(80)  NOT NULL,              -- ^[A-Za-z0-9_-]{1,80}$
  name              VARCHAR(191) NOT NULL DEFAULT '',
  data              LONGTEXT     NOT NULL,              -- character JSON (opaque)
  client_updated_at BIGINT UNSIGNED NOT NULL DEFAULT 0, -- epoch ms from the client
  is_public         TINYINT(1)   NOT NULL DEFAULT 0,    -- 1 = visible to other members
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_slug (user_id, slug),
  KEY idx_user (user_id),
  KEY idx_public (is_public),
  CONSTRAINT fk_characters_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- custom_content — one homebrew blob per user (the same JSON shape the client
-- stores under sinless:custom:content).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_content (
  user_id     BIGINT UNSIGNED NOT NULL,
  data        LONGTEXT NOT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                       ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_custom_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- rate_limits — fixed-window counters for lib.php rate_limit(). Keyed by
-- (bucket, id) where id is a client IP (auth endpoints) or "u<user_id>"
-- (writes). Stale rows are GC'd opportunistically; safe to truncate anytime.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        VARCHAR(32)  NOT NULL,
  id            VARCHAR(64)  NOT NULL,
  window_start  INT UNSIGNED NOT NULL,
  hits          INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, id),
  KEY idx_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
