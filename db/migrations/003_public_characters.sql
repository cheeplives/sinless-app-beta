-- 003_public_characters.sql — add per-character public/private sharing.
-- Run ONCE against an existing database:
--   mysql -h <host> -u <user> -p <db> < db/migrations/003_public_characters.sql
-- (Fresh installs get this from db/schema.sql already; re-running here errors
--  harmlessly with "Duplicate column name".)

ALTER TABLE characters
  ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 0 AFTER client_updated_at,
  ADD KEY idx_public (is_public);
