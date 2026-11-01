# ADR-0053: 权限快照表 `ext_user_permissions`

- 状态：Accepted
- 日期：2026-11-01
- 关联：ADR-0052（权限判定保持自研，本 ADR 是它的后续优化）、ADR-0008（API 认证与授权收敛）、ADR-0038（自持权限树）、ADR-0039（按终端归属分区）、ADR-0040（角色级 `allow_admin_login`）、ADR-0049（缓存正确性与写额度）、`CONTEXT.md`（角色分配 / 角色镜像 / 权限快照 / 权限判定）

## 背景

后台每个已登录请求都要在 `resolveRbacContext` 里解析权限。改造前它是 3 条 SQL（`Promise.all` 并发成 1 趟往返）：

| 语句 | 读法 | 返回 |
|---|---|---|
| 权限集合 | `ext_user_roles → ext_roles → ext_role_permissions → ext_permissions`，4 表 3 JOIN | 25 行 |
| 后台准入 | `ext_user_roles → ext_roles`，取 `MAX(allow_admin_login)` | 1 行 |
| 封禁 + 待改密 | `auth_user LEFT JOIN ext_user_security` | 1 行 |

2026-11-01 在本机实例副本上实测（9 个账号，`ext_user_roles` 10 行 / `ext_roles` 5 行 / `ext_role_permissions` 63 行 / `ext_permissions` 65 行）：

| 指标 | 实测 |
|---|---|
| 执行计划 | 四个访问点全部 `SEARCH ... USING COVERING INDEX`，无表扫、无临时 B-tree |
| 单条耗时（2 万次基准） | 权限 18.35 µs / 准入 3.56 µs / 闸门 3.38 µs，串行合计 **25.33 µs** |
| 一次 D1 往返 | 1–5 ms（生产跨区域） |

也就是说：**四表 JOIN 的 CPU 只占一次往返的 0.4%–1.8%，瓶颈不在 JOIN 层数。** 仓库里已有 `cachedUserAccess`（`src/server/cache/identity-cache.ts`，按 `userId`、TTL 24h、`identity` 桶默认开启）来消掉往返，但它只有一个调用点 `src/server/api/credential-bearer.ts:206`（App 凭证路径）。

所以后台路径每次请求都在付一次往返，而这次往返读的是二十几行几乎不变的数据。角色、授权、用户角色分配三者都是人工月级操作。

## 决策

新增一张按账号物化的权限快照表，后台鉴权从 3 条 SQL 合成 1 条：

```sql
CREATE TABLE ext_user_permissions (
  user_id             TEXT    NOT NULL PRIMARY KEY
                              REFERENCES auth_user(id) ON DELETE CASCADE,
  codes               TEXT    NOT NULL,   -- JSON 数组，零权限为 '[]'
  is_member           INTEGER NOT NULL DEFAULT 0,
  admin_login_allowed INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT    NOT NULL
);
```

读路径：

```sql
SELECT s.codes, s.is_member, s.admin_login_allowed,
       u.banned, COALESCE(sec.must_change_password, 0) AS mustChange
FROM auth_user u
LEFT JOIN ext_user_permissions s ON s.user_id = u.id
LEFT JOIN ext_user_security sec ON sec.user_id = u.id
WHERE u.id = ?
```

四条约束同时成立：

1. **`banned` 不进快照。** 它由 `auth.api.banUser` 写入（`src/server/admin/rbac-handlers.ts:1370`），是 Better Auth admin 插件自己在写库。物化它会长期漂移，且漂移方向是「已封禁却仍放行」。`banReason` / `banExpires` 同理。
2. **`allow_admin_login` 与 `is_member` 进快照。** 它们的写入点全在本仓的写路径里：`rbac-handlers.ts`（`:713` 改开关、`:746` 改会员位、`:647` 建角色、`:805` 改码重建）与 `rbac/seed.ts` 的目录播种。`seed.ts` 走它自己的批次，重算语句追加在同一批的末尾。
3. **快照查不到即无权限**，不回退四表查询。零角色账号因此从「能进空后台」变成 403 拒绝登录，这是本次明确的、可接受的行为变更。快照行存在但 `codes` 不是 JSON 数组时直接抛出（AGENTS.md「fast-fail」）：这是本模块自己的写入不变量被破坏，就地报错比带着半截权限继续跑更容易定位。
4. **重算语句是 `DELETE` 后 `INSERT … SELECT`，不是单独的 `INSERT`。** 账号被清空角色时（`replaceUserRoles` 传空数组）`INSERT … SELECT` 命中 0 行，旧快照会留在表里 —— 那不是 403，是继续持旧权限。
5. **三处登录闸门与每请求判断共用同一个判据。** `admin-signin.ts`（密码登录后置门）、`credential-login.ts`（凭证登录前置门）、`middleware.ts`（登录页重定向判断）此前都调 `userMayEnterAdmin`，而那个函数对零角色账号返回 `true`。如果只改每请求判断，零角色账号会「登录成功、每个请求 403」，且 `middleware.ts` 会把它从登录页重定向回后台，形成两个页面之间的反复跳转。三处一并改读快照。

`deleteRbacRole` **不在**重算清单里：它带 `roleInUse` 守卫，仍有持有者的角色删不掉，所以删角色不会让任何账号失去角色。零角色只来自 `replaceUserRoles` 传空数组。

## 量化对比（同一实例、同一用户、同一 2 万次基准）

| 读法 | 表 / JOIN | 返回行 | 耗时 |
|---|---|---|---|
| 改造前 3 条 SQL 串行 | 3 条 | 27 行 | 25.33 µs |
| **权限快照 1 条 SQL** | 3 表 / 2 个 LEFT JOIN | **1 行** | **7.67 µs** |
| 明细派生表 `(user_id, permission_id)` | 2 表 / 1 JOIN | ~20 行 | 16.53 µs |

后台每请求：语句 3 → 1，返回行 27 → 1，CPU 25.33 → 7.67 µs（−70%），**D1 往返次数不变（仍是 1 趟）**。

诚实的结论：17.66 µs 的收益只占一次往返的 0.35%–1.8%。本次改动的主要价值是「3 条 SQL 变 1 条、后台准入语义集中在一行」，延迟收益排在第二位。

## 被否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 明细派生表 `(user_id, permission_id)` | 实测只省 2.8 µs（−14%），而表从 10 行放大到 165 行（16.5 倍）。收益与代价严重不匹配 |
| 后台也接 `cachedUserAccess` | Cache API 是边缘分布的，`deleteWorkerCacheKeys` 只清当前机房，其他机房要等 TTL 自然过期。后台是交互式管理路径，管理员改完自己的权限要立刻生效，承受不了跨机房陈旧窗口。D1 是单点强一致，适合这条路径 |
| 触发器自动重算 | SQLite 只有行级触发器（`FOR EACH ROW`），批量写 24 条授权会触发 24 次重算，写放大不可接受 |
| 分成两条 SQL（先取 `role_ids`，再查授权） | 往返 1 → 2 次，实测更慢 |
| 只做 APP 侧缓存、后台保持原样 | 回到背景里的问题：后台每请求仍在付一次往返读二十几行不变数据 |

## 后果

**新增了仓库里第二个镜像。** 第一个是 `auth_user.role`（ADR-0052），出问题只是那一个字段错；这张表出问题是权限错，漏删还是越权。守护分三层：

1. 重算 SQL 只写在 `src/server/rbac/snapshot.ts` 的两个构造器里，所有写路径调它们；
2. `tests/unit/permission-snapshot.test.ts` 沿 TypeScript 语法树切分函数，断言每个改真源的函数都调了重算构造器，并断言重算语句的 DELETE 排在 INSERT 之前。覆盖四个文件：`rbac-handlers.ts` / `bootstrap.ts` / `password-setup.ts` / `seed.ts`；
3. `scripts/check-permission-snapshot.ts` 跑双向不变量查询（有角色但无快照行 / 快照的 `codes` 与真源聚合结果不等），读本地实例库，退出码 0 一致、1 有差异。它是手工工具，不进门禁——脱离真实数据跑没有意义。

`tests/worker/permission-snapshot.test.ts` 在真实 D1 上覆盖一遍：改角色授权、改用户角色、改两个角色开关之后快照真的跟着变，清空角色之后快照行真的消失。

**`is_member` 的消费者在 App 侧。** 后台路径不读它（ADR-0044 原话）。为了不留下无人消费的列，App 侧两条读路径都改成读快照：`cachedUserAccess`（`src/server/cache/identity-cache.ts`，缓存未命中时回源）与 `resolveAppPermissionSet`（`src/server/app/permission/resolve.ts`，功能开关的权限判定）。于是四个 App 内容端点的会员档与后台权限码出自同一行。`resolveUserAccess` / `resolveUserPermissions` / `userMayEnterAdmin` 三个四表读法保留在 `resolve.ts`，用途是真源比对与既有测试。

**写放大会随用户数放大。** 当前 9 行快照、165 个码，改一次角色授权重算该角色全部成员（`editor` 4 人 × 24 码 ≈ 96 行写），可忽略。用户数到 1000 时单次角色授权变更约 2.4 万行写，占 D1 日写额度（10 万行）的 24%。

**行为变更。** `email-signup` 那条路不授任何角色，走它的账号此后无法进入后台（403 而非空后台）。本机实例 9 个账号全部持角色，这一条在本地不可观测。

**不受影响的写路径**（列出以免下次误改）：`renameRbacRoleCode:773` 只换 `role_id`，快照存的是权限码，不含角色 id；`renameRbacRole:658` 只改显示名；`createRbacRole:626` 新角色无成员；`deleteRbacRole:837` 带 `roleInUse` 守卫；`api.banUser` 见上文约束 1。

**删账号那条是显式删，不靠外键。** 表上有 `ON DELETE CASCADE`，但 D1 的外键强制开关不由本仓控制（`migrations/0036` 的注释记录了同一个取舍）。`rbac-handlers.ts` 删账号的路径因此显式 `DELETE FROM ext_user_permissions`，与旁边删 `ext_login_credentials` 的做法一致。

**同名表曾是另一件事。** `ext_user_permissions` 这个名字在 0045 属于「按账号权限覆盖层」，0046 已删除，两件事语义无关。远程实例的 `d1_migrations` 里 0045 仍是 APPLIED（文件被历史重写后补回，内容是 `SELECT 1`）。所以：恢复 0045 时期的旧快照时，不要把那张表当成权限快照；读代码时也不要拿 0045/0046 推断本表的来由。

**快照工具要登记。** `manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES.durable` 必须含 `ext_user_permissions`，否则 `assertClassifiedTables` 会拒绝创建快照。内容是派生的，但恢复流程没有重算步骤，漏了它会让恢复出来的站点所有人进不了后台。
