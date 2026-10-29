-- 0154_seed_mail_settings.sql
--
-- 邮件设置的权限码（邮箱 + 验证码注册）。配置本体存 `settings` 表
-- category='mail_settings'（由 `src/server/mail/mail-config.ts` 读写，本迁移不碰）。
--
-- ## 权限码（治理类，挂 group_operations）
--
--   system:mail-settings:read    打开「邮件设置」卡片、读配置
--   system:mail-settings:manage  保存发信地址 / 发信名称 / 主题与正文模板
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式 `p_<code 中 ':' → '_'>`，其余字符原样保留——**连字符不转换**：
--        system:mail-settings:read   → p_system_mail-settings_read
--        system:mail-settings:manage → p_system_mail-settings_manage
--    先例见 0145 / 0150。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 角色授权：本文件**不写** `ext_role_permissions`。super_admin 靠 `*` 通配
-- 天然拥有，editor / readonly 不授予（治理类口径，与 0145 关于页一致）。
--
-- 不建 `ext_menu` 行：邮件设置是后台「设置」区里的一张卡片（与 SiteSettings /
-- SubscribeSettings 同层），不是侧栏独立条目，因此无菜单行、无 i18n menu key。
--
-- 幂等：INSERT OR IGNORE。type = seed，回滚块照写（豁免 MIG-004）：
-- rollback:
--   DELETE FROM ext_permission_nodes WHERE code IN ('system:mail-settings:read', 'system:mail-settings:manage');
--   DELETE FROM ext_permissions WHERE code IN ('system:mail-settings:read', 'system:mail-settings:manage');

-- 1. 权限码
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_mail-settings_read',   'system:mail-settings:read',   '邮件设置查看'),
  ('p_system_mail-settings_manage', 'system:mail-settings:manage', '邮件设置管理');

-- 2. 权限树节点：两个码叶子挂 group_operations（治理类，与 login-methods 同族）。
--    sort 610 / 611：0150 的 page_login_methods 占 609，取其后顺延。
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, path, entry_code, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_system_mail-settings_read', 'system:mail-settings:read', 'code', 'group_operations', 610, 'desktop', NULL, NULL, 'system:mail-settings:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_mail-settings_manage', 'system:mail-settings:manage', 'code', 'group_operations', 611, 'desktop', NULL, NULL, 'system:mail-settings:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
