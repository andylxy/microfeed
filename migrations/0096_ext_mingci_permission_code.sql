-- 0096_ext_mingci_permission_code.sql
--
-- 名词解释查看权限（App MingCi View Permission，G3 全局单开关 → 一个码）。
-- 该码是 App 能力权限（阅读页 `$g{名词解释}` 的底层名词数据加载闸门），
-- 不是后台页面权限，因此**不建菜单行、不进 ext_menu / ext_menu_permissions**：
-- 它由 `group_other/unmapped` 兜底组承接（src/shared/Rbac.ts 的 RBAC_OTHER_GROUP /
-- RBAC_OTHER_PAGE），既不破坏「每个可分配码都出现在权限树」的不变量，也无需新建后台页面。
-- 与 search-permission（0088）同构。
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式为 `p_<code 中 ':' → '_'>`，其余字符原样保留。
--        app:mingci:view → p_app_mingci_view
-- 手写下划线 id 让 seedRbac 的同码 INSERT OR IGNORE 变 no-op、授权外键找不到行，
-- 全新安装的 bootstrapAdmin 直接 500（0068/0082/0084 教训）。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/worker/rbac.test.ts` 守住。
--
-- 幂等：INSERT OR IGNORE。

INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_app_mingci_view', 'app:mingci:view', '名词解释查看');

-- 角色授权：本特性复用现有 RBAC 角色树，无需在此显式绑定。
-- 运营在既有「角色管理」页把码挂到目标角色叶子即可（同 search-permission 的 OPS 路径）。
-- super_admin 走 '*' 通配天然拥有，无需显式绑定。
-- editor / readonly 默认不授予——名词解释查看是受管能力，需运营显式开放。
