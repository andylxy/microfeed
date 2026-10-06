-- 0088_ext_search_permission_codes.sql
--
-- 搜索权限（App Search Permission，DESIGN §5.1 / ADR-0001）的两个权限码。
-- 这两个码是 App 能力权限（首页搜索框 / 书内搜索框），不是后台页面权限，
-- 因此**不建菜单行、不进 ext_menu / ext_menu_permissions**：
-- 它们由 `group_other/unmapped` 兜底组承接（src/shared/Rbac.ts 的 RBAC_OTHER_GROUP /
-- RBAC_OTHER_PAGE），既不破坏「每个可分配码都出现在权限树」的不变量，也无需新建后台页面。
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式为 `p_<code 中 ':' → '_'>`，其余字符原样保留。
--        app:search:global → p_app_search_global
--        app:search:book   → p_app_search_book
-- 手写下划线 id 让 seedRbac 的同码 INSERT OR IGNORE 变 no-op、授权外键找不到行，
-- 全新安装的 bootstrapAdmin 直接 500（0068/0082/0084 教训）。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 幂等：INSERT OR IGNORE。

INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_app_search_global', 'app:search:global', '搜索-首页'),
  ('p_app_search_book',   'app:search:book',   '搜索-书内');

-- 角色授权：本特性复用现有 RBAC 角色树，无需在此显式绑定。
-- 运营在既有「角色管理」页把码挂到目标角色叶子即可（见 .scratch/search-permission/OPS.md）。
-- super_admin 走 '*' 通配天然拥有，无需显式绑定。
-- editor / readonly 默认不授予——搜索是受管能力，需运营显式开放。
