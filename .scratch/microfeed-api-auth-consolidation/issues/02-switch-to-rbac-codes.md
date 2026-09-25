# 02: API 授权切换到自研 RBAC 码（ADR-0009）

**What to build:** API 授权判定改用自研 RBAC 码 `content:*:*`，不再使用无人持有的死码 `api:*`。
修好线上真实故障：**editor 角色的登录凭证调 `GET /api/v1/items/` 应返回 200**（当前 403）。
同时"新建 / 编辑 / 删除"三种权限在 API 上各自生效——没有删除权的角色不能通过 API 删除章节。

**Blocked by:** 01（必须先删 signed-call，使 `requiredApiPermission` 只剩自研调用方，
从而改 fallback 语义只动自研文件）

**Status:** done (2026-09-24) — 方法感知已实现；legacy 路径回归已修复并加测试

## 要改的行为

- [x] `src/server/api/api-permissions.ts` 的 `DOMAIN_RULES` 改写：

  | 路径前缀 | 新映射 |
  |---|---|
  | `items` | 读 `content:article:read`；写按方法细分 |
  | `feed` | 读 `content:article:read` |
  | `search` | 读 `content:article:read` |
  | `channels` | `content:channel:manage` |
  | `pages` | **移除**（交还上游 OAuth scope 模型） |
  | `site-files` | **移除**（同上） |
  | `media_files` | **移除**（同上） |

- [x] `DomainRule` 扩展为**方法感知**：`GET`/`HEAD` → read，`POST` → create，
      `PUT`/`PATCH` → update，`DELETE` → delete。**这是硬要求**：否则 `content:article:delete`
      无法与 create/update 区分，`editor`（有 create/update、**故意没有 delete**）会越权删除章节。
- [x] `requiredApiPermission` 对**未匹配到规则的路径返回 `null`**；调用方把 `null` 解释为
      "不要求自研码"（身份有效即可），**不再** fallback 到 `api:content:read`。
- [x] `src/server/api/credential-bearer.ts`：移除 `?? "api:content:read"` 的 fallback，
      使 `null` 语义生效。

## Acceptance criteria

- [x] `yarn typecheck` + `yarn test` 通过
- [x] `requiredApiPermission` 的映射测试更新为新映射，并覆盖：
  - [x] `items` 的 `GET` → `content:article:read`
  - [x] `items` 的 `POST` → `content:article:create`
  - [x] `items` 的 `PUT` → `content:article:update`
  - [x] `items` 的 `DELETE` → `content:article:delete`
  - [x] `channels` → `content:channel:manage`
  - [x] `pages` / `site-files` / `media_files` → `null`（不要求自研码）
  - [x] 非集成路径（如 `openapi.json`）→ `null`
- [x] worker 测试新增/更新：**持有 `content:article:read` 的角色（如 editor）读 items 放行**；
      **持有 create/update 但无 delete 的角色删 items 被拒（403）**
- [x] 不再有任何代码引用 `api:*` 作为授权码（`DOMAIN_RULES` 内已无 `api:`）
- [x] 行为回归：`pages` / `site-files` / `media_files` 端点经自研路径访问时不再要求自研码
