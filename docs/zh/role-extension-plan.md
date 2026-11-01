---
title: 多角色（RBAC）接入与鉴权
description: microfeed 基于 Better Auth admin 插件接入多用户多角色，以及后台路径、ajax 接口、角色管理页面的鉴权方式。
---

# microfeed 多角色（RBAC）接入与鉴权

> 状态：**已作废**（2026-11-01）。本文描述的模型（`Roles.ts` / `role-guard.ts` / `user-admin.ts` / `0025_user_roles.sql` / admin 插件 `adminRoles`）大半未最终采用：真实实现是 `0028_ext_rbac` 起建的 `ext_roles` / `ext_role_permissions` / `ext_user_roles` 五表，判定引擎在 `src/server/rbac/`。admin 插件本身也已移除（ADR-0054），§四的插件配置整节失效。
> 当前口径以 `docs/zh/12-user-system-schema.md` 为准；本文只作为历史提案保留。

## 一、角色与权限模型

### 1.1 四个角色

| 角色 | 定位 | 关键能力 |
| --- | --- | --- |
| `owner` | 实例所有者 | 全部权限；唯一能**删除成员**、唯一能**授予 owner** |
| `admin` | 管理员 | 内容、页面、频道、站点文件、API 密钥、Webhook、设置、主题；可管理成员但不能删除 |
| `editor` | 编辑 | 内容与页面增删改、上传媒体；设置/API/Webhook 只读或不开放 |
| `viewer` | 只读成员 | 内容、页面、频道、站点文件、主题只读 |

登录后的默认角色 = `viewer`（`DEFAULT_ROLE`）。历史数据里 `role` 为 `NULL` 或空白的用户，按 `viewer` 处理，**不会被当成管理员**。

### 1.2 权限语句表

`src/shared/Roles.ts` 用 Better Auth 的 `createAccessControl` 声明资源与动作：

```
content   : read create update delete
channel   : read update
pages     : read create update delete
siteFiles : read update
media     : upload
api       : read manage
webhooks  : read manage
settings  : read update
users     : read create update delete
themes    : read manage
```

每个角色通过 `accessControl.newRole({...})` 声明自己的语句子集。**新增资源或动作时只改这一处**，角色定义、`role-guard` 的资源类型都从它派生。

## 二、鉴权链路（核心）

请求进入后台后，判定顺序如下：

```
1. 是 /api/auth/* ？        → 交给 Better Auth 自己处理（登录、登出、会话）
2. 是 /api/v1/* 集成接口？   → 走 API Key / OAuth token 的 scope 判定（与 role 无关）
3. 是后台路径 /<adminPath>/*？
   ├─ 未登录              → 401（ajax）或跳登录页
   ├─ 无 session 且无 owner → 后台锁定页（adminDashboardLockedResponse）
   └─ 有 session           → 角色闸门 decideAdminAccess()
```

### 2.1 角色闸门（`src/middleware.ts`）

在 `context.locals.authUser` 就绪之后、跨域检查之前插入：

```ts
if (builtInAuthEnabled && context.locals.authUser) {
  const access = decideAdminAccess({
    method: request.method,
    relativePath: 去掉 adminPath 前缀后的路径,
    role: authUser.role,
  });
  if (!access.allowed) → 403（ajax 返回 {error:"forbidden", required:...}）
  context.locals.authUserRole = access.role;   // 供后续页面/接口读取
}
```

**Cloudflare Access 模式下（`MICROFEED_ADMIN_AUTH_MODE` 关闭内置登录）不启用角色闸门**——此时没有本地用户身份，权限由 Access 策略在 Worker 之前决定。这是防止把后台锁死的关键条件。

### 2.2 路径 → 权限映射（`src/server/auth/role-guard.ts`）

按前缀最长匹配，命中后写入操作再降级为 `read`：

| 后台路径前缀 | 需要权限 |
| --- | --- |
| `account`、`login`、`api/oauth/consent` | 登录即可（不判权限） |
| `settings/users` | `users:read` |
| `settings/code-editor` | `settings:update` |
| `settings/themes` | `themes:manage` |
| `settings` | `settings:read` |
| `api/settings`、`api/keys` | `api:manage` |
| `api` | `api:read` |
| `webhooks` | `webhooks:manage` |
| `site-files` | `siteFiles:update`（GET 降级为 read） |
| `pages` | `pages:create`（GET 降级为 read） |
| `channels` | `channel:update`（GET 降级为 read） |
| `items` | `content:update`（GET 降级为 read） |
| `feed` | `content:create`（GET 降级为 read） |
| 其他 | 兜底 `content:read` |

**未命中任何规则的后台路径一律要求 `content:read`**——最小权限，宁可拒绝也不默认放行。

### 2.3 页面与 ajax 共用同一份规则

`decideAdminAccess` 会对 `ajax/` 前缀做剥离再匹配。这意味着：

- 页面 `items/list` 需要 `content:read`，接口 `ajax/items` 也需要同一权限；
- 不存在「页面进不去但接口能调」的缺口；
- 但**也意味着页面被判 403 时对应接口同样 403**，两者保持一致是刻意的。

### 2.4 三层防线

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 路由层 | `middleware.ts` | 页面与所有 `/ajax/` 的准入，**唯一的安全边界** |
| 接口层 | 各 ajax handler（如 `ajax/users/index.ts` 里再查 `isAdminRole`） | 纵深防御，防止中间件被绕过 |
| 业务层 | `user-admin.ts`（最后一个 owner 不可降级/不可删除、不能操作自己） | 数据一致性约束 |

### 2.5 菜单隐藏只是体验层

`AdminSettingsSidebar` 按 `viewerRole` 过滤掉 `users` 区块，`SettingsApp` 按 `isAdminRole` 决定是否渲染。**这不是安全边界**——真正的拦截在 `middleware.ts`。

## 三、角色管理页面（独立页面）

位置：后台 → 设置 → **角色与权限**（`settings#roles`）。**仅 owner 可见**。

与「成员与角色」页面的分工：

| 页面 | 管什么 | 权限 |
| --- | --- | --- |
| 设置 → 角色与权限（`#roles`） | **角色本身**：四种角色各自能做什么 | 仅 owner |
| 设置 → 成员与角色（`#users`） | **人**：把某个成员指派为某个角色 | owner / admin |

角色页面呈现四张卡片（owner / admin / editor / viewer），每张按 10 类资源 × 动作勾选，保存即写入 `role_permissions` 表并立即生效。

**权限存库，不再写死在代码里**：

- 表：`role_permissions(role PK, permissions TEXT JSON, builtin, created_at, updated_at, ext1~ext10)`（`0026_role_permissions.sql`）。
- 读取：`src/server/auth/role-store.ts` 的 `loadRolePermissions()`，带 **30s 进程内缓存**（`CACHE_TTL_MS`），避免每个后台请求都读 D1；保存时 `invalidateRolePermissions()` 立即失效。
- 缺行回退：库里没有某角色（迁移未执行）时回退 `DEFAULT_ROLE_PERMISSIONS`，不会因为读不到配置而全员失权。

**四条硬约束**（写在 `role-store.ts` / 页面里）：

1. **owner 权限不可编辑**：`saveRolePermissions` 对 `role='owner'` 返回 409 `owner_locked`；`buildRoleDefinitions` 对 owner 强制使用全权限，任何配置都无法削弱它。
2. **正文清洗**：`sanitizePermissions()` 只保留语句表里存在的资源与动作，未知键与非数组值一律丢弃（防提权/脏数据）。
3. **必须能读内容**：保存时若 `content` 不含 `read`，返回 400 `requires_content_read`——否则该角色登录后进后台就是一片 403。
4. **角色权限矩阵本身是元权限**：语句表新增 `roles: ["read","manage"]`，只有 owner 持有；`settings/roles` 路径要求 `roles:manage`，所以 **admin 打不开角色页、也调不到 `ajax/roles`**（此漏洞由测试用例 1 发现并已修）。

接口：

- `GET   /<adminPath>/ajax/roles` — 返回四角色权限矩阵（owner 专属）
- `PATCH /<adminPath>/ajax/roles/<role>` — `{permissions}` 保存某角色（owner 专属；owner 返回 409）

## 四、成员管理页面

位置：后台 → 设置 → **成员与角色**（`settings#users`），仅 `owner`/`admin` 可见。

能力：

| 操作 | 谁可以做 | 约束 |
| --- | --- | --- |
| 查看成员列表 | owner / admin | — |
| 修改角色 | owner；admin（仅限非 owner 成员） | 只有 owner 能授予 owner；不能把最后一个 owner 降级（409 `last_owner`） |
| 停用/允许登录 | owner / admin | 不能操作自己；停用会同时吊销该用户全部会话 |
| 删除成员 | 仅 owner | 不能删自己；不能删最后一个 owner；级联清理 session/account/passkey/OAuth 凭据 |

接口：

- `GET  /<adminPath>/ajax/users` — 列表
- `PATCH /<adminPath>/ajax/users/<userId>` — `{role}` 改角色 / `{banned}` 停用或启用
- `DELETE /<adminPath>/ajax/users/<userId>` — 删除

错误码：`forbidden`(403)、`last_owner`(409)、`self`(409)、`not_found`(404)、`invalid_role`(400)。

## 四、Better Auth 侧配置（`better-auth.ts`）

> **整节已作废（ADR-0054）。** admin 插件已从 `plugins` 数组移除，`auth_user.role` 停写停读、存量值由 `0163` 清为 NULL。下面这段配置与「两点必须说明」都不再成立：`/api/auth/admin/*` 的 15 条端点已不存在，`getSession()` 也不再返回 `role`。保留原文只为记录当时的设想。

```ts
admin({
  ac: accessControl,
  adminRoles: ["owner", "admin"],
  defaultRole: "viewer",
  roles: roleDefinitions,
}),
user: {
  additionalFields: {
    role: {input: false, required: false, type: "string"},
  },
},
```

两点必须说明：

1. **`adminRoles`** 决定谁能调用 admin 插件自身的 `/api/auth/admin/*` 接口（`listUsers`/`setRole`/`banUser` 等）。后台页面走的是自定义 `/ajax/users`，不用这些接口。
2. **`user.additionalFields.role`** 必须声明，否则 `getSession()` 返回的 user 不含 `role`，middleware 每次都得多查一次库。机制依据：`filterOutputFields(user, getFields(options,"user","output"))`，`additionalFields` 会被并入输出 schema。
3. **`input: false`** 表示禁止用户在注册/更新资料时自行写 `role`，只能由服务端改——防提权。

## 五、迁移（`migrations/0025_user_roles.sql`）

只做三件事，**不新增列**（`role` 在 0002 已存在）：

1. 最早创建的用户回填 `owner`（沿用旧的「首用户即管理员」约定）；
2. 其余 `role IS NULL` 或空白的回填 `viewer`；
3. 加触发器拦非法角色值 + `auth_user(role)` 索引。

已验证（SQLite 内存库，2026-10-31）：空库执行无错、回填结果正确、非法角色插入/更新均被 `invalid_role` 拒绝、重复执行幂等且不覆盖已有角色。

## 六、已知边界与后续

**L1 已完成**（角色 → 路由准入）。以下未做：

- **L2 数据行级权限**：「editor 只能改自己创建的条目」尚未实现。`items`/`pages` 没有 `created_by` 列，需要新迁移加列（或用 `ext1`~`ext10` 槽位），再逐个 ajax 接口拼 `WHERE`。当前所有有写权限的角色都能改全部内容。
- **L3 API scope 细化**：`/api/v1/*` 仍是 `content:read` / `content:write` 两个 scope（`access.ts`），与 role 独立；`api_keys` 表没有私 scope 列。
- **邀请/建号流程**：目前没有「邀请成员」入口，新成员仍需通过 `manage auth setup` 或直接写库创建凭据。`emailAndPassword.disableSignUp = true`，不开放自助注册。

## 七、回归验证要点

改动此链路后至少覆盖：

1. owner 进 `/settings#users` 能看到成员列表；editor 访问 `settings/users` 得 403；editor 的侧栏不出现该区块。
2. viewer 打开 `items/list` 正常，调用 `PATCH /ajax/items/<id>` 得 403。
3. editor 能改 items，打开 `settings` 得 403，`webhooks` 得 403。
4. 把唯一 owner 降级 → 409 `last_owner`；删自己 → 409 `self`。
5. 停用某成员后，该成员的会话立即失效（`auth_session` 行被删）。
6. `MICROFEED_ADMIN_AUTH_MODE` 关闭内置登录时，角色闸门不生效，后台仍可经 Access 进入。
