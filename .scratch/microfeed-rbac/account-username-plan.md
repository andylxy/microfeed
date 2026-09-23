# 账号标识：邮箱或用户名（方案）

需求（用户 2026-09-22 19:59 确认）：
- **账号和密码管理**与**创建用户**都适用同一套：账号可填邮箱、也可填用户名，**两种都能登录**。
- 密码策略：**统一 ≥6**，且"有大小写、或有数字"（已实现，见下）。

## 0. 已经做完的（无需再动）

- 密码最小长度 `MIN_ADMIN_PASSWORD_LENGTH` 由 9 改为 **6**，一处常量派生到全部落点：
  `better-auth.ts` 的 `minPasswordLength`、`ajax/account/password.ts`、`createAdminRbacUser`、
  `UsersApp`/`AccountSettingsApp`/`AdminPasswordSetupApp` 的 `minLength`、CLI。
- 组合规则不变：`hasMixedCase(value) || /\d/`（在 `src/shared/AdminCredentials.ts`）。
- 文案用 `{{min}}` 插值，中英各一条，无需改字。

## 1. 这一版要做的（账号＝邮箱或用户名）

### 1.1 认证层
- 引入 better-auth **官方 `username` 插件**（核心自带 `better-auth/dist/plugins/username/`，
  **无需新增依赖**），在 `createMicrofeedAuth` 的 `plugins` 中注册。
  ⚠️ **这是此前的红线**（不改 `better-auth.ts`），需你明确授权后才能动。
- 该插件提供 `/sign-in/username` 端点与 `authClient.signIn.username`；
  **实现前我会先在本机安装包里核对**：该端点是否也接受邮箱、用户名比较是否忽略大小写、
  以及 `usernameValidator`/长度选项的确切名字（不猜）。

### 1.2 数据层
- 新增迁移 `0039_auth_user_username.sql`：给 `auth_user` 加 `username TEXT` +
  `displayUsername TEXT`，并建 **唯一索引**（SQLite 的 UNIQUE 索引允许多行 NULL，既有账号不受影响）。
  ⚠️ **同样触及此前的红线**（不动 `auth_user` 结构），需授权。
- 需同步 `manage-cli/lib/snapshot.ts` 的表分类检查（若它按列/表校验）并复跑 `snapshot.test.ts`。

### 1.3 登录页
- 字段标签「邮箱」→「账号」；`type="email"` → `type="text"`（去掉邮箱格式约束）。
- 提交时按**是否含 `@`** 分派：含 `@` → `signIn.email`；不含 → `signIn.username`。
  （若本机核对发现 `/sign-in/username` 同时接受邮箱，则统一走一条，代码更少。）
- 三段式布局与"高度恒定"的机制不动（中间字段区仍同格叠放）。

### 1.4 创建用户（管理员）
两种形态，**待你选**：

- **形态 A（一个字段，自动判别，推荐）**：表单只保留一个「账号」输入。
  含 `@` → 当邮箱；不含 `@` → 当用户名，并由系统生成**占位邮箱**（如 `账号@users.microfeed.local`）
  以满足 better-auth「email 必填」的约束。UI 明示"该账号无邮箱，密码重置邮件无效"。
- **形态 B（两个字段，显式）**：「邮箱」（可选）+「用户名」（可选），二者至少填一个；
  只填用户名时同样生成占位邮箱。

### 1.5 规则与校验
- 用户名：唯一（忽略大小写）、长度与字符集待定（建议 `[a-z0-9](?:[a-z0-9._-]{1,30})`，3–32 位）。
- 若同时给了邮箱与用户名，两者都要唯一；与既有邮箱/用户名冲突时返回明确错误。
- 校验函数放 `src/shared/AdminCredentials.ts`（现有 `validateAdminEmail` 旁边），服务端与表单共用。

### 1.6 测试与门禁
- worker：用户名建号 → 用用户名登录 → 会话 cookie 落地 → RBAC 解析到该账号；
  用户名重复被拒；邮箱登录仍可用；`@` 分派正确；占位邮箱账号的登录与拒绝路径。
- unit：用户名校验函数、`@` 分派函数。
- 四门禁（typecheck / lint / i18n / unit + worker）全绿 → 部署 → 生产直查 `auth_user` 新列 + `username` 唯一索引。

## 2. 需要你拍板的四点

| # | 问题 | 建议默认 |
| --- | --- | --- |
| 1 | 授权动 `better-auth.ts` 与 `auth_user`（加两列 + 唯一索引）？ | 是（否则此功能无法实现） |
| 2 | 建号表单用形态 A（一个「账号」字段自动判别）还是形态 B（邮箱/用户名两个字段）？ | A |
| 3 | 只给用户名时生成的占位邮箱用哪个域名？ | `@users.microfeed.local` |
| 4 | 用户名规则（长度/字符集）与"既有账号是否也补用户名"？ | 3–32 位小写字母数字与 `._-`；既有账号不动，仅新建可设 |

## 3. 已知取舍（先说清）

- 无邮箱账号**收不到密码重置/通知邮件**（占位邮箱不可达）——这正是你选"两个都能用"而非"只用户名"的代价所在。
- 引入插件后 `auth_user` 多两列；升级/回滚时这两列需保留（快照与迁移都要覆盖）。
- 通行密钥（passkey）登录入口已在登录页下线，但账户页的通行密钥管理仍在，与本次改动无耦合。

## 4. 执行结果（2026-09-22，按建议默认值执行）

用户回「按方案执行」，四点默认值照准：授权动 `better-auth.ts` 与 `auth_user`、建号用**形态 A**、
占位邮箱域名 `users.microfeed.local`、仅新建账号可设用户名。

已实现：
- 迁移 `0039_auth_user_username.sql`：`auth_user` 加 `username` + `displayUsername` + `username` 唯一索引。
- `better-auth.ts` 注册官方 `username` 插件，边界取 `shared/AdminCredentials` 的常量。
- `auth-client.ts` 加 `usernameClient()`；登录页字段改「账号」（`type="text"`、`autoComplete="username"`），
  提交时按**是否含 `@`** 分派 `signIn.email` / `signIn.username`。
- 建号端点：账号自动判别；只填用户名时生成占位邮箱，并做重名预检；
  `createUser({data: {username, displayUsername}})` 由**插件的钩子**做权威校验与规范化。
- i18n：新增 `login.account`/`accountPlaceholder`、`rbac.accountIdentifier`/`accountIdentifierHint`、
  `errors.rbac.{invalidEmail,invalidUsername,usernameTaken}`，并把 `rbac.passwordHint` 的硬编码
  "8 characters" 改成 `{{min}}` 插值（这是密码策略改到 6 时漏掉的过期文案）。
- 测试：`tests/worker/username-login.test.ts` 5 例（落库形态/用户名登录忽略大小写/重名 409/邮箱账号不受影响/
  非法输入与弱密码拒绝）；`tests/unit/shared/AdminCredentials.test.ts` 加 3 例（分类、用户名规则、占位邮箱本身合法）。

**两处与原方案的偏离（有意）**：
1. **用户名字符集用插件默认值** `/^[a-zA-Z0-9_.]+$/`（不含连字符），而不是方案里写的 `._-`——
   自带校验器与插件一致，避免"表单放行、服务端拒绝"的错位；长度仍按 3–32，常量在 `AdminCredentials.ts`。
2. **不需要"先建号再补用户名"两步**：`createUser` 的 `data` 字段会把额外字段透传进 user 记录，
   而插件的 `user.create.before` 钩子在 `/admin/create-user` 路径上会执行校验与规范化 ⇒ 一次调用完成。

**实现中查实的两件事（否则会写错）**：
- `auth.api.createUser` 在**带 headers 且无会话**时抛 UNAUTHORIZED（`getAuthoritativeSessionFromCtx`）；
  生产里调用者本是登录态管理员，所以 worker 测试必须先铸一个真会话（复用 `createLoginSessionCookies`）。
- 插件 schema 只加 `username` + `displayUsername` 两列，落库时 `username` 小写、`displayUsername` 保留原始大小写。
