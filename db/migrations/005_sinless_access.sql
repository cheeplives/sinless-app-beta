-- 005_sinless_access.sql — Sinless keeps its own approval list, apart from Campaign Chronicle's. The two apps can share
-- the users table (one Google or GitHub sign-in for both), but approving or revoking someone in one app no longer lets
-- them into, or shuts them out of, the other. Someone who signs in to Sinless without a row here asks for access: they
-- get a 'pending' row, the signup alert names Sinless, and they wait in the Admin panel. Chronicle keeps its own list in
-- chronicle_access (its migration 020).
--
-- Everyone in the users table today keeps the Sinless access they have: approved stays approved, waiting waits,
-- revoked stays revoked.
--
-- Run ONCE against an existing database:
--   mysql -h <host> -u <user> -p <db> < db/migrations/005_sinless_access.sql
-- (Fresh installs get the table from db/schema.sql already.)
CREATE TABLE IF NOT EXISTS sinless_access (
  user_id       BIGINT UNSIGNED NOT NULL,
  status        ENUM('pending','approved','revoked') NOT NULL DEFAULT 'pending',
  requested_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at   DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (user_id),
  KEY idx_status (status),
  CONSTRAINT fk_sinless_access_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO sinless_access (user_id, status, requested_at, approved_at)
  SELECT id, status, created_at, approved_at FROM users;
