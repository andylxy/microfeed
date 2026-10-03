-- 0083_ext_app_device_version_menu.sql
--
-- 设备管理（/admin/devices/）与版本管理（/admin/app-versions/）的后台菜单行。
--
-- 挂在「账户」组 group_account（0050 模式；与 rbac=501、users=502、rbac_audit=504 同级），
-- sort 505/506 排在 rbac_audit 之后（503/504 会与 rbac_audit 的 504 撞号，靠 code 兜底排序
-- 是隐式歧义，故避开）。⚠️ 菜单行必须同时挂 parent_code 组 **和**
-- ext_menu_permissions 映射，二者缺一不可，否则菜单可见性与页面守卫错位。
--
-- 图标：`smartphone` / `download` —— 两个都是合法 lucide-react 图标名，且必须
-- 已登记到 `src/components/admin/AdminMenuItemLink.tsx` 的 MENU_ICONS 映射
-- （ADR-0007）；未登记会静默回退 ListIcon（不报错，最难发现）。
--
-- path 用页面目录名：devices / app-versions（注意 app-versions 是连字符，
-- 与菜单 code app_versions 不同）。
--
-- 幂等：INSERT OR IGNORE。

-- 1. 菜单行
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_devices',      'devices',      'group_account', 'devices',      'menu.item.devices',      'smartphone', 'system:device:read',      505, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_app_versions', 'app_versions', 'group_account', 'app-versions', 'menu.item.app_versions', 'download',   'system:app-version:read', 506, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 2. 菜单 → 权限映射（角色编辑器按菜单组织权限树；缺映射的码会掉进「其他」桶）
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('devices', 'system:device:read'),
  ('devices', 'system:device:manage'),
  ('app_versions', 'system:app-version:read'),
  ('app_versions', 'system:app-version:manage');

-- 3. 角色授权：本特性是治理类，editor / readonly 均不授予。
--    super_admin 走 '*' 通配天然拥有一切，无需显式绑定。
