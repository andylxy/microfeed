-- 0046_drop_ext_user_permissions.sql
--
-- Rollback of migration 0045: the per-account permission override feature was
-- removed. Multi-role access is a pure union of the account's role grants
-- (`resolveUserPermissions`, SELECT DISTINCT), which is already what the
-- operator expresses by ticking several roles on the account. A per-account
-- grant/deny layer added nothing on top and has been dropped.
--
-- Idempotent: the table only exists on deployments that ran 0045. Fresh
-- deployments never create it, so `IF EXISTS` keeps this a no-op there.

DROP TABLE IF EXISTS ext_user_permissions;
