-- ONLY for an isolated restored database with producers, worker and cron paused.
-- Keep a protected backup. This intentionally invalidates restored authorization.
-- It does not remove completed results or change external Pages/recordings.
DELETE FROM codes;
DELETE FROM consents;
DELETE FROM tokens;
DELETE FROM subscriptions;
DELETE FROM deliveries;
DELETE FROM client_activity;
DELETE FROM clients;
DELETE FROM rate_limits;
UPDATE requests SET status='failed', lease=NULL, lease_expires=NULL,
  updated=CAST(strftime('%s','now') AS INTEGER)*1000,
  result=COALESCE(result,'') || char(10) || 'Restored snapshot quarantined. Reconcile external effects before submitting a new request.'
WHERE status IN ('queued','processing');
