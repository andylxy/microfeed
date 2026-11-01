# 用户体系定向优化方案（C1 / C2 / D）

- 状态：已实施，未提交（4 张工单全部完成，见 `.scratch/user-system-optimization/issues/`）
- 分支：`refactor/user-system`
- 日期：2026-11-01
- 关联：`docs/novel-cms/adr/0052-keep-custom-permission-engine.md`（判定引擎保持自研）、`CONTEXT.md`（角色分配 / 角色镜像 / 通配权限 / 权限判定）
- 后续：本方案「不新增表结构」的边界已被 `docs/novel-cms/adr/0053-permission-snapshot-table.md` 的权限快照表突破，那份 ADR 是本次之后的独立改动，不在下面的 C1 / C2 / D 范围内。

## 0. 改动清单

三处改动：去掉一处冗余的 SQL 去重、把两条账号闸门查询合并进已有的并行块、修一处会导致 403 的数据漂移（迁移 + 一处授权时机）。合计约 20 行代码 + 1 个 `data` 迁移 + 7 个新增用例。表结构、判定引擎、角色模型都不动。

| 项 | 改动量 | 性质 |
|---|---|---|
| **C1** 去掉 `resolveUserAccess` 的冗余 `DISTINCT` | 约 2 行 | 消除一处排序溢出（顾问项），无行为变化 |
| **C2** 合并两条账号闸门查询并折进 `Promise.all` | 约 10 行 | 后台每请求 4 语句 / 3 往返 → 3 语句 / 1 往返 |
| **D** 修掉 `auth_user.role` 与 `ext_user_roles` 的数据漂移 | 1 个 `data` 迁移 + `password-setup` 授权时机 ~8 行 + 2 个用例 | 修复实测存在的 403 缺陷，并堵掉一处能再生越权行的写入窗口 |

## 1. 范围

**做**：

- `src/server/rbac/resolve.ts` 的两处查询改写。
- 一个 `data` 类型迁移，把 `auth_user.role` 补齐到与 `ext_user_roles` 一致。
- `src/server/auth/password-setup.ts`：把 `ext_user_roles` 的授予移进建号的同一个 `batch`（§5.3 的缺口）。
- `tests/unit/auth-role-mirror.test.ts` 追加两个用例（§5.5(b)、§6 第 5 项）。

**不做**（明确排除，避免范围蔓延）：

- 不改 `ext_*` 表结构，不新增/删除表、列、索引。
- 不改 `permissionsInclude` 的判定语义，不引入新的判定引擎。
- 不改角色模型（角色码、`readonly` 命名、`is_member` 归属均不动）。
- 不改 `accountIsBlocked` 的导出与签名（App 侧 3 个调用方继续用）。
- 不引入缓存替代实时读（权限收回必须即时生效）。
- 不重写 `docs/zh/12-user-system-schema.md`（该文档与代码的漂移属独立议题，不在本方案内）。

## 2. 现状锚点

### 2.1 后台每请求的实际开销

一次已登录的后台请求，`resolveRbacContext`（`resolve.ts:283`）目前是 **4 条语句、3 个串行往返**：

| 序 | 语句 | 位置 | 串行点 |
|---|---|---|---|
| 1 | `resolveUserPermissions`（只返 `Set<string>`，实现委托 `resolveUserAccess`，权限码 + 会员标记同一条 SQL） | 入口 `resolve.ts:104`，查询 `:84` | 与 #2 并行，第 1 趟 |
| 2 | `userMayEnterAdmin`（能否进后台） | `resolve.ts:258` | 与 #1 并行，第 1 趟 |
| 3 | `accountIsBlocked`（封禁） | `resolve.ts:143` | 第 2 趟 |
| 4 | `ext_user_security.must_change_password`（待改密） | `resolve.ts:296` | 第 3 趟 |

设备相关查询只在请求带 `x-device-id` 时发生，而全仓只有 `resolve.ts:164` 读这个头、**没有任何客户端发送它**，所以后台实际是 4 / 3，不是 6 / 5。

量级要摆正：**权限判定是微秒级，D1 往返是毫秒级。** 实测（2026-11-01 本机，`node` `hrtime.bigint()`，2 万次采样，见 §7.3）一次后台页 38 次判定的总耗时是 **0.48 µs** —— 约为一次 D1 查询的 0.01%。所以优化只能打往返数，不能打判定次数。

### 2.2 两个真源与它们的镜像关系（已作废，见 ADR-0054）

> **本节的镜像那一半不再成立。** better-auth admin 插件已移除，`auth_user.role` 停写停读、存量值由 `0163` 清为 NULL，镜像不再有读者（ADR-0054）。下表描述的 `tests/unit/auth-role-mirror.test.ts` 两个用例也已改写为反向断言。保留本节是为了说明「当时为什么会有那一层冗余」。

- `ext_user_roles` 是「账号持有哪些角色」的唯一真源，授权全读它。
- `auth_user.role` 是**有损**派生镜像：持 `super_admin` 记 `admin`，其余记 `user`（`src/shared/Rbac.ts:29,32`）。它只服务 Better Auth admin 插件自己的端点，不参与授权。

`tests/unit/auth-role-mirror.test.ts` 现有两个用例，覆盖面不一样，需要分开说：

| 用例 | 断言内容 | 没覆盖什么 |
|---|---|---|
| `mutates the mirror column only in rbac-handlers.ts` | `UPDATE auth_user SET role =` 只出现在 `rbac-handlers.ts`，恰好 2 处，且 2 处都带 `includes(SUPER_ADMIN) ? BETTER_AUTH_ADMIN_ROLE : BETTER_AUTH_USER_ROLE` 三元 | 两处的**位置**（`replaceUserRoles` / `createAdminRbacUser`）与写入顺序 |
| `creates an auth_user row with a role only in the two owner paths` | `INSERT INTO auth_user` 只出现在 `bootstrap.ts` 与 `password-setup.ts` | 只校验**文件清单**，不校验 INSERT 里 `role` 的取值，也不校验同一路径上 `ext_user_roles` 的授予时机 |

所以「代码侧已经全部受控」这句话只对 `UPDATE` 那一半成立。`INSERT` 那一半只受文件名清单约束，值本身与授予时机都在断言之外 —— §5.3 会指出这条缺口。

**残留的问题主要在数据侧，但代码侧还有一处**（见 §5）。

## 3. C1：去掉冗余的 `SELECT DISTINCT`

### 3.1 现状

`resolve.ts:82-92`：

```ts
const result = await db
  .prepare(
    `SELECT DISTINCT p.code AS code, r.is_member AS isMember
     FROM ext_user_roles ur
     JOIN ext_roles r ON r.id = ur.role_id
     LEFT JOIN ext_role_permissions rp ON rp.role_id = ur.role_id
     LEFT JOIN ext_permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = ?`,
  )
  .bind(userId)
  .all<{code: string | null; isMember: number | null}>();
```

### 3.2 改法

`SELECT DISTINCT` → `SELECT`，并在函数注释里补一句「去重由下方 `new Set()` 承担」。

理由：去重实际发生在 `resolve.ts:94-99` —— `permissions.add(row.code)` 本身就是集合语义，`isMember` 是布尔或运算。SQL 的 `DISTINCT` 对最终结果没有任何贡献，只换来一次临时 B-tree 排序。

### 3.3 实测

行数完全不变（2026-11-01，本机实例副本 9 个账号中的 7 个有角色账号）：

| 账号 | 角色数 | 带 `DISTINCT` | 去 `DISTINCT` |
|---|---|---|---|
| `5ebee6d2…` | 1 | 23 | 23 |
| `HtX1Xs9s…` | 2 | 25 | 25 |
| 其余有角色的 5 个 | 1 | 23–24 | 23–24 |

执行计划（2026-11-01，本机实例副本 `EXPLAIN QUERY PLAN`）：

```
改前：SEARCH ur USING COVERING INDEX … → SEARCH r … → SEARCH rp … → SEARCH p …
      USE TEMP B-TREE FOR DISTINCT
改后：SEARCH ur USING COVERING INDEX … → SEARCH r … → SEARCH rp … → SEARCH p …
```

四个访问点全部走索引的形态不变，只是少了排序步骤。

### 3.4 收益的边界（不要夸大）

**这一条没有可观测的性能收益。** 它的真实价值是消掉一处 `check-d1-scan` 的 `D1SCAN-002`（`TEMP B-TREE`）顾问告警，让这条查询的执行计划保持干净。改动只有 2 行、无行为变化，所以顺手做；如果只想要确定收益，跳过它也不影响 C2 与 D。

## 4. C2：合并两条账号闸门查询，折进已有并行块

### 4.1 现状

`resolve.ts:288-304`：

```ts
const [permissions, adminLoginAllowed] = await Promise.all([   // 第 1 趟：2 条并行
  resolveUserPermissions(db, userId),
  userMayEnterAdmin(db, userId),
]);

const banned = await accountIsBlocked(db, userId);             // 第 2 趟：1 条

let mustChangePassword = false;
const security = await db                                     // 第 3 趟：1 条
  .prepare("SELECT must_change_password AS flag FROM ext_user_security WHERE user_id = ?")
  .bind(userId)
  .first<{flag: number}>();
if (security && security.flag === 1) {
  mustChangePassword = true;
}
```

第 3、4 条语句读的是同一个账号的两张主键表，彼此没有依赖，却排成两个串行往返。

### 4.2 改法

合并成一条主键点查，并折进已有的 `Promise.all`：

```ts
const [permissions, adminLoginAllowed, gate] = await Promise.all([
  resolveUserPermissions(db, userId),
  userMayEnterAdmin(db, userId),
  // banned 与 must_change_password 读的是同一个账号的两张主键表，一次 LEFT JOIN
  // 取回。放在这个并行块里，三条语句共用一趟往返。
  db
    .prepare(
      `SELECT u.banned AS banned,
              COALESCE(s.must_change_password, 0) AS mustChange
       FROM auth_user u
       LEFT JOIN ext_user_security s ON s.user_id = u.id
       WHERE u.id = ?`,
    )
    .bind(userId)
    .first<{banned: number | null; mustChange: number}>(),
]);

// 行缺失与 accountIsBlocked 的语义一致：账号不存在即视为被拦。
// `first()` 的返回类型是 `T | null`，不会出现 undefined，所以判 null 就够。
const banned = gate === null || Number(gate.banned) === 1;
const mustChangePassword = gate !== null && Number(gate.mustChange) === 1;
```

### 4.3 三个必须守住的等价性

1. **行缺失分支**：原 `accountIsBlocked`（`resolve.ts:151`）查不到行时 `return true`；`gate === null` 等价（`first()` 只返 `T | null`）。
2. **待改密默认值**：原代码 `if (security && security.flag === 1)`；新写法靠 `COALESCE(..., 0)` 保证 `ext_user_security` 无行时取 0。
3. **不动 `accountIsBlocked` 本身**：它还有 3 个 App 侧调用方 —— `app-auth.ts:154`、`app-account-binding.ts:151`、`app-third-party.ts:384`。保持导出与签名不变，只把 `resolveRbacContext` 里的那次调用换掉。

### 4.4 实测

合并后的执行计划（2026-11-01，本机实例副本，两条主键点查、无表扫）：

```
SEARCH u USING INDEX sqlite_autoindex_auth_user_1 (id=?)
SEARCH s USING INDEX sqlite_autoindex_ext_user_security_1 (user_id=?) LEFT-JOIN
```

`ext_user_security` 是 `(user_id, must_change_password)` 两列的窄表、本地仅 1 行，`LEFT JOIN` 成本可忽略。

净效果：**4 条语句 / 3 个串行往返 → 3 条语句 / 1 趟往返**（−25% 语句、−67% 往返）。

> 往返数按现有 `Promise.all` 的并发假设计。若某个环境下 D1 会话内串行执行，则退化为 3 条串行语句 —— 仍比现状少 1 条语句、少 1 趟往返。

## 5. D：修掉 `auth_user.role` 与 `ext_user_roles` 的漂移（已作废，见 ADR-0054）

> **本节及 §5.1–§5.5 描述的动作已成历史。** ADR-0054 把镜像整体清空，两侧不再并存，漂移无从产生：`0161` 那一版让镜像与真源取同一值，`0163` 把镜像清为空值，两步都留在迁移台账里。运维查询与检查点脚本不再需要，`password-setup` 的授权时机调整仍在代码里（它同时是 ADR-0053 快照的写入点之一）。

### 5.1 缺陷本体

镜像是有损的（只表达「是否持 `super_admin`」一位），所以两侧一旦不同步，有两个方向：

| 方向 | 数据形态 | 后果 | 本地实测（2026-11-01，本机实例 9 个账号） |
|---|---|---|---|
| **A 超管被降权** | `ext_user_roles` 有 `super_admin`，`auth_user.role` ≠ `admin`（含 NULL） | 项目守卫放行（读 `ext_user_roles`），Better Auth 原生端点 403 | **1 个账号**：`6022f637…`，`role = NULL` |
| **B 越权** | `auth_user.role = 'admin'`，`ext_user_roles` 无 `super_admin` | 能调 Better Auth 端点，却无对应角色授权 | **0 个账号** |
| 非缺陷 | `role = 'user'` 却是 `editor` | 镜像的有损设计：非超管一律 `user`，符合预期 | 2 个账号 |

因此准确的缺陷面是 **1 / 9 账号 = 11%**，不是「3 / 9 = 33%」。

### 5.2 后果的精确形态

`6022f637…` 是 `super_admin`，能进后台用户管理页，但点「封禁用户」或「删除用户」会收到 **403**。

链路：`rbac-handlers.ts:1370` → `auth.api.banUser`、`rbac-handlers.ts:1315` → `auth.api.removeUser`；而这两个端点的判据是

```js
const roles = (input.role || input.options?.defaultRole || "user").split(",");
```

`role = NULL` 时归入 `"user"` 兜底，该角色不含 `user:ban` / `user:delete` → `FORBIDDEN`。

### 5.3 代码侧：四处同批，一处不同批

全仓 `INSERT` / `DELETE` / `UPDATE` `ext_user_roles` 的写入点共 5 处：

| 位置 | 场景 | 镜像写法 | 与授权是否同批 |
|---|---|---|---|
| `rbac-handlers.ts:571-578` | `replaceUserRoles` | 同 `batch` 内 `:584` 的 `UPDATE auth_user SET role = ?` | 同批 |
| `rbac-handlers.ts:1250-1256` | `createAdminRbacUser` | 同 `batch` 内 `:1266` 的 `UPDATE auth_user SET role = ?` | 同批 |
| `rbac-handlers.ts:814` | `renameRbacRoleCode` | 只换 `role_id`，且 `super_admin`/`readonly` 的码被 `CODE_LOCKED_ROLES` 禁止改名 | 不涉及镜像 |
| `bootstrap.ts:106` | 首次引导 | 同一 `batch` 的 `auth_user` INSERT 直接写 `role = 'admin'`（`:85`） | 同批 |
| `password-setup.ts:328` | 安装向导建所有者 | `auth_user` INSERT 写 `role = 'admin'`（SQL 文本 `:272`、绑定值 `:281`） | **不同批**，见下 |

`password-setup.ts` 是唯一不同批的一处，原因写在 `:320-325` 的注释里：`INSERT OR IGNORE INTO ext_user_roles` 在授权已存在时 `meta.changes = 0`，而 `:314` 的 `results.some((r) => r.meta.changes !== 1)` 把 0 读成「这条链接已被用过」并返回 410 —— 会给刚建好的账号报重放。所以授予被挪到 batch 之后单独执行。

代价是一个窗口：batch 已提交（`auth_user.role = 'admin'`、token 已删、账号已存在），`:326-332` 的授予还没跑。若这一步失败（例如 `r_super_admin` 行不存在，`ext_user_roles.role_id` 的外键拒绝写入，`INSERT OR IGNORE` 不抑制外键冲突），就留下一条**方向 B 越权行**：`role = 'admin'` 而没有 `super_admin`。

因此精确的表述是：

- 那条 `role = NULL` 的存量行（`6022f637…`）确实是镜像写入上线前的历史残留。
- 但方向 B 越权行**能由现存代码路径再生**，触发条件是 `:326` 授予失败且安装流程未被重试。
- 所以 `auth_role` 的订正不能只做一次数据修正，`password-setup.ts` 的授予位置也要一起改（见 §6 第 4 项）。

结论：**不需要触发器**；需要一处数据订正 + 一处授权时机调整 + 两条防回归用例。

### 5.4 修法一：`data` 迁移

新增 `migrations/0161_data_sync_auth_user_role.sql`（`data` 类型，按 `check-migrations` 规则 MIG-004 必须带 `-- rollback:` 块）：

```sql
-- 把 auth_user.role 补齐到与 ext_user_roles 一致。镜像是有损的（是否持 super_admin
-- 一位），所以只订正两个方向里错的那部分，已经正确的行不动。
-- 判据用 ext_roles.code 而非 ext_roles.id：id 形如 r_super_admin，各环境未必一致。
UPDATE auth_user
SET role = CASE
  WHEN EXISTS (
    SELECT 1 FROM ext_user_roles ur
    JOIN ext_roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth_user.id AND r.code = 'super_admin'
  ) THEN 'admin'
  ELSE 'user'
END
WHERE role IS NULL
   OR (role = 'admin' AND NOT EXISTS (
        SELECT 1 FROM ext_user_roles ur
        JOIN ext_roles r ON r.id = ur.role_id
        WHERE ur.user_id = auth_user.id AND r.code = 'super_admin'))
   OR (role = 'user' AND EXISTS (
        SELECT 1 FROM ext_user_roles ur
        JOIN ext_roles r ON r.id = ur.role_id
        WHERE ur.user_id = auth_user.id AND r.code = 'super_admin'));

-- rollback: 迁移后的取值分布已满足不变量（admin ⟺ 持 super_admin），
-- 无法从结果反推哪些行被本迁移改过，所以不提供无条件逆 SQL。回退前先按
-- 下方预演查询把 (id, role) 原值导出留档，回退时按该清单逐行还原：
--   UPDATE auth_user SET role = ? WHERE id = ?;
-- 回退不通过改动 `d1_migrations` 记账行完成：该表以文件名为键（MIG-002），
-- 删除文件只会让已应用记录无法识别，不会撤销数据。
```

`role IS NULL` 分支的命中面要说清：它对 NULL 行是**无差别**命中 —— 持 `super_admin` 的改 `admin`，不持的改 `user`，后者属把 NULL 归一成镜像值，不算纠错。本地实例 NULL 只有 1 行（`6022f637…`，持 `super_admin`），由「持 `super_admin` 但 `role ≠ admin`」那一支命中；迁移第三支（`role = 'user'` 且持 `super_admin`）在本地改 0 行。其他环境可能不同，执行前必须按分支分别计数。

执行前先预演，三条分开计数：

```sql
-- A：持 super_admin 但 role 不是 'admin'（含 NULL）—— 本迁移要改成 admin
SELECT COUNT(*) FROM auth_user WHERE (role IS NULL OR role <> 'admin') AND EXISTS (
  SELECT 1 FROM ext_user_roles ur JOIN ext_roles r ON r.id = ur.role_id
  WHERE ur.user_id = auth_user.id AND r.code = 'super_admin');

-- B：role = 'admin' 但不持 super_admin —— 越权行，本迁移要改成 user
SELECT COUNT(*) FROM auth_user WHERE role = 'admin' AND NOT EXISTS (
  SELECT 1 FROM ext_user_roles ur JOIN ext_roles r ON r.id = ur.role_id
  WHERE ur.user_id = auth_user.id AND r.code = 'super_admin');

-- C：role IS NULL 且不持 super_admin —— 归一成 'user'，不影响授权
SELECT COUNT(*) FROM auth_user WHERE role IS NULL AND NOT EXISTS (
  SELECT 1 FROM ext_user_roles ur JOIN ext_roles r ON r.id = ur.role_id
  WHERE ur.user_id = auth_user.id AND r.code = 'super_admin');
```

本地期望 A = 1、B = 0、C = 0。A 的计数等于迁移第一支与第三支命中数之和，前提是 `role` 只取 `admin` / `user` / NULL —— 该列由 Better Auth admin 插件维护，取值域就是这三个。若预演里出现别的字面值，说明有人在插件之外写过该列，先查清来源再决定是否扩大迁移范围；任一分支数与预期不符时同样先查清再执行。

### 5.5 修法二：检查点与防回归

先纠正一个容易写错的方案：**不要**在 `tests/unit/auth-role-mirror.test.ts` 里加「存在一个 `data` 迁移订正过漂移」这类断言。`tests/unit` 不接 D1，读不到存量行；而「迁移文件存在」与「漂移被订正」之间没有因果关系，这种断言只会让测试看起来覆盖了数据，实际什么都没测。

真正能查的是三件事，分属不同层：

**(a) 存量数据 —— 运维查询**（迁移后核对，期望 0）：

```sql
SELECT COUNT(*) AS drifted FROM auth_user u
WHERE COALESCE(u.role = 'admin', 0) <> EXISTS (
  SELECT 1 FROM ext_user_roles ur
  JOIN ext_roles r ON r.id = ur.role_id
  WHERE ur.user_id = u.id AND r.code = 'super_admin'
);
```

`COALESCE` 不能省：`role` 为 NULL 时 `u.role = 'admin'` 求值为 NULL，`NULL <> EXISTS(...)` 仍是 NULL，COUNT 会跳过这种行 —— 而「NULL 却持超管」正是本次要修的那一行。加上 COALESCE 后它按「非 admin」计入。本地实测这条查询迁移前返回 1、迁移后返回 0。

它只能在部署后手工跑，不进测试套件。

**(b) 迁移内容 —— 静态断言**（进 `tests/unit`，读文件不读库）：

断言 `migrations/0161_data_sync_auth_user_role.sql` 的 `WHERE` 子句同时包含三个分支的条件（`role IS NULL`、`role = 'admin' AND NOT EXISTS`、`role = 'user' AND EXISTS`），且 `SET role` 的 `CASE` 以 `ext_roles.code = 'super_admin'` 判定。

这条的边界要写明白：它防的是**后续有人编辑该迁移时删掉某个分支**，不防 SQL 逻辑写错 —— 逻辑正确性只能靠 §5.4 的三条预演计数 + 部署后的运维查询。

**(c) 代码侧的缺口** 由 §5.3 的伴随改动消掉，防回归断言见 §6 第 5 项。

## 6. 实施清单

| # | 文件 | 改动 | 预估行数 |
|---|---|---|---|
| 1 | `src/server/rbac/resolve.ts:84` | 去 `DISTINCT` + 补一句注释 | ~2 |
| 2 | `src/server/rbac/resolve.ts:288-304` | 合并闸门查询、折进 `Promise.all` | ~10 |
| 3 | `migrations/0161_data_sync_auth_user_role.sql` | 新增 `data` 迁移 + `-- rollback:` 块 | ~30 |
| 4 | `src/server/auth/password-setup.ts:267-332` | 把 `ext_user_roles` 的授予移进 `:267` 的 `batch`，并把 `:314` 的校验改为只读前 3 条结果 | ~8 |
| 5 | `tests/unit/auth-role-mirror.test.ts`（追加 2 个用例）、`tests/unit/rbac-resolve-gate.test.ts`（新建，4 个假数据库用例） | 迁移三分支静态断言、`password-setup` 同批断言；闸门语句数与两条边界 | ~95 |
| 6 | `.workbuddy/memory/` | 记录本次结论 | 不计入 |

第 4 项的写法：`database.batch([...])` 末尾追加一条

```ts
database
  .prepare(
    "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) " +
      "SELECT id, 'r_super_admin' FROM auth_user WHERE id = ?",
  )
  .bind(userId),
```

并把 `:314` 的 `results.some((result) => result.meta.changes !== 1)` 收窄到前 3 条（`results.slice(0, 3)`），否则第 4 条在授权已存在时返回 0 changes，会被误判成「链接已用」。`INSERT OR IGNORE` 只抑制主键冲突，不抑制 `ext_user_roles.role_id` 的外键冲突 —— 这正是想要的：`r_super_admin` 缺失时整批回滚，不再留下越权行。

`slice(0, 3)` 不会吞掉第 4 条的失败：外键违例会让 `database.batch()` 整体 reject 并抛错，第 4 条根本不会产生结果项，`slice` 只在批次成功返回 4 项时截取前 3 项做 changes 校验。

顺序：1 → 2 → 3 → 4 → 5。第 1、2 项可独立完成；第 3 项涉及数据，先跑 §5.4 的三条预演计数再执行；第 4 项改的是安装流程，与第 3 项无耦合，但第 5 项的第 2 个用例要读第 4 项改后的源码，所以 4 在 5 之前。

## 7. 验证

### 7.1 结构验证

- 改后 `resolve.ts` 仍是 4 个访问点走索引、无表扫（`EXPLAIN QUERY PLAN` 复跑，只读探针）。
- C1 后 `TEMP B-TREE FOR DISTINCT` 消失。
- C2 后语句数 4 → 3：用假 D1 记录 `prepare()` 调用次数的单元测试来断言，不用临时日志、不起服务。

### 7.2 行为验证

本节列的是**要写出的测试**，不在这里运行 —— 执行时机归 `.microfeed-gate-subset`（见 AGENTS.md「最高指令」）。

- `tests/unit/auth-role-mirror.test.ts` 原有 2 个用例不得删减，新增 2 个（迁移三分支、`password-setup` 同批）按 §6 第 5 项；C2 的 4 个假数据库用例在 `tests/unit/rbac-resolve-gate.test.ts`；C1 的去重行为断言加在 `tests/worker/rbac.test.ts` 的权限解析 describe 里。
- C2 改了 `resolveRbacContext` 的取数方式，`rbac.test.ts` 的 page-guard / endpoint-guard / `requireAudienceGuard` 派发虽不在改动面内，需随门禁一并回归。
- 封禁链路的「迁移前 403、迁移后不再 403」是跨进程端到端行为，`tests/unit` 覆盖不到：只写出 `rbac-handlers` 的 handler 级测试（注入假 D1 返回构造上下文），真实链路判定留给部署后按 §5.5(a) 的运维查询。

### 7.3 判定耗时的可复现基准（C1/C2 不改判定，此脚本仅用于说明量级）

```js
const codes = [];
const mods = ["content", "system", "app", "media"];
for (let i = 0; i < 64; i++) codes.push(mods[i % 4] + ":res" + (i % 41) + ":act" + (i % 5));
const set = new Set(codes), code = "content:book:read";
const page = () => { let n = 0; for (let i = 0; i < 38; i++) if (set.has("*") || set.has(code)) n++; return n; };
for (let i = 0; i < 500; i++) page();
const t = process.hrtime.bigint();
for (let i = 0; i < 20000; i++) page();
console.log("每后台页:", (Number(process.hrtime.bigint() - t) / 20000 / 1000).toFixed(2), "µs");
```

> `N` 用 20,000；设 200,000 会跑超时被终止。

### 7.4 门禁

提交前 `git diff --check`；其余门禁由用户手动触发（`microfeed-gate-subset`）。本方案不新增权限码、不改迁移命名规则。`check-migrations` 会按 MIG-003 校验 `0161_data_sync_auth_user_role.sql` 的分类、按 MIG-004 要求 `data` 迁移含 `-- rollback:` 块，本方案的命名与 rollback 块已按这两条写；`check-adr` / `check-server-layout` / `check-endpoint-registration` 不受影响。

## 8. 风险与回滚

| 项 | 风险 | 回滚 |
|---|---|---|
| C1 | 极低。行数实测不变，去重仍在 JS 侧 | 加回 `DISTINCT` 即可 |
| C2 | 低。三条等价性已逐条列出；唯一易错点是漏掉 `!gate` 的行缺失分支 | 恢复两段串行查询即可 |
| D-迁移 | 中。迁移会写 `auth_user.role`，方向写反会让超管失去 admin 插件端点权限 | rollback 块要求先导出 `(id, role)` 原值再逐行还原；被改的行按 §5.4 预演计数确认 |
| D-授权时机 | 低。`password-setup` 的授予移进 batch 后，整批失败会连建号一起回滚 —— 安装流程本来就要重试整步，不会留下半成品 | 把授予移回 batch 之后，恢复 `results.some(...)` 的原校验 |

D 不需要维护窗口（只改一列的字面值，不改 schema），但必须在 §5.4 三条预演计数与预期一致后再执行。

## 9. 边界

- **允许新增文件**：`migrations/0161_*.sql`，以及 `tests/unit/rbac-resolve-gate.test.ts`（C2 的假数据库用例，规格 §7.1 要求它存在）。
- **允许改动的既有文件**：`src/server/rbac/resolve.ts`、`src/server/auth/password-setup.ts`、`tests/unit/auth-role-mirror.test.ts`、`tests/worker/password-setup.test.ts`、`tests/worker/rbac.test.ts`。其余源码文件不动。
- **必须同步文档**：`CONTEXT.md` 只订正与 D 项直接相关的三个条目 —— `角色分配`（取代旧称「角色归属」）、`角色镜像`（新增，取代原「Better Auth 角色」）、`通配权限`（补「短路放行」）；不新增「角色目录」这类与三项改动无关的条目。`docs/novel-cms/adr/0052-keep-custom-permission-engine.md` 同批订正。`docs/zh/12-user-system-schema.md` 不在本次范围。
- **禁止**：改判定引擎、改表结构、改角色码、为性能引入缓存、批量重排 `ext_*`、为 D 加触发器。
