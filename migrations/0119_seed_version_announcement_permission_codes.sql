-- 0119_seed_version_announcement_permission_codes.sql
--
-- `/api/app/version` 与 `/api/app/announcements` 的两个权限码。
--
-- 2026-10-16 之前这两个端点**刻意匿名**，理由是「被强制升级的客户端、或从未登录的
-- 客户端也要能拿到升级描述符 / 停服公告」。该理由已作废：全新安装的 App 会带
-- `SecurityConfig.getApiKey()` 的内置凭证（实测就是 logcat 里那个 `mflc_…`，
-- `mUserInfoToken` 为空时由 `InterceptorHelper.loginBearer` 回落），所以不存在
-- 「没有凭证的客户端」。两个端点改为与 search-permission / mingci-permission 同形：
-- 要登录凭证 + 一个权限码。
--
-- 这两个码是 **App 能力权限**，不是后台页面权限，因此**不建后台菜单行、不进
-- ext_menu / ext_menu_permissions**：由权限树的 `OTHER_PAGE_PREFIXES` 合成页承接
-- （src/shared/Rbac.ts）。`app:version:*` / `app:announcement:*` 并入「运营管理」组
-- （RBAC_OPERATIONS_GROUP）的独立合成页「版本(App)」「公告(App)」，与后台
-- `system:*:manage` 页面解耦、可独立勾选；既守住「每个可分配码都出现在权限树」，
-- 也无需新建后台页面。与 0088（搜索）/名词解释同为「不建后台菜单行」，但那两个
-- 落 group_other 兜底，这两个挂运营管理组下（2026-10-16 用户要求移到运营管理）。
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式为 `p_<code 中 ':' → '_'>`，其余字符原样保留。
--        app:version:read      → p_app_version_read
--        app:announcement:read → p_app_announcement_read
--
-- 回滚：
--   DELETE FROM ext_permissions WHERE code IN ('app:version:read', 'app:announcement:read');

INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_app_version_read', 'app:version:read', '版本升级检查'),
  ('p_app_announcement_read', 'app:announcement:read', '运营公告');
