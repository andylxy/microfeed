-- 0089_ext_menu_operations_group.sql
--
-- 新增顶层分组「运营管理」（group_operations），把 4 个 App 运营/治理类页面从
-- 「账户」组 group_account 迁入：
--     devices(设备管理) / app_versions(版本管理) / login_logs(登录日志) / announcements(公告管理)
--
-- 为什么新开一组：这 4 页治理的是「App 侧运行」，受众与账户组里的
-- 角色/用户/RBAC 留痕（rbac / users / rbac_audit）不是一类；账户组只留账号与权限治理。
--
-- 只改 ext_menu 的 parent_code + sort：
--   * 不动权限码（ext_permissions）、不动菜单→权限映射（ext_menu_permissions）——
--     权限树的「页面宿主」映射与分组无关，搬迁后仍归属各自页面；
--   * 不动角色授权（ext_role_permissions），治理类默认不授予 editor/readonly。
--
-- 组行规则（0050 模式）：
--   path = ''            → 组不是链接，无可跳转目标（readAdminMenu 会指向首个可见子项）
--   permission_code NULL → 公开；readAdminMenu 会剪掉没有可见子项的组，
--                          因此账号永远看不到空标题
--   code 前缀 group_     → ext_menu.code UNIQUE，页面码已占用
--
-- sort：新组 600 排在「账户」(500) 之后，组内序号从 601 起（0050 约定）。
-- 4 行原来的 505/506/507/508 被下面的绝对 UPDATE 覆盖，不残留。
--
-- 图标 `activity` —— lucide-react 合法图标名，且必须已登记到
-- `src/components/admin/AdminMenuItemLink.tsx` 的 MENU_ICONS 映射（ADR-0007）；
-- 未登记会静默回退 ListIcon（不报错，最难发现）。
--
-- 幂等：INSERT OR IGNORE 建组 + 绝对 UPDATE 改归属，重复执行安全。

INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_group_operations', 'group_operations', NULL, '', 'menu.group.operations', 'activity', NULL, 600, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 4 个页面改挂「运营管理」组，组内序号从 601 起
UPDATE ext_menu SET parent_code = 'group_operations', sort = 601 WHERE code = 'devices';
UPDATE ext_menu SET parent_code = 'group_operations', sort = 602 WHERE code = 'app_versions';
UPDATE ext_menu SET parent_code = 'group_operations', sort = 603 WHERE code = 'login_logs';
UPDATE ext_menu SET parent_code = 'group_operations', sort = 604 WHERE code = 'announcements';
