# 后台菜单按角色权限加载显示 · 实施方案

> **⚠️ 本文已作废（2026-09-22 23:20）。** 它把"菜单 ↔ 权限"的映射写进了代码（给每个菜单项加 `anyOf` 数组），
> 与参照实现 BasicApp 的做法相反。BasicApp 的菜单是**数据库行**，菜单与权限的绑定是行上一个**可空外键**，
> 加载时按权限集过滤。请以 [`spec.md`](./spec.md) 为准。
> 本文仅 §0（现状查证）、§2（editor 授权缺口）、§5（页面守卫清单）三节仍然有效并被新文档引用。

---

查证时间：2026-09-22 · 分支 `feat/login-credential`（工作未提交）
范围：仅后台菜单与页面守卫，**不改 `better-auth.ts`、不动 `auth_user` 结构、不动签名 API 路径**

---

## 0. 现状（逐项查证）

| 事实 | 位置 | 结论 |
| --- | --- | --- |
| 菜单项 16 项硬编码全量产出 | `src/shared/AdminNavigation.ts:15-46` | 不感知权限 |
| 侧栏构建不传权限 | `src/layouts/AdminShell.astro:133` 调 `getAdminNavigationItems(adminPath, activeNavItem, onboardingResult)` | 签名中无权限参数 |
| `disabled` 只由初始化状态决定 | `AdminNavigation.ts:41` `!onboardingResult.requiredOk` | 与权限无关 |
| 权限解析链路完整 | `middleware.ts:454` → `resolveRbacContext()`（`resolve.ts:73`）→ `locals.rbacPermissions`（:459） | 可用 |
| 认证关闭时给通配 | `middleware.ts:479` `new Set([RBAC_WILDCARD])` | 已覆盖 |
| 浏览器不知道自己的权限 | `AdminShell.astro` 只传 `identity.builtInEmail` | 客户端无权限数据 |
| 页面级守卫仅 2 处 | `users/index.astro:19`、`rbac/index.astro:20` | 其余 14 个目的地无守卫 |
| 被拒页面是裸文本 403 | `return new Response(translate("errors.rbac.forbidden"), {status:403})` | 无外壳、无导航 |
| `/ajax/*` 一律要求登录 | middleware 未登录时 ajax 返回 401 | 有身份门，但多数无权限门 |

---

## 1. 菜单项 ↔ 权限码 完整对照表（16 项）

"端点是否用了该码"一栏很关键：它决定这个码是**真实边界**还是**仅目录里的名字**。

| # | 菜单项 | 路径 | 现有可用码 | 该码已被端点使用 | 处置 |
| --- | --- | --- | --- | --- | --- |
| 1 | ADMIN_HOME | `""` | — | — | **恒可见**（任何登录账号） |
| 2 | EDIT_CHANNEL | `channels/primary` | 无 | — | 补 `content:channel:manage` |
| 3 | ALL_ITEMS | `items/list` | `content:article:read` | ❌ 未被使用 | 直接用于菜单（读码） |
| 4 | IMPORT_CHAPTERS | `items/import` | `content:article:create` | ❌ 未被使用 | 直接用于菜单 |
| 5 | REVIEW | `review` | 无 | — | 补 `content:review:manage` |
| 6 | AUDIT | `audit` | 无 | — | 补 `content:audit:read` |
| 7 | PAGES | `pages` | 无 | — | 补 `content:page:manage` |
| 8 | CATEGORIES | `categories` | `content:category:read` | ❌ 未被使用（create/update/delete/order 已用） | 直接用于菜单 |
| 9 | BOOKS | `books` | `content:book:read` | ❌ 未被使用（create/update/delete 已用） | 直接用于菜单 |
| 10 | VOLUMES | `volumes` | `content:volume:read` | ❌ 未被使用（update 已用） | 直接用于菜单 |
| 11 | SITE_FILES | `site-files` | 无 | — | 补 `content:site_file:manage` |
| 12 | API | `api` | 无（`api:*` 属签名调用语义） | 端点无守卫 | 补 `system:api:manage` |
| 13 | WEBHOOKS | `webhooks` | `system:webhook:manage` | ✅ `withWebhookGuard` | 直接用 |
| 14 | RBAC | `rbac` | `system:role:manage` | ✅ | 直接用 |
| 15 | USERS | `users` | `system:user:manage` | ✅ | 直接用 |
| 16 | SETTINGS | `settings` | `content:settings:manage` | ✅ 仅 `ajax/api/settings.ts` | 直接用 |

**统计**：可直接用于过滤 **9 项**（其中只有 4 项是真实边界，5 个是仅存在于目录的读码）；需补码 **6 项**；特例 **1 项**。

---

## 2. ⚠️ 前置阻塞项：editor 角色的授权缺口

这一条不先修，菜单过滤会把 editor 的核心入口拿走。

- editor 现有授权共 **11 个码**：`book:read/update/create`、`category:read/update`、`volume:read/update`（迁移 0031）+ `api:content:read/write`、`api:media:read/write`（迁移 0035）。
- **editor 没有任何 `content:article:*`**。
- 但章节写路径 `ajax/feed.ts:148-153` 要求 `content:article:update`（删除时 `content:article:delete`）⇒ **editor 当前根本无法编辑或新建章节**（既有缺陷，与菜单无关但会同时暴露）。
- 若按 §1 把 ALL_ITEMS / IMPORT_CHAPTERS 映射到 `content:article:read/create`，editor 将**看不到内容列表与导入入口**——而这正是编辑的主要工作面。

**因此本方案必须包含 editor 授权补齐**（见 §3 表二），否则菜单过滤等于把 editor 降级。

---

## 3. 需补的权限码

### 表一：新增 6 个码（迁移 0040）

| 建议码 | 名称 | 覆盖菜单 |
| --- | --- | --- |
| `content:channel:manage` | 频道设置管理 | EDIT_CHANNEL |
| `content:review:manage` | 审核管理 | REVIEW |
| `content:audit:read` | 审计查看 | AUDIT |
| `content:page:manage` | 页面管理 | PAGES |
| `content:site_file:manage` | 站点文件管理 | SITE_FILES |
| `system:api:manage` | API 管理 | API |

命名沿用 `module:resource:action`（DESIGN.md 约定）。`system:api:manage` 与既有 `api:*`（8 个签名调用码）**语义不同、互不替代**：后者管"签名 API 能读什么资源"，前者管"谁能进后台 API 管理页"。

### 表二：editor 需补授权（同一迁移）

| 码 | 理由 |
| --- | --- |
| `content:article:read` | 才能看到内容列表 |
| `content:article:create` | 才能看到并使用导入章节 |
| `content:article:update` | 修复"editor 无法编辑章节"的既有缺陷 |
| `content:article:delete` | 与 delete 端点一致（是否授予由你定，见 §9） |

### 同步约束（三处必须一起改，否则门禁会红）

1. `src/server/rbac/seed.ts` 的 `RBAC_PERMISSIONS` 与 `RBAC_ROLES`；
2. 新迁移 `0040_*.sql`，全部 `INSERT OR IGNORE`（幂等，与 0031/0035 写法一致）；
3. `tests/worker/rbac.test.ts` 断言"SQL 里的 `ext_permissions` 行 == 代码侧目录"，新增码后这条例句会重新核对两边；editor 授权条数断言（现为 11）也要同步。

---

## 4. A 路线：服务端过滤 · 逐处改动

判定下移到服务端，浏览器拿到的就是已过滤的结果。好处：无首屏闪烁、不把权限模型下发到浏览器、与服务端判定同一份数据不会漂移。

**为什么不用 `requirePermission`**：它返回 `Response` 且带 401/428/设备吊销语义，菜单只需要一个布尔判断。建议新增一个纯函数（例如 `rbacAllows(locals, code)` 或 `hasRbacCode`），**不要复用返回 Response 的守卫**。

### 改动清单

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `src/shared/AdminNavigation.ts` | `NAVIGATION_PATHS` 每项增加 `anyOf: string[]`（为空 = 恒可见）；`getAdminNavigationItems()` 增加 `permissions` 参数并按规则过滤 |
| 2 | `src/layouts/AdminShell.astro:130-137` | 把 `Astro.locals.rbacPermissions` 传给 `getAdminNavigationItems()` |
| 3 | `src/components/admin/AdminSidebar.tsx` | **不改**（只按 `data.items` 渲染；已支持 `disabled` 态，两种呈现都可复用） |
| 4 | `src/server/rbac/guard.ts` | 新增纯判定函数（布尔版），供菜单复用通配与 legacy admin 语义 |
| 5 | `src/server/rbac/seed.ts` + `migrations/0040_*.sql` | §3 的 6 个码与 editor 补授权 |
| 6 | `tests/unit/shared/admin-navigation.test.ts` | 新增过滤用例 |
| 7 | i18n | **不需要新键**（复用现有 `nav.item.*`） |

### 判定规则（写进代码注释）

1. `permissions` 含 `*` ⇒ 全部可见；
2. `authUser.role === "admin"`（legacy Better Auth 管理员）⇒ 全部可见。与 `guard.ts:114-117` 保持一致，否则会出现"菜单看不见、URL 直接访问却放行"；
3. `ADMIN_HOME` 恒可见；
4. 其余项：`anyOf` 中**任一命中**即显示（用"任一"而非"全部"，因为读码与写码分别授予）；
5. 未命中 ⇒ **该项不产出**（从数组里移除），而不是置 `disabled`——置灰会暴露不该知道的功能名。

---

## 5. 页面守卫补齐清单

现状：16 个菜单目的地中只有 `users`、`rbac` 有页面守卫。以下 14 个需补。守卫码与 §1 表保持一致，避免菜单与页面漂移。

| 页面 | 现状 | 建议守卫码 | 备注 |
| --- | --- | --- | --- |
| `items/list`、`items/new`、`items/[itemId]` | 页面与 `ajax/items/**` 均无权限判定（`ajax/items/index.ts` 只导出 GET 列表） | `content:article:read`（读页）/ `content:article:create`（新建页） | 写路径已由 `ajax/feed.ts` 判 `article:update/delete` |
| `pages/**`、`ajax/pages/**` | 全无 | `content:page:manage` | 端点也需补守卫 |
| `site-files/**`、`ajax/site-files/**` | 全无 | `content:site_file:manage` | 端点也需补（5 个文件） |
| `review/**`、`ajax/review/**` | 全无 | `content:review:manage` | 含 corrections 4 个端点 |
| `audit/**`、`ajax/audit/**` | 全无 | `content:audit:read` | 只读 |
| `channels/primary` | 无 | `content:channel:manage` | |
| `settings/**`（含 themes、code-editor） | 仅 `ajax/api/settings.ts` 有守卫 | `content:settings:manage` | `ajax/themes/**`（5 个）、`r2-ops.ts` 需补 |
| `api/**`（keys / settings / explorer / oauth / credentials） | `ajax/api/keys/**`（3 个）无守卫 | `system:api:manage` | `ajax/api/credentials/**` 属自助，见下 |
| `books/**` | 页面无守卫（端点有） | `content:book:read` | |
| `categories/**` | 页面无守卫（端点有） | `content:category:read` | |
| `volumes/**` | 页面无守卫（4 个端点有守卫，`ajax/volumes/index.ts` 无） | `content:volume:read` | |
| `webhooks/**`（含 events/endpoints/deliveries） | 端点经 `withWebhookGuard` 有守卫，页面无 | `system:webhook:manage` | |
| `rbac`、`users` | 已有 ✅ | — | 保持 |

**有意不加码的三类**（不要误补）：
- `account/**`、`ajax/api/credentials/**`：自助区，只需"活着且是本账号"，用 `requireAuthenticatedRbac`，不给权限码；
- `login`、`login/set_password`、`ajax/auth/credential-login`：本就必须未登录可达；
- `ajax/search/index.ts`：搜索建议，随宿主页面权限即可。

---

## 6. 403 体验改造（建议同期做）

现状的裸文本 403 会让从书签直达的用户看到一屏白底文字。建议新增一个带外壳的"无权限"页（复用 `AdminPageFallback` 的思路），包含：提示文案 + 返回后台首页的链接。涉及 `users/index.astro:21`、`rbac/index.astro:22` 及 §5 新增的每一处。

---

## 7. 执行顺序

1. **T1** editor 授权补齐（seed.ts + 迁移 + 断言修正）—— 先修，否则后续过滤会误伤 editor
2. **T2** 新增 6 个权限码（seed.ts + 迁移 0040）
3. **T3** `guard.ts` 布尔判定函数 + 单元测试
4. **T4** `AdminNavigation.ts` 加 `anyOf` 与过滤 + `AdminShell.astro` 传参
5. **T5** 菜单过滤单测 + worker 用例（editor 能看到哪些项）
6. **T6** §5 页面守卫补齐（14 页 + 对应端点）
7. **T7** 403 体验页
8. **T8** 门禁与部署

## 8. 门禁

`yarn typecheck` / `yarn i18n:check` / `yarn lint` / `yarn vitest run` / worker 配置 / `yarn build`，全绿后部署并回读日志确认 `Deployed and verified`。部署前记得预清 `dist`。

## 9. 待你拍板

| # | 问题 | 建议 |
| --- | --- | --- |
| 1 | `content:article:delete` 是否授予 editor | 建议**不授**（editor 可增删改但不可删章节） |
| 2 | 无权限的菜单项：不显示 vs 置灰不可点 | 建议**不显示**（置灰会泄露功能名） |
| 3 | EDIT_CHANNEL 是否真的要权限门 | 建议要，但很多部署只有一个频道，也可恒可见 |
| 4 | §5 端点补守卫是否与菜单同批做 | 建议同批，否则"菜单藏了但接口仍开放" |
