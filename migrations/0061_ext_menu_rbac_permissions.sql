-- 0061_ext_menu_rbac_permissions.sql
--
-- B27: the RBAC menu row (0041) binds `system:role:manage` only, while the
-- permission-grant endpoints require `system:permission:manage` — an account
-- holding only that code had no navigation entry at all and could not reach
-- the grants it is allowed to manage.
--
-- Add a grouped child row (same 0050 group mechanism) bound to
-- `system:permission:manage`, pointing at the new permission-grants page whose
-- page guard uses that same code, so menu and guard stay one and the same.
-- The users row moves down one slot to keep 角色 → 权限 → 用户 ordering.
--
-- Idempotent: INSERT OR IGNORE plus an absolute UPDATE.

INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_rbac_permissions', 'rbac_permissions', 'group_account', 'rbac/permissions', 'menu.item.rbac_permissions', 'key-round', 'system:permission:manage', 502, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

UPDATE ext_menu SET sort = 503 WHERE code = 'users';
