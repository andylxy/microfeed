# 通行密钥（passkey）用处分析 · 能否取消

问题：后台登录页与账户页的「通行密钥」到底做什么用，能不能取消？

结论先说：**技术上可以取消，但不建议现在删**。它现在是这套系统里唯一的抗钓鱼登录手段，
且删它要改 `better-auth.ts`（与既有「不改 createMicrofeedAuth」的约束冲突），并会连带删掉一套
可复用的 step-up（二次确认）机制。若你觉得没用，最小成本的处置是「界面下线、保留实现」。

## 1. 它在什么地方被用到（5 处，按重要性）

| # | 用处 | 位置 | 说明 |
| --- | --- | --- | --- |
| 1 | **无密码登录后台** | `AdminLoginApp.tsx`（第 221–233 行按钮、第 84–101 行 `authClient.signIn.passkey()`） | 密码表单下方的「或使用通行密钥登录」。WebAuthn，凭据绑定站点域名，**抗钓鱼** |
| 2 | **账户页自助管理** | `AccountSettingsApp.tsx`（第 299–315 行区块、第 188–227 行增删改） | 添加 / 重命名 / 删除通行密钥；内置登录关闭时该区块只显示引导文案 |
| 3 | **改通行密钥前的二次确认** | `account-security.ts`（`createPasskeyStepUpCookie` / `validPasskeyStepUp` / `clearPasskeyStepUpCookie`）、`[...all].ts`（第 189–258 行网关）、`ajax/account/passkeys/reauth.ts` | 用当前密码换一个 5 分钟、绑定「账号+动作+凭据」的签名 cookie；没有它，注册/删除通行密钥的请求直接 401/403 |
| 4 | **账户总览里列出通行密钥** | `account-admin.ts`（第 86 行 `FROM "passkey"`、`getAuthenticatorName`） | 账户页右侧概览 |
| 5 | 导航 / 文案 / 文档 | `AdminAccountNavigation.ts`、`account.passkey*` 与 `login.passkey*` 文案、`docs/dashboard/index.md`、`docs/manage/domains-and-access.md` | — |

## 2. 依赖面清单（真要删时的改动范围）

- **服务端**：`better-auth.ts` 第 53–62 行去掉 `passkey({...})` 插件；`account-admin.ts` 去掉通行密钥查询；
  `account-security.ts` 去掉三个 passkey 函数与 `PasskeyStepUpValue`（`signedValue` 等通用件保留，OAuth 连接还在用）；
  `[...all].ts` 去掉 `passkeyStepUpError` 网关与收尾的 cookie 清理；删掉 `ajax/account/passkeys/reauth.ts`。
- **客户端**：`auth-client.ts` 去掉 `passkeyClient()`；`AdminLoginApp.tsx` 去掉入口；
  `AccountSettingsApp.tsx` 去掉区块与确认对话框；`AdminAccountNavigation.ts`/`AdminAccountSidebar.tsx` 去掉导航项。
- **依赖**：`package.json` 的 `@better-auth/passkey`。
- **数据**：`migrations/0008_account_security.sql` 的 `passkey` 表（迁移文件不能删，只能另加一个迁移停用/丢弃），
  `manage-cli/lib/snapshot.ts` 第 37 行的表分类。
- **文案**：`login.passkey*`（4 个）+ `account.passkey*`（约 12 个）+ `errors.account.passkeyConfirmationInvalid`，中英各一份。
- **测试**：`tests/worker/auth.test.ts`（第 350 行「改通行密钥前需密码证明」）、
  `tests/unit/server/account-security.test.ts`（第 61 行 step-up cookie）、
  `tests/unit/components/admin-oauth-apps.test.ts`（fixture 里的 `passkeys: []` 与那句三区块引导断言）。
- **文档**：上面第 5 项的两个文件。

## 3. 取消之后，登录手段还剩什么

| 手段 | 现状 | 抗钓鱼 | 适合 |
| --- | --- | --- | --- |
| 密码（邮箱+密码） | 已启用，≥12 位 | ✗ | 人 |
| **通行密钥** | 已启用，需内置登录 + HTTPS | ✓ | 人（浏览器） |
| 登录凭证 `mflc_`（本轮新增） | 已上线 | ✗（是可复制的 bearer 密钥） | 脚本 / CI |
| Cloudflare Access | 内置登录关闭时启用 | 取决于配置 | 整站前置 |
| OAuth provider | 已启用 | ✗ | 第三方客户端 |

即：**删掉通行密钥后，「人在浏览器里、且不怕钓鱼」这条路就没有了**——只剩密码（可被钓鱼）和
可被复制的 `mflc_` 令牌（一旦泄露即等于登录）。这一点值得你权衡。

## 4. 三种处置路径

- **A. 保留（默认）**：零风险，代价是继续背一个依赖与约 20 条文案。
- **B. 界面下线，保留实现**：登录页不出通行密钥按钮，账户页不出通行密钥区块；
  服务端插件、表、step-up 机制原样不动。**最小成本、随时可回退**，改动落在两个组件 + 少量文案。
  缺点是代码里仍留着一套「界面上到不了」的路径。
- **C. 真删**：按第 2 节清单执行，属一次「功能下线」变更。必须走独立分支 + 工单，
  且**需要你明确授权改 `better-auth.ts`**（此前的红线是不动 `createMicrofeedAuth`）。

## 5. 一个容易被忽略的现状

通行密钥只在**内置登录开启**时才有意义。若某实例以 Cloudflare Access 模式运行，
账户页显示的是「通行密钥需要内置登录」（`account.passkeysRequireBuiltIn`），
也就是说在这些实例上它本来就是死的、白占文案与依赖。

## 6. 来源：是框架自带的，还是后来加的？（2026-09-22 查证）

两层要分开说：

- **better-auth 框架层：不是核心内置。** `better-auth` 核心包自带 29 个插件
  （`node_modules/better-auth/dist/plugins/`：admin、two-factor、organization、email-otp、mcp…），
  **里面没有 passkey**。它是官方维护但**独立发布**的包 `@better-auth/passkey`（同类的还有
  `@better-auth/oauth-provider`），必须显式安装 + 在 `createMicrofeedAuth` 里注册才生效。
- **microfeed 产品层：上游自己加的功能，不是本地后加的。**
  引入它的唯一提交是 `42f7c5f`（2026-08-07，作者 **Wenbin Fang <wenbin@listennotes.com>**，
  即上游 microfeed 维护者，占全部 543 个提交中的 412 个）：
  「Add account settings and per-computer CLI access」，一次改 **80 个文件**（+3115/−848），
  同时带来 `better-auth.ts` 插件注册、`auth-client.ts`、`package.json` + `yarn.lock`、
  迁移 `0008_account_security.sql`（`passkey` 表）、`tests/worker/auth.test.ts`、以及 `docs/` 文档。
  之后没有任何提交改动或移除它。
- 因此**它属于上游功能**：删它等于与上游分叉（参考 `fork` 现状：该提交之后已有 264 个提交，
  其中包含持续跟进的上游改动）。若这个仓库还在跟进上游，删掉会让今后每次合并都要处理这几处冲突；
  「界面下线」虽然也会分叉，但只落在两个组件与少量文案上。
- **上游独立复核（2026-09-22）**：直接取上游 `github.com/microfeed/microfeed` main 分支的
  `src/server/auth/better-auth.ts`，其中确实有 `import {passkey} from "@better-auth/passkey";` 与
  `plugins: [admin(), passkey({origin, rpID, rpName, schema: {passkey: {modelName: "passkey"}}}) , oauthProvider(...)]`
  —— 配置与本仓库逐字一致。结论：**上游功能，不是本地新增**。
- **处置结论（用户 2026-09-22 决定）**：确认是上游功能 → **保留，不处理**（不做界面下线，也不删除）。

## 7. 建议

1. 先不动。等本轮登录凭证的修复与重新部署完成、线上验证通过后，再单独判断。
2. 若只是为了「后台看起来简洁」，选 **B**（界面下线）而不是 C。若只是为了省依赖，收益很低，
   却要拿「今后合并上游反复冲突」来付——这种情况下维持 **A** 反而最省事。
3. 若确实要删，先确认两件事：① 实例是否长期以内置登录模式对外暴露；② 你是否接受
   「只剩密码 + 可复制的登录凭证」这一安全姿态。两者都确认后再开工单。
