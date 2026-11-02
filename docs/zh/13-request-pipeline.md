---
title: 13 请求链路与关卡
description: 一个请求从进来到拿到数据要过的全部关卡：三条通道（后台会话 / App 凭证 / OpenAPI 密钥）逐关拆解，每关的作用、判定、拒绝状态码、背后数据库表，以及权限域全部数据表的索引。
---

# 13 请求链路与关卡

> **用途**：回答「这个请求为什么被 401 / 403 / 426 / 429 挡住了」「某一关检查什么、读哪张表」，以及新增端点时判断该挂哪道关。
> **触发词**：链路、中间件、关卡、请求流程、鉴权流程、权限判定、401、403、426、429、防重放、限流、版本门、配额、guard、middleware。
> **加载时机**：排查请求被拒原因、新增端点要挂守卫、或要理解鉴权/角色/权限判定全貌时读本册。
> **单一数据源**：所有表的字段级中文说明一律见 12 册（`12-user-system-schema.md`），本册只做链路拆解与表索引，不复制字段。

## 1. 总览：三条通道

所有请求先进 `src/worker.ts` 的 fetch 入口，交给 Astro 中间件 `src/middleware.ts` 的 `handleRequest`；`onRequest` 再统一包缓存策略与安全响应头。`handleRequest` 按**路径前缀**把请求分进三条通道，三条通道的关卡完全不同：

| 通道 | 路径 | 身份载体 | 鉴权语义 |
| --- | --- | --- | --- |
| A | `{adminPath}/*`（后台页面与 ajax） | better-auth 会话 Cookie | 认证（你是谁）与授权（你能干什么）分离：会话管前者，RBAC 快照管后者 |
| B | `/api/AppBookRequest/*` 内容端点、`/api/app/*` 能力端点、App 匿名端点 | `mflc_` 登录凭证 Bearer | 无会话；每请求验票，权限按端点细分的 RBAC 码（0131 一门一用途） |
| C | `/api/v1/*` 与 legacy `/api/*` | `mf_` 签名密钥 / OAuth 访问令牌 | 粗粒度 OAuth scope（read/write 两档），不走 RBAC 码 |

```mermaid
flowchart TB
  subgraph CHA["通道 A · 后台 adminPath · 会话 Cookie"]
    direction LR
    A1["路径规范化 308"] --> A2["adminPath 冒名 404"] --> A3["better-auth 会话"] --> A4["读权限快照"] --> A5["角色禁入 403"] --> A6["CSRF 同源 403"] --> A7["handler"]
  end
  subgraph CHB["通道 B · App 凭证 mflc_ Bearer"]
    direction LR
    B1["集成名单判定 fail-open"] --> B2["配额缓存标记 429"] --> B3["防重放 400"] --> B4["版本门 stage1 426"] --> B5["凭证鉴权 401/403/429"] --> B6["版本门 stage2 426"] --> B7["配额消费 429"] --> B8["审计落库"] --> B9["handler 无守卫"]
  end
  subgraph CHC["通道 C · OpenAPI 密钥 / OAuth"]
    direction LR
    C1["content 域禁 legacy key 404"] --> C2["集成开关 404"] --> C3["无 key 401"] --> C4["api_keys 查 scope 403"] --> C5["OAuth 令牌校验"] --> C6["handler"]
  end
```

三条通道最终都会落到 §5 的共同底层判定（`guard.ts` 的 8 步顺序）——通道 B 的端点级 RBAC 码与通道 A 的页面守卫都由它执行。

## 2. 通道 A · 后台 `{adminPath}/*`

### A1 路径规范化 — 308

- **作用**：尾斜杠与大小写归一，让鉴权、路由、审计看到的都是同一个规范名。
- **判定**：`canonicalPathname` 产出与原路径不同即 308 重定向；App 命名空间再过 `canonicalAppBookRequestPath` 做大小写归一。
- **背后表**：无。
- **位置**：`src/middleware.ts` `canonicalPathname` / `canonicalAppBookRequestPath`（归一名录在 `src/server/api/access.ts` 的 `APP_BOOK_REQUEST_ROUTES`）。

### A2 adminPath 冒名 — 404

- **作用**：动态路由 `[adminPath]` 会吞掉任意一级路径；只有真实 adminPath 与公开页候选才继续，其余一律 404，把后台路径的**存在性**藏起来。
- **判定**：`context.params.adminPath` 与配置不符且非公开页候选 → `apiNotFoundResponse`（404）。
- **背后表**：无。
- **位置**：`src/middleware.ts`，`apiNotFoundResponse` 在同文件。

### A3 内置鉴权开关与登录早放行

- **作用**：`MICROFEED_ADMIN_AUTH_MODE` 关闭内置鉴权时，后台整体开放（RBAC 用通配集兜底，见 A7）；密码设置与凭证登录两条路径在未登录时就要可达，所以早放行，各自在 handler 里自己做同源校验与限流。
- **判定**：`builtInAuthEnabled`；`isAdminPasswordSetupPath` / `isAdminCredentialLoginPath` 命中即 `next()`。
- **背后表**：无（此关不查库）。
- **位置**：`src/middleware.ts`。

### A4 better-auth 会话校验

- **作用**：认证关卡——从会话 Cookie 解出「你是谁」。整个仓库唯一读会话的入口。
- **判定**：`createMicrofeedAuth(env, request).api.getSession({headers})`。无会话且实例还没有 owner → 锁屏页（`adminDashboardLockedResponse`）；无会话 → ajax 401、页面 302 到登录页（带 `redirect` 回跳参数）。
- **背后表**：`auth_session`（会话令牌与过期）、`auth_account`（凭证，密码哈希所在）、`auth_user`（账号主体）、`auth_rate_limit`（better-auth 自带登录限流）；passkey 登录时加 `passkey`。
- **位置**：`src/middleware.ts`（getSession 调用点）；工厂在 `src/server/auth/better-auth.ts` `createMicrofeedAuth` / `buildAuth`。

### A5 登录页闸门 — 302

- **作用**：已登录且被允许进后台的会话访问登录页时直接送进后台；被角色开关挡住的人**留在登录页**——这是他换账号的唯一出口，不能弹回去形成循环。
- **判定**：`readSnapshotGate(db, userId).adminLoginAllowed === true` 才 302 进后台。判据与 A6 故意同源（都是权限快照），两处不同判据就会出现「这里放行、下一关 403」的往返（`middleware.ts` 内注释明言）。
- **背后表**：`ext_user_permissions`（快照）+ `auth_user` / `ext_user_security`（同一条点查 LEFT JOIN）。
- **位置**：`src/middleware.ts`；读函数 `src/server/rbac/snapshot.ts` `readSnapshotGate`。

### A6 RBAC 上下文装配（每请求一次）

- **作用**：把「这个会话能干什么」装进 locals，供后续所有守卫消费；顺带做设备心跳。
- **判定**：`resolveRbacContext(db, userId, request)` 做三件事，只有一条 SQL 往返：
  1. `readSnapshotGate` 点查一行，取回权限码集合、`is_member`、`admin_login_allowed`、`banned`、`must_change_password`（见 §5.2）；
  2. `isDeviceRevoked` 查设备吊销（必须在登记**之前**查，吊销才不会被心跳洗掉）；
  3. `registerUserDevice` UPSERT 设备行（只动 `last_seen_at`，5 分钟写节流）。
  - 快照行缺失（零角色账号）与账号不存在都归入空集合 + 拒进后台。
- **背后表**：`ext_user_permissions`、`ext_user_security`、`auth_user`、`ext_user_devices`。
- **位置**：`src/server/rbac/resolve.ts` `resolveRbacContext` / `isDeviceRevoked` / `registerUserDevice`。

### A7 角色禁入后台 — 403

- **作用**：角色级「能否登录后台」开关（`ext_roles.allow_admin_login` 并集）为 0 时拦截。**403 而非 401**：会话有效，只是不许进后台——401 会把浏览器送回登录页，登录页看到会话又跳回来，死循环。
- **判定**：`locals.rbacAdminLoginAllowed === false` → 可读文案的 403。
- **背后表**：判定值出自 A6 的快照行（真源是 `ext_roles.allow_admin_login`）。
- **位置**：`src/middleware.ts`；判据定义在 `src/server/rbac/resolve.ts` `userMayEnterAdmin`（真源读法保留，运行时走快照）。

### A8 CSRF 同源 — 403

- **作用**：非安全方法（POST/PUT/PATCH/DELETE）必须同源，挡跨站伪造提交。
- **判定**：`isUnsafeMethod` 且 `!isSameOrigin` → 403。
- **背后表**：无。
- **位置**：`src/middleware.ts`。

### A9 ajax 直通与页面 loadFeed

- **作用**：ajax 端点直接进 handler（端点内用 §5 的守卫自查）；后台页面在中间件里做一次 `loadFeed` 装配内容 locals（列表页已改 ajax 加载的集合不重复装载）。
- **位置**：`src/middleware.ts`（`isAdminAjax` 分支与 `loadFeed` 调用）。

### A10 端点内守卫（每个 ajax 端点自查）

- **作用**：进入具体 handler 后，按端点要求执行 §5 的 `requireRbac` / `requireAudienceGuard` / `requireAuthenticatedRbac`——防重放 → 账号门 → 权限码。
- **位置**：`src/server/rbac/guard.ts`；页面守卫登记表在 `src/server/admin/pc-interfaces.ts`（接口 → 权限码）。

## 3. 通道 B · App 凭证（`mflc_` Bearer）

### B0 集成名单判定 — fail-open 匿名放行

- **作用**：App 命名空间的**总闸**。不在集成名单的路径直接匿名放行——这是刻意设计（配置字典与 pre-auth 端点必须匿名），代价是「漏登记 = 匿名服务」，所以名单配了两道防线（见 §5.4）。
- **判定**：`!isIntegrationApiPath(pathname)` → `next()`。名单 = `APP_BOOK_REQUEST_CONTENT_SUFFIXES`（8 条内容路由，**鉴权权威**）。
- **背后表**：无（纯内存名单）。
- **位置**：`src/middleware.ts`；名单与匿名集合在 `src/server/api/access.ts`。

### B1 配额缓存标记 — 429

- **作用**：已达上限的凭证在**碰 D1 之前**就 429——被拒流量的 D1 代价必须是零。
- **判定**：`appQuotaExhaustedMarker(bearerToken)` 查 Cache 标记，命中即 `appRequestQuotaResponse`（429 + Retry-After）。
- **背后表**：无（Cache API，不是 D1；配额真值在 `ext_rate_limit` 的 `kind = 'app-quota'` 行）。
- **位置**：`src/server/rbac/app-quota.ts` `appQuotaExhaustedMarker` / `appRequestQuotaResponse`。

### B2 防重放 — 400

- **作用**：App 写请求带 `X-Timestamp` + `X-Nonce`，nonce 单次有效，防抓包重放。
- **判定**：`checkReplay` 只对**非安全方法**生效（GET/HEAD 幂等，重放无可保护对象，省一次插入）；时间窗 ±5 分钟，nonce 用 `INSERT OR IGNORE` 去重，`changes = 0` 即重放。
- **背后表**：`ext_rate_limit`（`kind = 'replay-nonce'`，写 1 行 + 过期行按 1% 采样清理）。
- **位置**：`src/server/rbac/replay.ts` `checkReplay`。

### B3 版本门 stage1 — 426

- **作用**：强制旧版升级。认证前只知道全局地板与 `all` 规则。
- **判定**：`requireAppVersion`：地板 ≤ 0 = 门关（放行）；头缺失/非整数/低于地板 → 426（缺头正是强制升级的目标，不是边界情况）。
- **背后表**：`ext_app_version`（地板与规则，0080）、`ext_app_rollout`（灰度，0081）。
- **位置**：`src/server/rbac/guard.ts` `requireAppVersion`；解析在 `src/server/app/version/resolve.ts`。

### B4 凭证鉴权 — 404 / 429 / 401 / 403

- **作用**：通道 B 的认证与授权主关卡。验票、banned、设备吊销、端点权限码一次判定。
- **判定**：`decideLoginCredentialApiRequest` 的分支顺序：
  | 分支 | 状态码 | 条件 |
  | --- | --- | --- |
  | notFound | 404 | 端点未登记，隐藏存在性 |
  | reference | 放行+弃用头 | 文档展示用途 |
  | throttled | 429 | 同 IP 60 秒窗口限流命中 |
  | unauthorized | 401 | 无 bearer / 验票失败 / banned |
  | deviceRevoked | 401 + `X-Device-Revoked: 1` | 设备被吊销（专用头让 App 显示「设备已被禁用」而不是死循环登录） |
  | forbidden | 403 `insufficient_scope` | `requiredApiPermission` 判码失败（双写审计 deny 行） |
  - 验票一条 SQL 同趟 LEFT JOIN `auth_user.banned`；判过即把 `locals.appMember`（会员档）与 `locals.appAuth`（userId/credentialId/权限集合）挂上，内容端点与能力端点直接复用，不再各查一遍。
- **背后表**：`ext_login_credentials`（按 `secret_hash` 查）、`auth_user`（banned）、`ext_user_devices`（吊销）、`ext_rate_limit`（`kind = 'login-failure'`，IP 限流）、`ext_user_permissions`（权限与会员，经 `readSnapshotAccess` 回源）。
- **位置**：`src/server/api/credential-bearer.ts` `decideLoginCredentialApiRequest`；验票 SQL 在 `src/server/auth/login-credentials.ts` `loginCredentialVerifyStatement`；端点 → 码映射在 `src/server/api/api-permissions.ts` `requiredApiPermission` 与 `DOMAIN_RULES`。

### B5 版本门 stage2 — 426

- **作用**：身份已知后叠加灰度规则（按 device / user / percent），stage1 读回的输入显式复用，不重复查库。
- **背后表**：同 B3。
- **位置**：`src/middleware.ts`（二次 `requireAppVersion` 调用）。

### B6 配额消费 — 429

- **作用**：凭证有效且版本门通过才计数；随机 token 到不了这里，配额表不会被灌垃圾行。
- **判定**：`consumeAppRequestQuotaFromRow` 判定 + 单条 UPSERT；达上限不写库，只补 Cache 标记（让后续请求死在 B1）。
- **背后表**：`ext_rate_limit`（`kind = 'app-quota'`，10,000 次 / 24h / 凭证，窗口翻转原地重置）。
- **位置**：`src/server/rbac/app-quota.ts` `consumeAppRequestQuotaFromRow`。

### B7 automation 头校验 — 400

- **作用**：非安全方法的 `Microfeed-Causation-Id` / `Microfeed-Correlation-Id` 必须符合 schema，自动化调用的追踪链才可信。此关对通道 B/C 的所有 `/api/` 请求生效。
- **背后表**：无。
- **位置**：`src/middleware.ts`（`apiWebhookContextHeadersSchema.safeParse`）。

### B8 审计落库（响应后）

- **作用**：`next()` 之后按**真实响应状态码**写 `ext_api_access_log` 一行（allow/deny 双向留痕；deny 的 403 在返回前就写）。经 `waitUntil` 移出关键路径。
- **背后表**：`ext_api_access_log`（`api_key_id` 与 `credential_id` 恰好一个非空，区分两条 bearer 通道）。
- **位置**：`src/server/api/access.ts` `writeApiAccessLog`。

### B9 handler 与端点自治

- **作用**：内容端点（`src/pages/api/AppBookRequest/*.ts`）**无守卫**，直接读 `locals.appMember` 决定会员档位——全部守卫已由中间件完成。两类例外在端点内自治：
  - `/api/app/*` 能力端点（version / announcements / search-permission / mingci-permission）：`resolveAppPermissionSet` 复用 `locals.appAuth` 的权限集合，按各自码判布尔，端点把事实翻译成 401/403/500；version 端点另写 `ext_app_login_log`。
  - 匿名登记的登录态端点（补邮箱两端点、QQ 绑定三端点）：`requireAppUser`（验 `mflc_` 令牌 + banned）+ `verifyReauth`（口令或 QQ openid 再认证）+ `consumeBindQuota`（`ext_rate_limit` 的 `kind = 'bind-quota'`）。它们必须登记进匿名名单——登记成内容路由会继承会员权限模型，普通 QQ 用户直接 403。
- **位置**：`src/server/app/permission/resolve.ts` `resolveAppPermissionSet`；`src/server/app/bind-email/guard.ts` `requireAppUser` / `verifyReauth` / `consumeBindQuota`。

## 4. 通道 C · OpenAPI 密钥 / OAuth

### C1 content 域禁 legacy key — 404

- **作用**：小说内容读 API 是登录凭证专属（ADR-0006）：legacy `mf_` 密钥只有粗粒度 `content:read` scope，一放就漏整库，所以带 legacy key 访问 content 域直接 404（隐藏端点存在性）。
- **位置**：`src/middleware.ts`（`API_BASE_PATH` + `content/` 前缀 + `providedApiKey` 判定）。

### C2 legacy 密钥判定

- **作用**：通道 C 的主判定，一次查表同趟取回判定与归属（审计要用）。
- **判定**：`decideLegacyApiRequest` 分支：
  | 分支 | 结果 |
  | --- | --- |
  | allow-reference | 文档展示开关开启 → 放行 + 弃用头 |
  | not-found | 集成功能未开 → 404 |
  | unauthorized | 无 key / 校验失败 → 401 |
  | insufficient-scope | scope 不够 → 403（写 deny 审计行） |
- **背后表**：`api_keys`（按 `secret_hash` 查，读 `scopes`）、`ext_api_key_owners`（密钥 → 归属账号）、OAuth 令牌表（`oauth_access_token` / `oauth_refresh_token`，无 key 时回落校验）。
- **位置**：`src/server/api/access.ts` `decideLegacyApiRequest`。

### C3 scope 与 RBAC 的两套语义

- **作用**：通道 C 判的是 OAuth **scope**（`content:read` / `content:write` 两档，方法映射：GET/HEAD→read、其余→write），不判 RBAC 权限码；通道 B 判的是细粒度 RBAC 码。同一把凭证在两条通道的能力完全不同——这是刻意的：密钥给机器集成用，凭证给 App 用。
- **位置**：`src/server/api/access.ts`（scope 判定）；`src/server/api/api-permissions.ts`（RBAC 码判定）。

### C4 公共尾巴

- 与通道 B 共享：automation 头校验（400）、`loadFeed`（通道 B 跳过，C 需要内容 locals）、`next()` 后审计落库。

## 5. 共同底层判定

### 5.1 `guard.ts` 的 8 步顺序（顺序即定论，改动等于权限漏洞）

1. 未登录 → **401**
2. `auth_user.banned = 1` → **401**
3. 设备被吊销 → **401**（带 `X-Device-Revoked: 1`）
4. 角色禁入后台（`allow_admin_login` 并集为 0）→ **403**
5. `must_change_password` 且未豁免 → **428**（**休眠**：无写者，0042 清空，分支备用）
6. 持通配 `*` → 放行（短路，不展开目录）
7. 权限码在集合内 → 放行
8. 其余 → **403**

步骤 2–5 刻意排在 6–7 之前：被吊销设备的超管必须被踢出，与持有什么码无关。实现上拆成两半——账号半段 `requireAccountAccess`（1–5 步）与权限半段 `hasPermission` / `requirePermission`（6–8 步），组合函数：

| 函数 | 用途 |
| --- | --- |
| `requireRbac` | 防重放 → 账号门 → 权限码（标准端点） |
| `requireAuthenticatedRbac` | 防重放 → 账号门，无权限码（自助凭证端点） |
| `requireAudienceGuard` | `requireRbac` + 按 `audience` 分派守卫码：desktop → `system:role:manage`，app → `system:app-capability:manage`（调用方不带端一律 400；只持 App 码进不了 PC 端，反之亦然） |
| `withRbacGuard` | 包住 re-export 型路由文件的组合器 |
| `rbacAllows` | 菜单可见性布尔视图；`code = null` 表示公共入口。与 `requirePermission` 共用 `hasPermission`，菜单和端点永远不会给两个答案 |

通配与判码的唯一实现在 `src/server/rbac/resolve.ts` `permissionsInclude`：集合含 `RBAC_WILDCARD`（`*`）或含该码即放行；null/空集 deny-by-default。

### 5.2 权限快照点查

后台每请求的判定数据来自**一条 SQL、一行**（原来 3 条 SQL 读 27 行，实测 25.33µs → 7.67µs）：

```sql
SELECT u.banned, sec.must_change_password,
       s.codes, s.is_member, s.admin_login_allowed
  FROM auth_user u
  LEFT JOIN ext_user_security sec ON sec.user_id = u.id
  LEFT JOIN ext_user_permissions s ON s.user_id = u.id
 WHERE u.id = ?;
```

- 账号不存在（0 行）→ 调用方按封禁处理；账号存在但无快照行（零角色）→ 空权限 + 拒进后台，**fail-closed**。
- `banned` 不进快照：这条语句已经 LEFT JOIN 顺带取回，物化只多一处要同步的写点。
- 快照是仓库里**唯一的物化镜像**：改真源（`ext_user_roles` / `ext_role_permissions` / `ext_roles`）的 9 个写入点必须在同一批 `db.batch` 里重算，重算语句只能来自 `src/server/rbac/snapshot.ts` 的两个构造器；`tests/unit/permission-snapshot.test.ts` 沿语法树逐函数检查漏调。

### 5.3 端点权限码与 fail-closed

`requiredApiPermission`（`src/server/api/api-permissions.ts`）按规范化路径匹配 `DOMAIN_RULES`：**未登记 = null = 拒绝**。方法分派：GET/HEAD→`read`（或 `readAnyOf` 双码任一）、POST→`create`??`write`、PUT/PATCH→`update`??`write`、DELETE→`delete`??`write`。App 内容端点的码自 0131 起一门一用途（`app:nav:read` / `app:chapter:read` / …），search-permission 是 `readAnyOf` 双码门。

### 5.4 fail-open 名单与两道防线

通道 B 的总闸是「不在名单即匿名」，这是 fail-open。防线有二：

1. `tests/unit/api-permissions.test.ts` 枚举 `src/pages/api/AppBookRequest/` 下真实 handler 文件，任何一条路由既不在内容集合也不在 `APP_BOOK_REQUEST_ANONYMOUS_ROUTES` 里就挂 CI；
2. `scripts/check-endpoint-registration.ts` 做同向校验。

新增匿名路由时只改 `access.ts` 的匿名集合，测试清单自动跟上。

## 6. 权限域数据表总索引

字段级说明见各锚点章节；这里给「谁是谁、谁引用谁」。删除行为只列关键的。

### 6.1 认证域（Better Auth）

| 表 | 中文名 | 关键外键 | 12 册 |
| --- | --- | --- | --- |
| `auth_user` | 用户主体 | 被 18 张表引用 | §2.1 |
| `auth_session` | 登录会话 | userId → auth_user CASCADE | §2.2 |
| `auth_account` | 凭证关联（密码哈希所在，providerId 只有 credential） | userId → auth_user CASCADE | §2.3 |
| `auth_verification` | 验证令牌 | 无 | §2.4 |
| `auth_rate_limit` | 认证限流（better-auth 自带，仅 `/api/auth/*` 使用；与自持的 `ext_rate_limit` 无关） | 无 | §2.5 |
| `auth_password_setup` | 初始/重置密码令牌（仅 owner） | 无 | §2.6 |
| `passkey` | 通行密钥 | userId → auth_user CASCADE | §4.1 |
| `oauth_client` | OAuth 客户端 | userId → auth_user CASCADE | §3.4 |
| `oauth_refresh_token` | OAuth 刷新令牌 | clientId CASCADE、sessionId SET NULL、userId CASCADE | §3.5 |
| `oauth_access_token` | OAuth 访问令牌 | 同上 + refreshId CASCADE | §3.5 |
| `oauth_consent` | OAuth 同意记录 | clientId / userId CASCADE | §3.5 |
| `oauth_connection` | 用户已连接的 OAuth 应用 | clientId / userId CASCADE | §4.2 |

### 6.2 RBAC 域（自研判定引擎）

| 表 | 中文名 | 关键外键 | 12 册 |
| --- | --- | --- | --- |
| `ext_roles` | 角色目录（含 allow_admin_login / is_member 两个角色级开关） | 无 | §5.1 |
| `ext_permissions` | 权限码目录 | 无 | §5.1 |
| `ext_role_permissions` | 角色持有哪些码 | 双 CASCADE | §5.1 |
| `ext_user_roles` | 账号持有哪些角色 | 双 CASCADE | §5.1 |
| `ext_user_security` | 账号安全标记（must_change_password，休眠） | user_id → auth_user CASCADE | §2.11 |
| `ext_user_permissions` | **权限快照**（0162；0045 同名表是历史重写后的占位，勿混淆） | user_id → auth_user CASCADE | §5.1 |
| `ext_permission_nodes` | 权限树（audience 分 PC/App；kind = group/page/code） | 无 | §5.1 |
| `ext_menu` | 后台菜单行（可见性靠 permission_code 直列） | 无 | §5.1 |
| `ext_menu_permissions` | 菜单→码映射（**已删除**，0164；退役后零读零写） | 无 | §5.1 |
| `ext_rbac_audit` | 角色与授权改动审计 | 无 | §5.1 |

### 6.3 凭证 / 设备 / 安全域

| 表 | 中文名 | 关键外键 | 12 册 |
| --- | --- | --- | --- |
| `ext_login_credentials` | 个人登录凭证（`mflc_` 令牌） | user_id → auth_user（**NO ACTION**，删号须显式删） | §6.1 |
| `ext_rate_limit` | 限流与一次性台账（0166，ADR-0056）：`kind` 区分 auth-throttle / app-quota / bind-quota / login-failure / email-otp-ip / replay-nonce / captcha-nonce | 无 | §2.9 / §2.13 / §2.14 / §2.16 |
| `ext_user_devices` | 设备登记与吊销 | user_id → auth_user CASCADE | §2.12 |
| `ext_email_otp` | 邮箱验证码（purpose 隔离） | 无 | §2.8 |
| `auth_account`（qq 行） | 第三方 openid 绑定（QQ，ADR-0055 由 `ext_user_oauth` 并入） | userId → auth_user CASCADE | §2.10（12 册） |
| `ext_app_login_log` | App 登录时间日志（每设备每日一条） | user_id → auth_user CASCADE（可空） | §2.15 |
| `microfeed_installation` | 实例身份 | 无 | §2.7 |

### 6.4 API 密钥 / 审计域

| 表 | 中文名 | 关键外键 | 12 册 |
| --- | --- | --- | --- |
| `api_keys` | 签名调用密钥（`mf_`，哈希存储） | 无 | §3.1 |
| `ext_api_key_owners` | 密钥归属账号 | 双方均无 ON DELETE 子句 | §3.2 |
| `ext_api_access_log` | 签名/凭证调用审计（**删号保留**） | 无 | §3.3 |
| `ext_admin_typeahead` | 后台 typeahead FTS5 派生表（应用层创建，非迁移） | 无（触发器同步自 items） | §2.17 |

## 7. 附录 · 状态码速查

| 状态码 | 含义 | 触发关卡 |
| --- | --- | --- |
| 308 | 路径规范化重定向 | A1（canonicalPathname / App 大小写归一） |
| 302 | 登录页/后台互跳 | A4 未登录跳登录、A5 已登录跳后台 |
| 400 | 防重放 / automation 头非法 | B2（`checkReplay`）、B7（头 schema） |
| 401 | 未认证：无会话、验票失败、banned、设备吊销 | A4、A6→guard 第 1–3 步、B4 unauthorized/deviceRevoked、C2 |
| 403 | 已认证但被拒：无权限码、角色禁入后台、scope 不足、CSRF | guard 第 4/8 步、A7、A8、B4/C2 insufficient-scope、能力端点 |
| 404 | 隐藏存在性：adminPath 冒名、端点未登记、集成未开、content 域 legacy key | A2、B0 名单外的登录态端点、B4 notFound、C1/C2 |
| 426 | App 版本过低（含缺头） | B3 / B5（`requireAppVersion`） |
| 428 | 必须改密（**休眠**，无写者） | guard 第 5 步 |
| 429 | 限流 / 配额耗尽 | B1（Cache 标记）、B4 throttled、B6 配额、C2 前置限流 |

## 8. 修改指引

- **新增后台 ajax 端点**：handler 内按需挂 `requireRbac` / `requireAudienceGuard` / `requireAuthenticatedRbac`；权限码三镜像同批改（见 12 册 §8）。
- **新增 App 内容端点**：在 `access.ts` 的内容集合登记（漏了就匿名）；在 `api-permissions.ts` 的 `DOMAIN_RULES` 配码；灰度与配额自动生效，无需改中间件。
- **新增 App 匿名端点**：登记进 `APP_BOOK_REQUEST_ANONYMOUS_ROUTES`，两道防线测试自动覆盖。
- **改判定顺序**：只动 `src/server/rbac/guard.ts`；`tests/worker/rbac.test.ts` 守 401/403/428 分支。
- **排查被拒请求**：先查 `ext_api_access_log`（通道 B/C，`granted`/`status`/`permission_code` 三列直接给答案），后台请求按 §2 逐关对状态码。
