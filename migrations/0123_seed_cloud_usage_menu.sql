-- 0123_seed_cloud_usage_menu.sql
--
-- 「Cloudflare 使用情况」仪表盘（/admin/cloud-usage）的权限码 + 后台菜单行。
-- 看板本身是只读运维视图，一个码覆盖 D1 / R2 / Workers 三个分区，
-- 与 0084 的 system:login-log:read 同族。挂在「运营管理」组 group_operations（0089），
-- sort 605 排在 announcements（604）之后。
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式为 `p_<code 中 ':' → '_'>`，其余字符原样保留——**连字符不转换**：
--        system:cloud-usage:read → p_system_cloud-usage_read
--    先例见 0082：system:app-version:read → p_system_app-version_read。
--    手写错的 id 会让 seedRbac 的同码 INSERT OR IGNORE 变 no-op（code 上有 UNIQUE），
--    目录里留下一个非规范 id，将来把该码授给角色时授权外键找不到行。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 角色授权（拍板 B1）：本文件**不写** `ext_role_permissions`。super_admin 靠 `*`
-- 通配天然拥有，editor / readonly 不授予——运维用量数据只给超级管理员看。
--
-- 看板口径（页面与卡片的附注即此口径，官方出处见 src/server/cloud-usage/limits.ts）：
--
--   * D1 免费额度（d1/platform/limits + pricing）：数据库 10 个、读 5M 行/日、
--     写 100k 行/日、存储 5 GB/账号。`rowsRead` 统计的是**扫描行数**——没有索引的
--     查询扫 9,506 行就计 9,506 行，与返回行数无关。
--   * R2 免费额度（r2/pricing）：存储 10 GB-month/月、Class A 1,000,000 次/月、
--     Class B 10,000,000 次/月、出口流量免费。GB-month 按官方公式
--     「当月每日峰值求和 ÷ 30」；Class A / B 只认官方清单，
--     DeleteObject / DeleteBucket / AbortMultipartUpload 三类免费操作不计入。
--   * Workers 免费额度（workers/platform/pricing）：100,000 请求/日、单次 CPU 10ms。
--     子请求不计费；CPU 超出单次上限直接报错，不计费。
--   * 「计量存储」官方未公开字段与公式。本页按拍板 A1 折算：当前 UTC 月每日
--     max{databaseSizeBytes} 求和 ÷ 1024，单位 kB-mo。该折算值与 Cloudflare
--     控制台的「Metered storage」**不可比**（官方未公开其口径，实测可差两个
--     量级），卡片附注必须写明以控制台为准。
--
-- 时间口径：Cloudflare 额度一律按 UTC 重置——日额度 UTC 00:00 重置，即北京时间
-- 每日 08:00；月额度 UTC 月首 00:00 重置，即北京时间每月 1 日 08:00。数据拉取按
-- UTC 窗口过滤，换算只发生在展示层。
--
-- 幂等：全部 INSERT OR IGNORE，重复执行安全。

-- 1. 权限码
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_cloud-usage_read', 'system:cloud-usage:read', 'Cloudflare 用量查看');

-- 2. 后台菜单行
-- ⚠️ 菜单行必须同时挂 parent_code 组 **和** ext_menu_permissions 映射，
-- 二者缺一不可，否则菜单可见性与页面守卫错位（0083 教训）。
--
-- 图标 `database` —— lucide-react 合法图标名，且已登记到
-- `src/components/admin/AdminMenuItemLink.tsx` 的 MENU_ICONS 映射（ADR-0007）；
-- 未登记会静默回退 ListIcon。
--
-- path 用页面目录名 cloud-usage（连字符），与菜单 code cloud_usage（下划线）不同。
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_cloud_usage', 'cloud_usage', 'group_operations', 'cloud-usage', 'menu.item.cloud_usage', 'database', 'system:cloud-usage:read', 605, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 菜单 → 权限映射（角色编辑器按菜单组织权限树；缺映射的码会掉进「其他」桶）
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('cloud_usage', 'system:cloud-usage:read');

-- 4. 角色授权：拍板 B1——不写 ext_role_permissions 行。
