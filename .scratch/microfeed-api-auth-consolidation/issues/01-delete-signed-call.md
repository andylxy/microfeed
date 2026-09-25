# 01: 删除 signed-call 认证路径（ADR-0008）

**What to build:** API 不再接受 `X-Access-Key` 签名调用。删除整套 signed-call 机制及其管理界面，
使 API 认证收敛为 credential-bearer（登录凭证）+ 上游 legacy 分支两种。删除后：后台「API」分区其余页面
照常工作、「登录凭证」面板照常工作、legacy 路径行为不变、审计留痕（`ext_api_access_log`）继续写入。

**Blocked by:** None (can start immediately)

**Status:** done (2026-09-24) — typecheck 0 errors · tests 981+274 green · `AdminApiNavigation.ts` 与 fork 点一致 · 无残留引用

## 删除清单

- [x] `src/server/api/signed-call.ts`（`verifySignedCall` / `ApiIdentity` / `VerifySignedCallResult`）
- [x] `src/server/api/ping.ts` + `src/middleware.ts` 的 `/api/ping` 分支与 `handleApiPing` import
- [x] `src/server/api/access.ts` 的 `decideSignedApiRequest` / `SignedApiDecision` 及其专属 import
      （`verifySignedCall`）；**保留** `ApiAttribution` / `writeApiAccessLog` / `apiPathDetails` /
      `integrationSuffix`（credential-bearer 与上游都在用）
- [x] `src/middleware.ts` 的 `else if (request.headers.get("x-access-key"))` 整块分支
- [x] `src/components/admin/api/ApiCredentialsApp.tsx`
- [x] `src/pages/[adminPath]/api/credentials/`（整目录）
- [x] `src/pages/[adminPath]/ajax/api/credentials/`（整目录，3 个端点）
- [x] `src/shared/api-signing.ts`
- [x] `src/shared/AdminApiNavigation.ts` 的 `credentials` 项（**上游文件**：仅删我们加的那 6 行，
      删后该文件应与 fork 点 `main` 完全一致）
- [x] `src/shared/StringUtils.ts` 的 `ajaxApiCredentials` / `ajaxApiCredential` / `ajaxRotateApiCredential`
- [x] `src/shared/Api.ts` 的 `MAX_API_CREDENTIALS_PER_USER`（**上游文件**：仅删我们加的部分）；
      并更新 `API_KEY_SCOPES` 的文档注释——它现在写着"Unifying the two is an open decision"，
      而该决定已由 ADR-0009 落定，注释需改为指向 ADR-0009
- [x] `src/server/api/api-keys.ts` 的 `ownerUserId` 分支与用户自有凭证相关函数
      （`listApiKeysForUser` / `countApiKeysForUser` 等，确认删除后无引用）
- [x] `tests/worker/api-credentials.test.ts` 中 **signed-call 专属**的测试
      （`crypto helpers` 中仅服务签名的用例、`verifySignedCall`、`decideSignedApiRequest`）
- [x] `src/server/api/api-permissions.ts` 与 `src/server/rbac/seed.ts` 中提到 signed-call 的注释（改为现状描述）

## 必须保留（勿误删，否则波及 RBAC / bearer）

- [x] `src/server/rbac/replay.ts` + `ext_replay_nonces`（**`rbac/guard.ts` 共用**）
- [x] `ApiAttribution` / `writeApiAccessLog` / `apiPathDetails` / `integrationSuffix`
- [x] `src/shared/crypto.ts`（`login-credentials.ts` / `webhooks/*` / `api-keys.ts` 共用）
- [x] `ext_login_credentials` 整套与「凭证登录后台」线

## Acceptance criteria

- [x] `yarn typecheck` 通过（含 `astro check`，覆盖测试文件）
- [x] `yarn test` 通过
- [x] `tests/worker/api-credentials.test.ts` 的 **`requiredApiPermission mapping` 用例仍存在并通过**
      （该函数未删除，测试随票据 02 更新；本票据只需保留，不得整文件删除）
- [x] 全局搜索 `X-Access-Key` / `x-access-key` / `verifySignedCall` / `decideSignedApiRequest` /
      `api-signing` / `ApiCredentialsApp` 均无残留引用
- [x] `src/shared/AdminApiNavigation.ts` 与 fork 点 `main` 逐字节一致（`git diff main -- <file>` 为空）
- [x] credential-bearer 路径与 legacy 路径的行为未变（现有 worker 测试覆盖）
