# ADR-0009: 删除 `api:*` 权限码，API 授权并入自研 RBAC 码

- 状态：Accepted（全部决定已由用户确认）
- 日期：2026-09-24
- 决策人：用户

## 背景

`api:*` 是**自研**的 8 个权限码（fork 点判据：`api-permissions.ts` 与
`migrations/0035_ext_api_permissions_seed.sql` 均不在 `main` 上），被**两处**使用：

1. `api-permissions.ts` 的 `DOMAIN_RULES` —— API 端点授权
2. `ext_menu_permissions` —— 「API」菜单行绑定了**全部 8 个码**

而**没有任何角色被授予 `api:*`**（`super_admin` 仅 `*` 通配）⇒ `api:*` 是**死码**，
且已造成真实故障：editor 角色的凭证调 `GET /api/v1/items/` 被判 `api:content:read` → **403**，
而该 editor 实际持有 `content:article:read` 等码（详见 ADR-0008）。

**关键区分（本 ADR 的立足点）**：

| 层 | 归属 |
|---|---|
| **功能 / 端点**：Pages、Site Files、Media、Items | **上游**（`main` 上有 `src/server/{pages,site-files,media,items}` 与对应 `api/v1/*` 端点） |
| **权限码体系**：`api:*` 与 `content:*:*` **全部** | **自研**（上游**没有** `src/server/rbac/`、没有 `0035/0040/0052` 迁移） |

⇒ 上游的 API 授权是 **OAuth scope 模型**（`content:read` / `content:write` 两档），**没有权限码**。

## 决策

1. **内容域并入**：`api:content:read/write` → 自研 `content:*:*` 码。
   `DOMAIN_RULES` 中 `items` / `feed` / `search` / `channels` 的映射改写（见下表）。
2. **page / site / media 一律不设自研码**：依指示，`api:page:*`、`api:site:*`、`api:media:*` **全部删除**，
   这三类端点**从 `DOMAIN_RULES` 移除**，其鉴权交还**上游的 OAuth scope 模型**（read / write 两档）。
   理由：它们是**上游自带的功能**，我们不再为上游功能挂自研的门。
3. **删除全部 8 个 `api:*` 码**：`ext_permissions` 行、`src/server/rbac/seed.ts`、
   `src/shared/Constants.ts` 的 `PERMISSION_CODES`。**零新建码。**
4. **`requiredApiPermission` 的 fallback 语义改写**：不再 fallback 到 `api:content:read`；
   未匹配到规则的路径**不要求自研码**（身份有效即可）。这是"不为其添加鉴权"的落地方式。
5. **菜单绑定：删 8 行 `api:*`，保留已有的 `system:api:manage` 绑定**。
   ⭐ 实测发现「API」菜单**本来就绑了 `system:api:manage`**（除 8 个 `api:*` 之外），
   且**没有任何角色持有 `system:*` 码** ⇒ 删掉 8 行后菜单仍由 `system:api:manage` 把关，
   **可见范围完全不变**（仍只有 `super_admin`，因其 `*` 通配），且**不留死引用**、语义正确
   （`system:api:manage` 正是 `ajax/api/keys` 已在用的守卫码）。
6. **不能影响现有功能**（见「现有功能不受影响」清单）。
7. **不能影响上游**（见「上游影响」）。

### `DOMAIN_RULES` 改写表

| 路径前缀 | 现映射（`api:*`） | 新映射（自研 RBAC 码） |
|---|---|---|
| `items` | `api:content:read/write` | 读 `content:article:read`；写按方法细分（见下） |
| `feed` | `api:content:read/write` | 读 `content:article:read` |
| `search` | `api:content:read/write` | 读 `content:article:read` |
| `channels` | `api:content:read/write` | `content:channel:manage` |
| `pages` | `api:page:read/write` | **移除**（交还上游 scope 模型） |
| `site-files` | `api:site:read/write` | **移除**（交还上游 scope 模型） |
| `media_files` | `api:media:read/write` | **移除**（交还上游 scope 模型） |
| 未匹配（fallback） | `api:content:read/write` | **不要求自研码** |

**写操作的粒度问题**：现有 `DomainRule` 只有 `{prefix, read, write}`，按 `GET/HEAD` 判读、
其余一律判写 ⇒ 无法区分"新建章节 / 编辑章节 / 删除章节"。
建议把 `DomainRule` 扩展为**方法感知**（`POST→create`、`PUT/PATCH→update`、`DELETE→delete`），
否则 `content:article:create` / `update` / `delete` 三个码无法各自生效
（editor 持有 create/update 但**不持有 delete**，粗粒度会让它拿到删除权——这是必须修的）。
`api-permissions.ts` 是**自研文件**，扩展它不影响上游。

## 上游影响：**零新增分叉**

- **ADR-0008 的删除是前置条件**：删掉 signed-call 后，`requiredApiPermission` 的**唯一**调用方
  只剩自研的 `credential-bearer.ts` ⇒ 改写 fallback 语义**只动自研文件**
  （`access.ts` 里那段 `?? "api:content:read"` 随 `decideSignedApiRequest` 一起删除）。
- **改的都是自研文件**：`api-permissions.ts`、`src/server/rbac/seed.ts`、新增迁移。
- **唯一会碰到的上游文件**是 `src/shared/Constants.ts`（`PERMISSION_CODES` 增删）——
  **仅插入/删除常量行，不动上游原有代码**。
- **菜单绑定**：`ext_menu_permissions` 中「API」菜单的 8 行绑定需处理（见下）。

> ⚠️ **合并检查项（新增规程）**：我们给**上游功能**挂了**自研的门**。
> **每次合并上游，都必须检查上游新增的 page / site / media 端点是否被 `DOMAIN_RULES` 覆盖**；
> 未覆盖的会走 fallback（= 不要求自研码），需确认这是否符合预期。

## 现有功能不受影响

| 功能 | 影响 |
|---|---|
| 后台 UI（菜单 / 页面 / ajax guard） | **不受影响** —— 后台走 `content:*:*` 码，不经过 `DOMAIN_RULES` |
| 内容 API（`/api/v1/items/` 等） | **变好** —— 改码后 editor / manage 等真实角色可用（当前 403） |
| legacy bearer 路径（上游） | **不受影响** —— scope 判定不变 |
| 登录（账号线 / 凭证线） | **不受影响** |
| `content:*:*` 码与角色授予数据 | **不变** |
| 「API」菜单可见范围 | **不变** —— 删 8 行 `api:*` 绑定后仍由 `system:api:manage` 把关，仍只有 `super_admin` 可见 |

## 已定（原「待定」项，用户 2026-09-24 拍板）

- **D1 `media_files`** → **同 page / site 处理**：移除规则、不要求自研码。理由：媒体也是上游功能
  （`src/server/media` 在 fork 点存在），用户指示"类同 page/site 这些上游功能，不需要处理"。
  ⇒ **本次零新建权限码。**
- **D2 「API」菜单绑定** → **删 8 行 `api:*` 绑定，保留已有的 `system:api:manage` 绑定**。
  实测：菜单本来就绑了 `system:api:manage`，且无任何角色持有 `system:*` ⇒ 可见范围**完全不变**，
  且无死引用。这比"保留死绑定"更干净，比"重挂到 `content:*:*`"更安全（后者会改变可见范围）。

## 影响 / 实施项

1. 新增迁移：删 `ext_permissions` 的 8 个 `api:*` 行 + 删 `ext_menu_permissions` 里 `menu_code='api'`
   的 8 行 `api:*` 绑定（**保留** `system:api:manage` 那一行）。
2. 改 `src/server/api/api-permissions.ts`：`DOMAIN_RULES` 改写 + `DomainRule` 方法感知扩展 +
   fallback 语义改写。
3. 改 `src/server/api/credential-bearer.ts`：移除 `?? "api:content:read"` fallback。
4. 改 `src/server/rbac/seed.ts` + `src/shared/Constants.ts`（`PERMISSION_CODES`）：删 8 个 `api:*`。
5. ⚠️ `PERMISSION_CODES` 与 `src/server/rbac/seed.ts` 由
   `tests/unit/admin-endpoint-guards.test.ts` **强制相等**，必须同步改。
6. 门禁：`yarn typecheck`（含 `astro check`）+ `yarn test`。
