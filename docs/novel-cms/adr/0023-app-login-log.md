# ADR-0023: 应用端登录日志（ext_app_login_log）

**状态**: 已接受
**日期**: 2026-10-12
**关联**: `0011` `0014` `0017` `0018`

## 背景

后台「设备清单」需要看到每台 Android 设备的最近登录时间、登录次数、版本、设备标识与登录窗口内的活跃度。相关能力由 `migrations/0084_ext_app_login_log.sql` 与 `migrations/0085_ext_app_login_log_count.sql` 引入，代码侧由 `src/server/app/version/login-log.ts` 与后台端点 `src/pages/[adminPath]/ajax/login-logs/index.ts` 消费。

## 决策

### 1. 表结构

`ext_app_login_log`（`migrations/0084` 建表，`migrations/0085` 补 `login_count`）：

- `id` 主键，由 `loginLogId()` 生成
- `user_id` 可空（匿名启动也可能记录），外键 `auth_user(id)` ON DELETE CASCADE
- `device_id` 必填
- `log_date` 必填（`YYYY-MM-DD` UTC 日期字符串）
- `login_at` 时间戳，必填
- `created_at` 默认当前时间
- `login_count` 整型计数，由 0085 增加
- 3 张索引：`ext_app_login_log_device(device_id, login_at DESC)`、`ext_app_login_log_login_at(login_at DESC)`、`ext_app_login_log_user_id(user_id, login_at DESC)`

去重语义：`UNIQUE (device_id, log_date)`，同一天同设备一条记录。主键 `id` 不承担去重——`ON CONFLICT (device_id, log_date)` 只覆盖这个 UNIQUE 索引。

### 2. 主键生成用 `loginLogId()` 做转义编码

`deviceId` 允许 `-` 与 `_`（见 `deviceIdFromRequest` 的 `^[A-Za-z0-9_-]+$`）。朴素规范化 `deviceId.replace(/[^a-zA-Z0-9]/g, "_")` 会把 `a-b` 与 `a_b` 折成同一个 id 撞主键，而 `ON CONFLICT` 只覆盖 UNIQUE 索引、不覆盖主键 → 语句抛错冒到鉴权链路（500）。

因此 `loginLogId()` 先转义再拼接：`_` → `__`、`-` → `_-`，后接 `_` 与去掉连字符的 `log_date`。转义后的编码可逆，字符集扩展后依然成立。

### 3. `DO NOTHING` → `DO UPDATE` 的演变

- `migrations/0084`：`ON CONFLICT(device_id, log_date) DO NOTHING`（只保留首次登录）
- `migrations/0085`：`ON CONFLICT DO UPDATE`（累加 `login_count`、覆盖 `login_at`）

回填 `login_count` 用 `1` 而非 `0`，否则列表出现「出现过但登录 0 次」的语义矛盾。

### 4. `log_date` 存 UTC

D1 无会话时区，`log_date` 与 `login_at` 都按 UTC 生成。后台的 6 个快捷窗口（`QUICK_RANGES`：1 / 7 / 30 / 90 / 182 / 365 天，见 `LoginLogsApp.tsx`）一律用 `login_at` 时间戳区间比较，避免跨时区错位。

### 5. 覆盖范围

- `migrations/0084`：写入点在 `src/server/rbac/resolve.ts` 的 `registerUserDevice`，其两个调用方都在身份验证之后，故当时 `user_id` 永不为 NULL
- `migrations/0085`：写入点改为 `GET /api/app/version`，覆盖联网的启动；`user_id` 允许 NULL。**2026-10-16 补注**：该端点已**不再匿名**（改为要登录凭证 + 权限码 `app:version:read`，见 ADR-0028 之后的 App 端点鉴权），但登录日志的写入被**刻意留在鉴权之前** —— 理由不变：这条日志要覆盖的正是「凭证缺失 / 无效的启动」，放在鉴权之后等于把目标人群排除掉。所以「覆盖联网的启动」与 `user_id` 可空两点**依旧成立**。
- 完全离线的启动无痕迹（业务侧接受；要覆盖需 App 本地排队后补报，未做）

### 6. 保留天数

`LOG_RETENTION_DAYS.appLogin = 180`（`src/server/maintenance.ts`），约 6 个月。`user_id` 索引由 `migrations/0084` 一并建立（`ext_app_login_log_user_id`），清理任务按同一常量裁剪。

### 7. 权限码

`system:login-log:read` / `system:login-log:manage`（`src/shared/Constants.ts` 的 `SYSTEM_LOGIN_LOG_READ` / `SYSTEM_LOGIN_LOG_MANAGE`，`src/server/rbac/seed.ts` 镜像）。`permissionId()`（`src/server/rbac/seed.ts`）只把 `:` 换成 `_`、连字符原样保留，故 id 为 `p_system_login-log_read` / `p_system_login-log_manage`——手写成下划线会让 `seedRbac` 的同码 `INSERT OR IGNORE` 变 no-op、授权外键找不到行，全新安装的 `bootstrapAdmin` 直接 500。

### 8. 菜单

`m_login_logs` 挂 `group_account`，sort 507，图标 `history`，权限码 `system:login-log:read`。菜单行与 `ext_menu_permissions` 映射都由 `migrations/0084` 建立；缺映射会让权限树里该码掉进「其他」桶，列表可见性判断随之走错。

### 9. editor / readonly 不授予

登录日志属治理类信息，editor 与 readonly 均不授予 read 权限。

## 后果

- 正：后台设备清单、活跃用户窗口统计、异常版本分布排查都有数据支撑
- 正：`user_id` 可空让"匿名启动"与"登录用户"能区分处理
- 负：`loginLogId()` 的转义编码是历史包袱，朴素规范化会撞主键且难以察觉
- 负：完全离线启动不产生记录，设备清单覆盖率有上限

## 替代方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| 采纳：device + user + 3 索引 | 覆盖三种常见查询（按设备、按用户、按时间倒序） | 3 张索引维护成本 |
| 仅 device_id 单索引 | 索引最少 | 后台按 user 过滤走全表扫描 |
| 事件表（每次登录一行） | 时间序列更细 | 数据量放大 10 倍以上，与 D1 定位冲突 |
