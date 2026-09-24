# ADR-0008: API 认证与授权收敛（删签名调用、授权统一到自研 RBAC 码）

- 状态：Accepted
- 日期：2026-09-24
- 决策人：用户

## 背景

microfeed fork 后，API 面出现**三条鉴权路径 × 三套权限码**，来源与作用各不相同：

| 路径 | 请求特征 | 权限模型 | 出处 |
|---|---|---|---|
| credential-bearer | `Authorization: Bearer mflc_…` | 自研 RBAC 码 | **自研** |
| signed-call | `X-Access-Key: …` | 自研 RBAC 码 | **自研** |
| legacy bearer | `Bearer <其他>` / `x-microfeedapi-key` | 上游 OAuth scope `content:read/write` | **上游** |

实测（2026-09-24 远程 D1）：

- `api_keys` **0 行**、`ext_api_key_owners` **0 行** ⇒ signed-call **从未被使用**。
- `ext_login_credentials` **1 行**，且**真实调用过 API**。
- **那条调用是一次真实故障**：editor 角色的凭证调 `GET /api/v1/items/`，判定 `api:content:read`
  → **403**。而 editor 实际持有 `content:article:read` / `content:book:read` /
  `content:category:read` / `content:volume:read` —— **内容 API 需要的码一个不缺**。
- **没有任何角色被授予 `api:*` 码**（`super_admin` 仅 `*` 通配）⇒ `api:*` 是**死码**。

## 决策

1. **删除 signed-call 认证路径**（认证方式 3 → 2）。
2. **授权码统一到自研 RBAC 码**：`api-permissions.ts` 的 `DOMAIN_RULES` 从 `api:*` 改为 `content:*:*`，
   **既有端点一并改** —— 否则上述那条 403 依然存在。

   映射（零新建，全部已存在）：

   | 端点 | 权限码 |
   |---|---|
   | `items` / `feed` / `search`（内容读写） | `content:article:read` / `content:article:create` 等 |
   | `channels` | `content:channel:manage` |
   | `pages` | `content:page:manage` |
   | `site-files` | `content:site_file:manage` |
   | `media_files` | `content:settings:manage`（待细化） |

3. **保留 credential-bearer**（登录凭证）—— 唯一实际在用的 API 认证方式。
4. **保留「凭证登录后台」这条线**（`mflc_` 换 better-auth 会话）。
5. **保留上游 legacy bearer 分支不动**（0 把 key；注释已标 *"left completely untouched"*）。

## 理由（trade-off）

- **删 signed-call 而非保留**：0 使用 = 纯负担；且「登录凭证」已能承担 API 认证。
  备选（保留签名以求更高安全性）被否决：开发阶段，将来若对外开放再引入更划算。
- **授权码选 `content:*:*` 而非 `api:*`**：`api:*` 未授予任何角色（死码），而 `content:*:*`
  已授予 editor / manage / readonly ⇒ **零新建、零补授权**即可让现有角色生效。
  备选（只给新端点映射 `content:*:*`、老端点不动）被否决：那条 403 恰恰发生在**老端点**上。
- **legacy 保留而非删除**：删它要动上游文件结构（分叉大、合并时易被"复活"）；
  它 0 使用，保留成本为零。

## 影响

**删除**（signed-call 专属）：

- `src/server/api/signed-call.ts`
- `src/server/api/ping.ts` + `middleware.ts` 里的 `/api/ping` 分支（整条依赖签名）
- `src/server/api/access.ts` 的 `decideSignedApiRequest`
- `middleware.ts` 的 `x-access-key` 分支
- `src/components/admin/api/ApiCredentialsApp.tsx` + `src/pages/[adminPath]/api/credentials/`
- `src/pages/[adminPath]/ajax/api/credentials/*`（3 个端点）
- `src/shared/api-signing.ts`（确认无其他引用后）
- `src/server/api/api-keys.ts` 的 `ownerUserId` 分支（用户自有凭证创建逻辑）
- `src/shared/AdminApiNavigation.ts` 的 `credentials` 项

**必须保留（被别处共用，误删会波及 RBAC / bearer）**：

- ⚠️ `src/server/rbac/replay.ts` + `ext_replay_nonces` —— **`rbac/guard.ts` 也在用**
  （RBAC 自身的防重放，`requireAppVersion → checkReplay → requirePermission`）。
  无 `X-Nonce`/`X-Timestamp` 时自动 no-op，保留无副作用。
- `resolveUserPermissions` / `RBAC_WILDCARD` —— bearer 路径也用。
- `access.ts` 的 `ApiAttribution` / `writeApiAccessLog` / `apiPathDetails` / `integrationSuffix`
  —— bearer 路径也用（且 `integrationSuffix` 是**上游**的）。
- `src/shared/crypto.ts` —— `login-credentials.ts`、`webhooks/*`、`api-keys.ts` 在用。
- `ext_login_credentials` 整套（登录凭证）。

**废弃但不删表**（减分叉）：`ext_api_key_owners`、`api_keys.secret_hash`。

**改**：`src/server/api/api-permissions.ts` 的 `DOMAIN_RULES` → `content:*:*`。

**门禁**：改动后必跑 `yarn typecheck`（含 `astro check`）+ `yarn test`；
若触及 OpenAPI 文档需同步 `OpenApiTranslations.ts`。
