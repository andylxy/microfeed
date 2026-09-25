-- B12: webhook_alerts.resolved_at had no writer anywhere — only one-time
-- kind='fanout_limit' notices are created (events.ts), and the prune only
-- removed already-resolved rows, so open alerts accumulated forever. Drop the
-- dead column and re-index on created_at so pruning is age-based.
DROP INDEX IF EXISTS webhook_alerts_open;
ALTER TABLE webhook_alerts DROP COLUMN resolved_at;
CREATE INDEX IF NOT EXISTS webhook_alerts_open
ON webhook_alerts (created_at DESC);
