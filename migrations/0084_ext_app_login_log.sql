-- 0084_ext_app_login_log.sql
--
-- App 登录时间日志（需求 3，ADR-0002）：记录「最后的登陆时间」，每天至多 1 条。
--
-- ## 为什么另建一张表，而不是复用 ext_user_devices.last_seen_at
--
-- `ext_user_devices`（0029）记的是「**最近一次**出现」，每个设备**永远只有一行**，
-- `last_seen_at` 每次鉴权请求都被覆盖。它能回答「这设备现在活跃吗」，
-- 但**回答不了**「这设备最近三个月里出现过哪几天」——历史被压扁成了一行。
-- 需求要的正是**按天留痕 + 按时间区间筛选**，所以必须按天累积成多行。
--
-- ## 去重键：(device_id, log_date)
--
-- 需求原文「每天为1次，不需要每次记录」。去重按**设备**而非用户：同一用户换设备
-- 会各记一行（语义是「这台设备今天登过」），这样「找出启动的App」才能定位到
-- 具体设备而不只是账号。`user_id` 同时存一份，供后台按人聚合。
-- 同一设备同一自然日再次登录由 **UNIQUE(device_id, log_date)** 冲突处理：0084 当时是
-- `DO NOTHING`，0085 起改为 `DO UPDATE` —— **累加 `login_count` 并覆盖 `login_at`**
-- （需求 3 追加：「每个检查算一次登录，更新最后登录时间，登录次数 +1」）。
-- 主键是 `id`，见下表的说明；去重靠的**不是**主键。
--
-- ## log_date 用本地日期还是 UTC
--
-- D1 无会话时区、拿不到「设备本地日历日」，故 `log_date` 存 UTC 日期；
-- 后台标签（ADR-0002 的 6 个滚动窗口）一律以 `login_at` 的时间戳做区间比较，
-- 不用 `log_date` 拼接，避免跨时区错位。
--
-- ## 覆盖范围（**已更新**；勿再按初版理解）
--
-- 本迁移落地时，写入点是 `rbac/resolve.ts` 的 `registerUserDevice`，而它的两个调用方
-- （`resolveRbacContext` 与 `credential-bearer.ts` 的 verified 分支）**都在身份验证之后**
-- 才执行，所以当时 `user_id` 实际**永不为 NULL**，且「未登录启动 / 只请求匿名
-- `/api/app/version` 的启动」在本表没有任何痕迹。
--
-- **0085 起写入点已改到匿名的 `GET /api/app/version`**（App 每次启动的那一次版本检查）：
--   ✅ 覆盖「**联网**的启动」，含未登录的（`user_id` 现在**真的可能为 NULL**）；
--   ❌ **完全离线**的启动仍无痕迹（没有请求发出），要覆盖需 App 本地排队后补报，未做。
--
-- 幂等：CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE。

-- 1. 登录日志表
CREATE TABLE IF NOT EXISTS ext_app_login_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES auth_user (id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  log_date TEXT NOT NULL,
  login_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- 同一设备同一自然日只留一条（需求「每天为1次」）。主键是上面的 `id`；
  -- 这个 UNIQUE 才是去重真正生效的地方（`ON CONFLICT (device_id, log_date) DO NOTHING`）。
  --
  -- ⚠️ `id` 必须是 deviceId 的**保长度编码**：deviceId 允许 `-` 与 `_`
  -- （见 `deviceIdFromRequest` 的 `^[A-Za-z0-9_-]+$`），朴素规范化会把 `a-b`
  -- 与 `a_b` 折成同一个 id → 撞主键，而上面的 `ON CONFLICT` 只覆盖 UNIQUE
  -- 索引、不覆盖主键 → 语句抛错冒到鉴权链路（500）。见 `loginLogId()`。
  UNIQUE (device_id, log_date)
);

-- 「某设备最后一次登录」：后台列表默认按此倒序。
CREATE INDEX IF NOT EXISTS ext_app_login_log_device ON ext_app_login_log (device_id, login_at DESC);
-- 「按时间区间找出启动过的 App」：6 个标签的滚动窗口都走这条。
CREATE INDEX IF NOT EXISTS ext_app_login_log_login_at ON ext_app_login_log (login_at DESC);
CREATE INDEX IF NOT EXISTS ext_app_login_log_user_id ON ext_app_login_log (user_id, login_at DESC);

-- 2. 权限码
-- ⚠️ id 必须与 `permissionId()` 逐字节一致：公式为 `p_<code 中 ':' → '_'>`，
--     **其余字符（含连字符）原样保留**。故：
--     system:login-log:read   → p_system_login-log_read   ← 连字符保留！
--     system:login-log:manage → p_system_login-log_manage ← 连字符保留！
-- 手写下划线 id 会让 `seedRbac` 的同码 `INSERT OR IGNORE` 变 no-op、授权外键找不到行，
-- 全新安装的 bootstrapAdmin 直接 500（0068/0082 教训）。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），
--        由 `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_login-log_read',   'system:login-log:read',   '登录日志查看'),
  ('p_system_login-log_manage', 'system:login-log:manage', '登录日志管理');

-- 3. 后台菜单行
-- 挂在「账户」组 group_account（与 devices=505 / app_versions=506 同级），
-- sort 507 排在其后。⚠️ 菜单行必须同时挂 parent_code 组 **和** ext_menu_permissions
-- 映射，二者缺一不可，否则菜单可见性与页面守卫错位（0083 教训）。
--
-- 图标 `history` —— lucide-react 合法图标名，且必须已登记到
-- `src/components/admin/AdminMenuItemLink.tsx` 的 MENU_ICONS 映射（ADR-0007）；
-- 未登记会静默回退 ListIcon（不报错，最难发现）。
--
-- path 用页面目录名 login-logs（连字符），注意与菜单 code login_logs 不同。
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_login_logs', 'login_logs', 'group_account', 'login-logs', 'menu.item.login_logs', 'history', 'system:login-log:read', 507, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 4. 菜单 → 权限映射（角色编辑器按菜单组织权限树；缺映射的码会掉进「其他」桶）
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('login_logs', 'system:login-log:read'),
  ('login_logs', 'system:login-log:manage');

-- 5. 角色授权：本特性是治理类，editor / readonly 均不授予。
--    super_admin 走 '*' 通配天然拥有一切，无需显式绑定。
