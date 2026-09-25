# Spec：API 认证与授权收敛（ADR-0008 + ADR-0009）

来源：`docs/novel-cms/adr/0008-api-auth-consolidation.md`、`docs/novel-cms/adr/0009-drop-api-permission-codes.md`

## Problem Statement

这个 microfeed fork 的 API 面同时存在**三条鉴权路径**与**三套权限码**，来源混杂、职责重叠：

- 三条路径：credential-bearer（自研，`Bearer mflc_…`）、signed-call（自研，`X-Access-Key`）、
  legacy bearer（上游，OAuth scope）。
- 三套码：OAuth scope（上游）、`api:*`（自研）、`content:*:*`（自研）。

后果已经**真实发生**：线上 `ext_api_access_log` 里唯一一条记录是 **editor 角色的凭证调
`GET /api/v1/items/` 被 403** —— 因为 API 授权去查 `api:content:read`，而**没有任何角色被授予
`api:*` 码**；该 editor 手里明明有 `content:article:read` 等码。也就是说：**API 对普通角色完全不可用**，
只有超级管理员（`*` 通配）能用。

同时 `api_keys` 与 `ext_api_key_owners` **各 0 行** ⇒ signed-call 这套机制从未被使用，
却仍在维护着 `signed-call.ts`、`ping.ts`、一个管理页面与三个 ajax 端点。

## Solution

1. **删掉从未使用的 signed-call 认证路径**（含其管理界面与端点），API 认证收敛到
   credential-bearer（登录凭证）+ 上游 legacy 分支两种。
2. **把 API 授权从死码 `api:*` 切到已在用的自研 RBAC 码 `content:*:*`**，让 editor / manage /
   readonly 等真实角色能按其既有权限使用 API。
3. **删除 8 个 `api:*` 权限码**，并妥善处理「API」菜单的权限绑定，使菜单可见范围**保持不变**。
4. **page / site / media 这三类上游功能不设自研码**，其鉴权交还上游的 OAuth scope 模型。

## User Stories

1. 作为**编辑（editor）**，我想用我创建的登录凭证调用 `GET /api/v1/items/` 并成功拿到内容，
   这样我不必为了用 API 而去申请超级管理员权限。
2. 作为**编辑**，我想在我没有"删除章节"权限时，调 `DELETE /api/v1/items/{id}/` 被拒绝（403），
   这样权限边界在 API 上和在后台里是一致的。
3. 作为**维护（manage）**，我想用我的凭证读写内容 API，权限按我角色的既有授予生效。
4. 作为**超级管理员**，我想 API 与后台的权限判定使用**同一套权限码**，这样我维护角色时只面对一套语言。
5. 作为**超级管理员**，我想在权限树里**看不到** `api:*` 这类死码，这样角色编辑界面不出现无人能授予的项。
6. 作为**超级管理员**，我想「API」菜单的可见范围**和现在完全一样**，这样这次收敛不带来任何意外的界面变化。
7. 作为**超级管理员**，我想删除「API 凭证」页面后，后台其余页面与「API」分区其他页面**照常工作**。
8. 作为**运维/开发者**，我想 `X-Access-Key` 请求在被删除后明确不可用（而不是静默降级到别的路径），
   这样不会出现"以为还支持签名调用"的误解。
9. 作为**运维**，我想 `/api/ping` 随 signed-call 一起下线，不留下一个依赖已删模块的孤儿端点。
10. 作为**运维**，我想上游的 legacy bearer 路径（`Bearer <非 mflc>` / `x-microfeedapi-key`）
    **行为完全不变**，这样已存在的上游集成不受影响。
11. 作为**运维**，我想 page / site-files / media 三类端点在自研路径下**不再要求自研权限码**，
    这样我不会误以为它们受自研 RBAC 管理。
12. 作为**未来的维护者**，我想在 ADR 里读到"每次合并上游都要检查新增 page/site/media 端点是否被
    `DOMAIN_RULES` 覆盖"这条规程，这样上游演进不会静默绕过授权。
13. 作为**未来的维护者**，我想 `DomainRule` 支持按 HTTP 方法区分 create/update/delete，
    这样"新建/编辑/删除"三种权限能各自生效，而不是一写全通。
14. 作为**未来的维护者**，我想 `PERMISSION_CODES`（共享常量）与 `rbac/seed.ts` 保持一致，
    这样 `admin-endpoint-guards.test.ts` 的相等性约束继续成立。
15. 作为**登录用户**，我想"账号"与"凭证"两条登录线都照常工作，这样这次改动不影响后台登录。
16. 作为**开发者**，我想删除后不残留对已删模块的 import / 测试引用，这样 `typecheck` 与测试全绿。
17. 作为**开发者**，我想这次改动对上游的**分叉净减少**（`AdminApiNavigation.ts` 归零），
    这样将来合并上游更省力。
18. 作为**超级管理员**，我想 `system:api:manage` 继续作为「API」分区的守卫码，这样 API 管理的权限语义不变。
19. 作为**审计者**，我想 `ext_api_access_log` 的写入（`ApiAttribution` / `writeApiAccessLog`）
    在删除 signed-call 后**仍然工作**，这样凭证调用的允许与拒绝都继续留痕。
20. 作为**超级管理员**，我想这次收敛后**现有已实现的功能一个都不少**，这样我可以安全上线。

## Implementation Decisions

- **认证收敛**：删除 signed-call 全套（模块、中间件分支、`/api/ping`、管理页面、ajax 端点、
  客户端签名工具、`api-keys.ts` 的用户自有凭证分支）。**保留** credential-bearer、legacy 分支、
  「凭证登录后台」线、`ApiAttribution` / `writeApiAccessLog` / `rbac/replay.ts`（后者被 RBAC guard 共用）。
- **授权码来源**：API 授权判定改用自研 RBAC 码。内容域映射：
  `items` / `feed` / `search` → `content:article:*`；`channels` → `content:channel:manage`。
- **`DomainRule` 方法感知**：规则需能按方法返回不同码
  （`GET`/`HEAD` → read，`POST` → create，`PUT`/`PATCH` → update，`DELETE` → delete），
  否则 `content:article:delete` 无法与 create/update 区分，editor 会越权。
- **fallback 语义**：`requiredApiPermission` 对未匹配路径返回 `null`，调用方将 `null` 解释为
  "不要求自研码"（身份有效即可），而**不再** fallback 到 `api:content:read`。
- **page / site / media**：从 `DOMAIN_RULES` 移除，不设自研码，鉴权交还上游 OAuth scope 模型。
- **码清理**：删除 8 个 `api:*` 码（`ext_permissions` 行、`rbac/seed.ts`、`PERMISSION_CODES`）。
  **零新建码**。
- **菜单绑定**：删除 `ext_menu_permissions` 中 `menu_code='api'` 的 8 行 `api:*` 绑定，
  **保留** `system:api:manage` 那一行 —— 因无任何角色持有 `system:*`，可见范围不变。
- **迁移**：新增迁移执行上述数据删除（`ext_permissions` + `ext_menu_permissions`）。
- **上游约束**：只删/改**我们自己的增量**，不动上游原有代码；唯一会触碰的上游文件是
  `Constants.ts`（仅增删常量行）与 `AdminApiNavigation.ts`（移除我们加的 `credentials` 项）。
- **规程新增**：合并上游时须检查新增 page/site/media 端点是否被 `DOMAIN_RULES` 覆盖。

## Testing Decisions

- **好的测试**：只断言**外部可观察行为**（HTTP 状态码、返回体形状、菜单是否渲染），
  不断言内部函数调用或私有结构。
- **要测的模块**：
  1. `api-permissions` 的授权判定 —— 以"路径 + 方法 + 身份权限集 → 是否放行"为断言面，
     覆盖：editor 读 items 放行、editor 删 items 拒绝、无匹配路径放行（不要求码）。
  2. 中间件鉴权分派 —— `X-Access-Key` 不再被识别（应落到 legacy 或 401）；
     `Bearer mflc_…` 仍走 credential-bearer。
  3. 菜单可见性 —— 「API」菜单在只有 `system:api:manage` 绑定下的可见范围与改动前一致。
- **先例（prior art）**：仓库已有 `tests/unit/admin-endpoint-guards.test.ts`（约束
  `PERMISSION_CODES` 与 `rbac/seed.ts` 相等）与 worker 侧 `auth` / `rbac` / `login-credential`
  测试。新测试沿用同一套 worker 测试基建（先铸会话 / 凭证，再打端点）。
- **门禁**：`yarn typecheck`（= `yarn types && astro check && tsc --noEmit`）与 `yarn test`。

## Out of Scope

- 内容读 API（标签 → 书 → 卷章 → 正文）本身 —— 见 ADR-0006，**仍挂起**，本次不实现。
- 上游 legacy bearer 路径的改造（保留原样）。
- 「凭证登录后台」这条线的改造（保留）。
- 是否重命名 `chapters` / `items` 等术语（ADR-0006 的待决项）。
- 任何新增权限码。
- OpenAPI 文档的内容变更（本次不改端点契约，只改授权码；若触及文档则同步翻译表）。

## Further Notes

- 本 spec 的**唯一功能收益**是修好"API 对普通角色 403"这个真实故障；其余是**减法**
  （删从未使用的机制、删死码），目标是让鉴权面变得可理解、可维护。
- 这次收敛**对上游是净友好**的：分叉减少，且没有新增对上游文件的改动。
- 实施顺序很关键：**先删 signed-call**（使 `requiredApiPermission` 只剩自研调用方），
  **再改 fallback 语义**（从而只动自研文件），**最后删码**（此时已无代码引用它们）。
