-- 0062_ext_menu_rbac_audit.sql
--
-- C3: ext_rbac_audit (0054) was write-only — no page ever showed the trail, so
-- "who changed which role or grant" had no reachable answer. Add the menu row
-- for the read-only audit page (same 0050 group mechanism as 0061), bound to
-- `system:role:manage`: the trail records role and grant mutations, and the
-- page guard uses that same code, so menu and guard stay one and the same.
--
-- Idempotent: INSERT OR IGNORE.

INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_rbac_audit', 'rbac_audit', 'group_account', 'rbac/audit', 'menu.item.rbac_audit', 'history', 'system:role:manage', 504, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
