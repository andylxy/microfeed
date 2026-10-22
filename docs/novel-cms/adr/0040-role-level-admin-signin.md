# ADR-0040: 角色级「允许登录后台」开关

- 状态：Accepted
- 日期：2026-10-20
- 决策人：用户 + 设计评审
- 关联设计：ADR-0039（角色控制台的单页形态）、`src/server/rbac/resolve.ts` 的 `userMayEnterAdmin`、`src/server/rbac/guard.ts` 的账号门、migration 0132
- 本 ADR 来源：用户在角色管理弹窗提出「再添加一项，登录后台 允许 / 不允许」

## 背景

角色目前只表达「能做什么」（权限码集合）。「能不能进后台」这件事此前没有独立表达：一个账号只要通过登录，就能打开后台首页（首页本身没有页级权限闸，只是内容为空）。于是「只给 App 用的账号」只能靠「不给任何码」表达，而它仍然能进后台，看到一个空壳。

| 事实 | 位置 |
| --- | --- |
| 角色只有 `code` / `name`，没有入口相关列 | `migrations/0028_ext_rbac.sql` |
| 后台入口由会话决定，会话建立后不再看角色 | `src/middleware.ts` 的后台分支 |
| 端点守卫的账号门只看 登录 / 封禁 / 设备吊销 / 改密待办 | `src/server/rbac/guard.ts` 的 `requireAccountAccess` |
| 凭证登录（`mflc_…` 换会话）只查账号是否被封禁 | `src/server/auth/credential-login.ts` |

## 决策

### D1｜开关放在角色行上，默认允许

`ext_roles.allow_admin_login INTEGER NOT NULL DEFAULT 1`（migration 0132）。角色是权限的容器，入口资格同样是角色的属性；放进权限目录会让它变成一个可授予的码，与「角色 × 开关」的二维关系错位。默认 1 让升级不改既有库的行为。

### D2｜多角色取并集，没有角色则不设限

账号持多个角色时，任一角色允许即可进入——与权限集合的并集口径一致。**没有任何角色**的账号不设限：这一列是角色挂上的否决位，不是一份准入名单；账号在分配角色之前不该被它挡住，否则「把角色删光」会意外变成一种登录方式。

### D3｜`super_admin` 固定为允许

它是唯一持有 `*` 的角色，关掉就等于把整个后台锁在门外，而且没有第二个入口改回来。服务端拒绝（`loginLocked`），弹窗里那颗开关禁用并给出原因。

### D4｜三个拒绝点，App 内容接口不受影响

- **中间件**（页面与后台 Ajax）：解析出 RBAC 上下文后，开关为 false 就给可读的 403。登录页仍然放行——被拒的会话必须能换账号登录，否则只能自己清 cookie；登录页也不会把这类会话弹回后台，避免来回跳转。
- **端点守卫**（`requireAccountAccess`）：`rbacAdminLoginAllowed === false` 一律 403，通配授权也不例外。这一层是兜底：中间件漏掉的路径也不能漏判。
- **凭证登录**：在建会话之前拒绝（403），不记失败次数——凭证本身是对的，记了会把正确凭证一起限流。
- **账号密码登录**（`/api/auth/sign-in/email` 与 `/api/auth/sign-in/username`）：better-auth 的 sign-in 通道与凭证登录是两条独立路径，此前没有这道门——密码对了就会话 cookie 照发，账号下一次请求才被 403 弹回。现在在 `src/pages/api/auth/[...all].ts` 的响应后处理上补判（`src/server/auth/admin-signin.ts`）：只对**已通过密码校验**的成功响应查角色，失败登录仍走统一的不对称错误，不泄露账号是否存在；拒绝时返回 403 且**不带任何 `set-cookie`**，不给进不了后台的账号留下可用会话。登录卡把 403 显示为「当前角色不允许登录后台」，与「凭据不正确」分开。
- 同一道门还覆盖 `/api/auth/passkey/verify-authentication`：登录卡不开放 passkey 登录，但端点可直连，成功分支（`ctx.json({session, user})` + `setSessionCookie`）与 sign-in 同形，一并入列。三条路径共用「2xx + body 顶层带 `user`」的形态约定，`enforceAdminSignIn` 只依赖这一约定；拒绝响应由 `adminLoginDeniedResponse` 统一构造，与凭证登录通道共用一份，文案不漂移。

App 内容命名空间按登录凭证逐请求鉴权，不读这一列：关掉后台入口不应让一个 App 账号的连接凭证失效。

## 后果

- 角色弹窗右栏多一行「登录后台」开关（允许 / 不允许），与显示名称、角色代码、已有权限同列。
- 关掉后，只持该角色的账号在下一次请求就被拒，不需要等重新登录；重新允许后原有授权原样还在（这一列不碰 `ext_role_permissions`）。
- 改角色代码的重建流程会把这一列一起复制过去（`renameRbacRoleCode` 的 `INSERT … SELECT` 已带上）。
- **已知边界**：开关只看「角色是否允许」，不区分页面；被拒账号仍能通过 `/admin/login` 换账号。没有「按时间段允许」之类的细化。

## 验证口径

- 纯函数：`tests/worker/rbac.test.ts` 锁默认允许、关掉后单角色拒绝、多角色并集放行、无角色不设限、`super_admin` 不可关、改代码带过去。
- 账号密码登录通道：`tests/worker/auth.test.ts` 锁「密码正确 + 角色被关 → 403 且不下发 cookie」「并集放行 → 200 且有 cookie」「开关重开 → 200」。
- 后处理门单元：同文件锁 passkey 路径同形被拦、非登录端点/非 2xx/无 `user.id` 三种放行、允许时原样透传（含 cookie）。
- 端点：同一文件锁 `role-login` 的三档守卫（401 / 403 / 200）、非布尔体 400、`super_admin` 400 且板子仍为允许。
- 组件：`tests/unit/components/rbac-role-manager.test.ts` 锁开关文案（Allowed / Not allowed）与通配角色禁用态。
- 浏览器人工核对仍是最后一道：关掉某角色的开关后，用只持该角色的账号登录后台应看到 403 文案，登录页仍可换账号。

## 修订（2026-10-22）：新建角色默认不允许

- D1 原文的「默认允许」只描述 0132 当时的形态：`ext_roles.allow_admin_login` 的列默认值仍是 1，种子角色（`super_admin` / `editor` / `readonly`）靠它才能进后台，这一点不变。
- 从 0144 起，**通过管理界面新建的角色**默认不允许登录后台：`createRbacRole` 的 INSERT 显式写 `allow_admin_login = 0`（同批加 `is_member`，默认 0）。没有改列默认值——SQLite 改默认要重建表，会牵连 `ext_role_permissions` / `ext_user_roles` 两张子表。
- 验证口径同步更新：`tests/worker/rbac.test.ts` 的「新角色默认」断言由允许改为不允许；`role.login` / `role.member` 两个审计动作登记进 `RBAC_AUDIT_ACTIONS` 与 `rbacAudit.actionLabel`。
