-- 0130_seed_app_capability_console.sql
--
-- App 能力管理的守卫码 + 节点叶子（ADR-0039 D5）。
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式 `p_<code 中 ':' → '_'>`，其余字符原样保留：
--        system:app-capability:manage → p_system_app-capability_manage
--    手写错的 id 会让 seedRbac 的同码 INSERT OR IGNORE 变 no-op（code 上有 UNIQUE），
--    目录里留下非规范 id 的行，授权外键从此找不到它。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 角色授权：本文件**不写** `ext_role_permissions`。super_admin 靠 `*` 通配天然拥有，
-- editor / readonly 不授予。
--
-- 菜单：不动 `ext_menu`。权限管理是单页（/admin/rbac），页面守卫沿用既有
-- `rbac` 菜单行绑定的 `system:role:manage`；这一个码只用于 App 端数据分区的
-- 服务端判定，不新增菜单行（0131 起单页口径，双控制台入口退役）。
--
-- 不改 `ext_menu_permissions`（ADR-0038 起零读零写，菜单可见性只认
-- `ext_menu.permission_code` 直列）。
--
-- 幂等：INSERT OR IGNORE，重复执行安全。
--
-- type = seed（新增控制台的登记行，豁免 MIG-004 的回滚块要求）。回滚块照写：
-- rollback:
--   DELETE FROM ext_permission_nodes WHERE code = 'system:app-capability:manage';
--   DELETE FROM ext_permissions WHERE code = 'system:app-capability:manage';

-- 1. 权限码
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_app-capability_manage', 'system:app-capability:manage', 'App 能力管理');

-- 2. 节点叶子：挂在「角色与权限」页下（桌面端），与 system:role:manage 并列
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_system_app-capability_manage', 'system:app-capability:manage', 'code', 'page_rbac', 1, 'desktop', 'system:app-capability:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
