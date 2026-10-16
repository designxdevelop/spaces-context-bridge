-- Add lifecycle metadata without changing clients' column order. This remains
-- compatible with the previous Worker during migration-before-deploy or rollback.
CREATE TABLE IF NOT EXISTS client_activity(client TEXT PRIMARY KEY,last_used INTEGER NOT NULL);
-- Existing registrations have no authorization history. Preserve all of them for
-- one 37-day grace period from upgrade; do not infer inactivity from missing tokens.
-- INSERT OR IGNORE preserves the original grace time if this SQL is replayed.
INSERT OR IGNORE INTO client_activity(client,last_used)
  SELECT id,CAST(strftime('%s','now') AS INTEGER)*1000 FROM clients;
