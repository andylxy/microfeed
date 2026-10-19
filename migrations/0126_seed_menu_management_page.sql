-- 0126_seed_menu_management_page.sql
--
-- 「菜单管理」页（/admin/menu）的权限码 + 后台菜单行（票 03）。
-- 页面读写共用一个码 system:menu:manage：打开看板与保存改动是同一件事
-- （运营在整理导航），只用一个 :manage 码覆盖读写。挂在「账户」组 group_account，
-- sort 503 排在 rbac_permissions（502）与 rbac_audit（504）之间。
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式为 `p_<code 中 ':' → '_'>`，其余字符原样保留：
--        system:menu:manage → p_system_menu_manage
--    手写错的 id 会让 seedRbac 的同码 INSERT OR IGNORE 变 no-op（code 上有 UNIQUE），
--    目录里留下一个非规范 id，将来把该码授给角色时授权外键找不到行。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 角色授权：本文件**不写** `ext_role_permissions`。super_admin 靠 `*`
-- 通配天然拥有，editor / readonly 不授予——菜单结构是站点骨架，只给超级管理员改。
--
-- 页面守卫与菜单行绑定同一个码（admin-page-guards 的硬规则）：
-- src/pages/[adminPath]/menu/index.astro 用 PERMISSION_CODES.SYSTEM_MENU_MANAGE。
--
-- 单向性（与 0125 同口径）：菜单管理页改的是**数据库行**，本迁移只播种
-- 页面自身的菜单行；运营在管理页做的重命名/排序/显隐/改父节点不会回写到这里。
-- 已部署实例以数据库为准；全新安装跑完迁移拿到的是本文件播种的初始结构。
-- 管理页的「导出 SQL」按钮把当前数据库状态导成新的 data 迁移交用户自行提交。
--
-- 图标 `list` —— 已登记到 `src/components/admin/AdminMenuItemLink.tsx` 的
-- MENU_ICONS 映射；未登记会静默回退 ListIcon（不报错，最难发现）。
--
-- 幂等：全部 INSERT OR IGNORE，重复执行安全。

-- 1. 权限码
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_menu_manage', 'system:menu:manage', '菜单管理');

-- 2. 后台菜单行
-- ⚠️ 菜单行必须同时挂 parent_code 组 **和** ext_menu_permissions 映射，
-- 二者缺一不可，否则菜单可见性与页面守卫错位（0083 教训）。
--
-- path 用页面目录名 menu，与菜单 code menu_management 不同。
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_menu_management', 'menu_management', 'group_account', 'menu', 'menu.item.menu_management', 'list', 'system:menu:manage', 503, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 菜单 → 权限映射（角色编辑器按菜单组织权限树；缺映射的码会掉进「其他」桶）
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('menu_management', 'system:menu:manage');

-- 4. 角色授权：不写 ext_role_permissions 行（super_admin 走 '*' 通配）。
