-- ARCHIVE ONLY, not run by Wrangler. Upgrades an untouched 0.1.0 database to the 0.1.2 columns,
-- after which migrations/0001_initial.sql is a no-op. Not idempotent: ALTER fails if already applied.
-- Only pre-release 0.1.0 databases need it; fresh installs and 0.1.2+ databases never do.
ALTER TABLE subscriptions ADD COLUMN client TEXT;
ALTER TABLE subscriptions ADD COLUMN previous_secret TEXT;
ALTER TABLE subscriptions ADD COLUMN rotate_until INTEGER;
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,n INTEGER NOT NULL,expires INTEGER NOT NULL);
