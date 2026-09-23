# 登录凭证（login credential）审查问题 · 修复方案

分支：`feat/login-credential`（全部改动仍未提交）
基准：`HEAD` = `65f2277`，本方案针对 2026-09-22 那次 code-review 的两个轴报告。

## 0. 前提

- 生产已跑本次审查所针对的版本：`.microfeed/deploy3.log`（14:05，`Deployed and verified`），
  晚于相关源码的最后修改时间（12:56–13:07）。**修复完成后必须重新部署一次**。
- 工具已裁决且无输出错误：`yarn typecheck`（0 errors）、`yarn i18n:check`（1991/1991）、
  `yarn lint`（eslint，无输出）、`yarn vitest run`（954 passed）、worker 配置（249 passed）。
- 未跑的仓库检查：`yarn lint:openapi`（已为取证补跑，通过）、`yarn build`、`yarn docs:check`、
  `yarn check` 整体（末尾含 `wrangler deploy --dry-run`，需 Cloudflare 授权）。

## 1. 批次 A：必修项（无设计分歧）

### A1 公共 API 的认证说明缺登录令牌
- 文件 `src/shared/OpenApiDocument.ts`
- 第 94–98 行 `info.description`：`"Send an API key using Bearer authentication."`
  → 补一句，说明同一个 `Bearer` 位置也接受登录令牌（`mflc_…`）。
- 第 597–599 行 `components.securitySchemes.bearerAuth.description`：
  现为 `"A named mf_ integration credential sent using Bearer authentication. …"`
  → 改为同时接受 `mf_` 集成密钥与 `mflc_` 登录令牌两种凭据，并说明所需权限由操作决定。
- 约束：**只保留 `bearerAuth` 一个 securityScheme**，不新增第二个 `scheme: bearer`。
- JSON/YAML 由运行时从 `OPENAPI_DOCUMENT` 生成，没有需要手改的生成文件。
- 验证：`yarn lint:openapi`；`yarn vitest run tests/unit/openapi.test.ts`。

### A2 列表加载失败被呈现为「暂无登录凭证」
- 文件 `src/components/admin/LoginCredentialsPanel.tsx` 第 56–65 行 `load()`
- 现状：`if (!response.ok) throw new Error("load failed")` 之后 `catch { setCredentials([]) }`，
  403/500/网络错误与「确实没有凭据」渲染成同一句 `loginCredentials.empty`。
- 改法：新增 `const [loadFailed, setLoadFailed] = useState(false);`；
  `catch { setLoadFailed(true); showToast(t("loginCredentials.loadFailed"), "error"); }`；
  渲染改成三态——未加载（`credentials === null`）、加载失败（提示失败，不显示空态）、已加载。
  提示方式与 `UsersApp` 现有的失败提示一致。
- i18n：`src/shared/i18n/en.ts` 第 59–82 行 `loginCredentials` 块、`zh-CN.ts` 对应块各加 `loadFailed`。
- 验证：`yarn i18n:check` + `yarn typecheck`。

### A3 会话创建失败的具体原因被丢弃
- 文件 `src/server/auth/credential-login.ts` 第 88–93 行
- 改法：`catch (error) { console.error("credential-login: session creation failed", error); return localizedError(request, "errors.loginCredential.unavailable", 500); }`
- 说明：仍然返回 500 与同一文案给客户端，只把原因留给日志。

### A4 封禁判定重复三处
- 现状：`src/server/auth/credential-login.ts` 第 79–83 行、
  `src/server/api/credential-bearer.ts` 第 52–58 行、
  `src/server/rbac/resolve.ts` 第 60–67 行各写一遍 `SELECT banned FROM auth_user WHERE id = ?`。
- 改法：在 `src/server/rbac/resolve.ts` 导出
  `export async function isUserBanned(db: D1Database, userId: string): Promise<boolean>`，
  `resolveRbacContext` 内部改用它；另两处改成调用它。
- 验证：worker 测试（`login-credential.test.ts` 内已有 banned 相关断言）。

## 2. 批次 B：需要拍板（三项）

### B1 两条授权路径的审计行为不一致
签名路径在放行与拒绝两种情形下都写 `ext_api_access_log`；无会话 bearer 路径一条都不写，
只有 `ext_login_credentials.last_used_at_ms` 一处变更。三选一：

- **B1-a（推荐）补审计**：新增迁移 `0038_ext_api_access_log_credential.sql`，
  给 `ext_api_access_log` 加 `credential_id TEXT NULL`；
  `ApiAttribution`（`src/server/api/access.ts` 第 166–170 行）把 `apiKeyId` 放宽为 `string | null`、
  增可选 `credentialId`；`writeApiAccessLog` 的 INSERT 多一列；
  `decideLoginCredentialApiRequest` 在 `allow` 与 `forbidden` 两种结果里都带 attribution，
  `middleware.ts` 第 202–208 行那段据此写审计行。
  代价：跨 1 个迁移 + 2 个模块 + middleware。
- **B1-b 不写审计**：把「该路径的痕迹是 `last_used_at_ms`」写进对外文档
  （`OpenApiDocument.ts` 的 `bearerAuth.description`），模块头注释已有同样说明。
- **B1-c 复用 `api_key_id` 列**：零迁移，但列名与内容不符，不推荐。

### B2 无会话 bearer 的覆盖面
- 现状：只在 `/api/*` 分支生效；后台 `/ajax/*` 与后台页面仍只认会话 cookie。
- **B2-a（推荐）保持只覆盖 `/api/*`**：把这一限制写进 `bearerAuth.description`。
  后台是浏览器会话场景，脚本走公开 API，边界清楚，且不改动后台鉴权的组织方式。
- **B2-b 扩展到后台**：在 `middleware.ts` 第 367 行取到 `authSession` 之后，
  当 `!authSession && providedLoginCredential(request)` 时解析用户、写入
  `locals.authUser` 与四个 `rbac*` 字段，并跳过其后的重定向与 401 分支（第 397–424 行）。
  这属于改动既有后台保护的组织方式，超出「只追加调用」的约定，需你确认。

### B3 无会话 bearer 没有限速
登录端点有固定窗口限速（`src/server/auth/login-throttle.ts`，10 次 / 60 秒），bearer 路径没有。
- **B3-a（推荐）加限速**：在 `credential-bearer.ts` 里以 `clientAddress(request)` 为 key
  （复用同一张 `ext_login_credential_attempts`，key 形如 `<ip>:/api/bearer`），
  在令牌比对**之前**判 `loginThrottleAllows`，令牌无效时 `recordLoginFailure`。
  只统计「令牌无效」，不统计「有令牌但权限不足」（后者不是爆破信号）。
- **B3-b 不加**：把「bearer 路径无限速」记录为已知取舍。

## 3. 批次 C：增强项（可选）

### C1 有效期缺少界面入口
`expires_at_ms` 在表、服务端与端点（`rbac-handlers.ts` 第 903–906 行）都已支持，
`LoginCredentialsPanel` 没有输入项，新建的令牌一律不过期。
- 改法：面板加一个有效期选择（30 天 / 90 天 / 永不过期），POST 时带上 `expiresAtMs`；
  服务端不动。补 i18n 键（标签 + 三个选项）。
- 这一项不涉及服务端改动，成本最低、可见收益最直接。

### C2 middleware 接线没有测试
`tests/` 内没有任何一处引用 `middleware.ts`，两个决策本身已是纯函数且有测试
（`decideLoginCredentialApiRequest`、`isAdminCredentialLoginPath`），接线只有两三行。
- 要覆盖需新建 middleware 级测试：直接调 `onRequest`，自行构造 Astro 上下文与 D1 绑定。
- 建议：**本轮不做**，列为单独工单；本轮只把未覆盖的事实写进测试文件的说明。

## 4. 批次 D：门禁与部署

- D1 补跑未跑的仓库检查：`yarn build`、`yarn docs:check`、`yarn lint:openapi`。
  `yarn check` 整体末尾的 `wrangler deploy --dry-run` 需要 Cloudflare 授权，按需单独跑。
- D2 重新部署（生产当前跑的是含缺陷的版本）：
  `CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy --instance ctwh-881019-xyz --yes`，
  日志落 `.microfeed/deploy4.log`，**回读日志**确认 `Deployed and verified`。
- D3 部署后直查远程 D1，核对 `ext_login_credentials` / `ext_login_credential_attempts`
  与（若走 B1-a）`ext_api_access_log.credential_id` 是否存在。

## 5. 不做的事

- **撤回**「跨账户访问缺少用例」：登录令牌本身就是身份，不存在甲令牌冒充乙，
  等价断言「令牌所属账户缺少所需权限时拒绝」已由 `forbidden` 用例覆盖。
- **保留** `createAdminRbacUser` 不再写 `ext_user_security.created_at`
  （迁移 0028 无该列，不改则管理员建号必然 500）。
- **保留** device revoke/restore 的 `unknownDevice` 400→404（与测试期望一致）。
- **保留** 令牌明文入库（按「不隐藏、每次可查看与复制」的要求）。

## 6. 执行顺序

1. 批次 A（A1–A4）→ `yarn typecheck` + `yarn i18n:check`
2. 批次 B 按拍板结果实施（B1、B2、B3）
3. 批次 C1（可选）
4. 批次 D1 补跑门禁 → D2 部署 → D3 生产核对
5. 两个记忆目录各追加一段收尾记录

## 7. 等确认的决策点

| 编号 | 问题 | 默认（未拍板则按此执行） |
| --- | --- | --- |
| B1 | bearer 路径要不要写审计 | B1-a 补审计（新增迁移 0038） |
| B2 | 无会话 bearer 是否覆盖后台 | B2-a 只覆盖 `/api/*`，写进文档 |
| B3 | bearer 路径要不要限速 | B3-a 复用现有阈值与表 |
| C1 | 是否现在做有效期界面入口 | 做 |

## 8. 执行结果（2026-09-22，按上表默认值执行）

批次 A、B（B1-a / B2-a / B3-a）、C1、D 全部完成，工单 #101–#109。

- **A1** 连带改 `src/shared/OpenApiTranslations.ts`（该表以英文原文为键，不改则 `tests/unit/openapi.test.ts` 三例红）。
- **A4** 最终命名 `accountIsBlocked(db, userId)`（不复用 `isUserBanned`）：账号缺失与 `banned` 都算阻塞，
  与三处原有的 `!account || banned === 1` 语义一致，避免账号被删后凭据仍可登录。
- **B1** 迁移 `0038` 因 `api_key_id` 原为 `NOT NULL`，改为**建表重建**（新建 → 复制 → DROP → RENAME → 重建索引）。
- **B3** 只把「令牌无效」记为失败；「有令牌但权限不足」不计入限速。
- 额外修一处审查存疑项：`verifyLoginCredentialToken` 不再刷新 `last_used_at_ms`，改由 `markLoginCredentialUsed`
  在授权通过后写入。
- 门禁：`yarn typecheck` 0 errors / `yarn i18n:check` 1996 / `yarn lint` 0 / `yarn lint:openapi` valid /
  `yarn vitest run` 137 文件 954 passed / worker 配置 20 文件 257 passed / `yarn build` OK / `yarn docs:check` OK。
- 部署：`.microfeed/deploy4.log` → `Deployed and verified https://feed.881019.xyz`。
  生产 D1 核对：`ext_api_access_log` 10 列含 `credential_id`；`ext_login_credentials` 1 行。
- 生产探针：`credential-login` GET → 404（POST-only，属正确）；POST 同源空体 400 / 错令牌 401 / 无 Origin 403。
- **遗留**：带真实令牌的端到端调用（bearer 取 200、审计行落 `credential_id`、header 建会话拿 Set-Cookie）
  在工具侧触发敏感内容审批，未执行——命令与预期结果见交付说明，由用户自行运行。
