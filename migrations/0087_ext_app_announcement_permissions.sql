-- 0087_ext_app_announcement_permissions.sql
--
-- 公告（Announcements，DESIGN §5.5）的权限码 + 后台菜单行。
-- 与 0082（device/app-version）、0084（login-log）同属「治理类」，挂在 group_account 组。
--
-- ⚠️ id 必须与 `permissionId()` 逐字节一致：公式为 `p_<code 中 ':' → '_'>`，
--    其余字符原样保留。本特性的 code 不含连字符，故：
--        system:announcement:read   → p_system_announcement_read
--        system:announcement:manage → p_system_announcement_manage
-- 手写下划线 id（如 `p_system_announcement_read` 误写成 `p_system_announcement_read` 之外的变体）
-- 会让 `seedRbac` 的同码 `INSERT OR IGNORE` 变 no-op、授权外键找不到行，
-- 全新安装的 bootstrapAdmin 直接 500（0068/0082/0084 教训）。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 幂等：INSERT OR IGNORE。

-- 1. 权限码
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_announcement_read',   'system:announcement:read',   '公告查看'),
  ('p_system_announcement_manage', 'system:announcement:manage', '公告管理');

-- 2. 后台菜单行
-- 挂在「账户」组 group_account（与 devices=505 / app_versions=506 / login_logs=507 同级），
-- sort 508 排在其后。⚠️ 菜单行必须同时挂 parent_code 组 **和** ext_menu_permissions
-- 映射，二者缺一不可，否则菜单可见性与页面守卫错位（0083 教训）。
--
-- 图标 `file-text` —— lucide-react 合法图标名，且已登记到
-- `src/components/admin/AdminMenuItemLink.tsx` 的 MENU_ICONS 映射（ADR-0007）；
-- 未登记会静默回退 ListIcon（不报错，最难发现）。
--
-- path 用页面目录名 announcements（连字符），注意与菜单 code announcements 不同。
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_announcements', 'announcements', 'group_account', 'announcements', 'menu.item.announcements', 'file-text', 'system:announcement:read', 508, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 菜单 → 权限映射（角色编辑器按菜单组织权限树；缺映射的码会掉进「其他」桶）
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('announcements', 'system:announcement:read'),
  ('announcements', 'system:announcement:manage');

-- 4. 角色授权：本特性是治理类，editor / readonly 均不授予。
--    super_admin 走 '*' 通配天然拥有一切，无需显式绑定。
