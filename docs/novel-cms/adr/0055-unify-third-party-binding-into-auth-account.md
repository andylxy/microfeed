# ADR-0055: 第三方身份绑定统一入 auth_account

- 状态：Accepted（实施于 2026-11-02：迁移 `0165_schema_unify_third_party_identity` + 绑定/再认证/清理/快照四条链路换底座；工单见 `.scratch/unify-third-party-binding/tickets.md`）
- 日期：2026-11-02
- 关联：ADR-0050（登录方式配置，其修订节记录 QQ 于 2026-10-30 接通）、ADR-0054（账号写操作自研、封禁 = 吊销凭据）、`CONTEXT.md`（登录方式）

## 背景

QQ 第三方登录自 0155 起把「openid → 账号」的绑定关系存在自建的 `ext_user_oauth`（主键 `(provider, openid)`），而 better-auth 自己的账号身份表 `auth_account` 本就是「账号 × 提供方」的多行模型（`providerId` 区分提供方，credential 行存口令哈希）。同一件事（一个账号挂多个身份）有两套表在表达，带来三份维护成本：

- 绑定查询、改绑、解绑各写一套针对 `ext_user_oauth` 的 SQL（4 个源文件、6 处语句）；
- 账号删除清理要在 `USER_OWNED_TABLES` 里同时登记两张表；
- 快照登记（`manage-cli/lib/snapshot.ts`）也要为它单独留位。

同时 `auth_account` 存在一个缺口：它没有 `(providerId, accountId)` 唯一约束，而幂等登录闸门的全部分量押在「同平台同 openid 只绑一个账号」上。

## 决策

1. **`ext_user_oauth` 退役。** QQ 绑定由 `auth_account` 的 `providerId = 'qq'` 行承载：`accountId` 列放 openid（该列语义即「提供方侧账户标识」，credential 行放 userId 是因为提供方是本应用自身），`userId` 列挂账号（FK CASCADE），`password` 与全部 token 列留 NULL，行 `id` 用确定性值 `'acc_qq_' || openid`（回填幂等、可重跑；openid 为 32 位十六进制，无坏字符）。QQ 建号路径现状不写任何 `auth_account` 行（`createQqUser` 只建 `auth_user` + 绑定；凭证行的写者仅安装引导与后台建号），合并后 QQ 用户的唯一 `auth_account` 行即绑定行，与 credential 行（`accountId` = userId）靠 `providerId` 天然隔离。
2. **补 `(providerId, accountId)` 唯一索引**，幂等闸门换底座：迁移先建索引（对存量 credential 行 fail-fast 验重），再从 `ext_user_oauth` 回填，最后删表。回填语句必须**可重放**：旧快照恢复时该表先被 `DROP TABLE IF EXISTS` 静默跳过、随后按旧 schema 重建并重放迁移，重放即完成回填与删表（`manage-cli/lib/snapshot.ts` 的恢复自愈路径），这是旧快照在新库上仍可恢复的前提。
3. **登录流程保持自持，不启用 `socialProviders`。** `appThirdPartyLogin` 的腾讯校验链路（`verifyQqToken` → `oauth2.0/me` + `get_user_info`）不动，只换存储落点；不触碰 `src/server/auth/better-auth.ts`。绑定写入保留 `INSERT OR IGNORE`：并发首登同 openid 时会撞确定性行 id 主键与唯一索引，裸 INSERT 是未捕获 500；忽略后由 `findUserIdByOpenid` 幂等兜底。绑定行 INSERT 语句落 `account-insert.ts` 新导出（复用 `AUTH_ACCOUNT_COLUMNS_SQL`，不在 `app-third-party.ts` 内联第二份列清单）。
4. **token 列留 NULL。** 当前没有任何跨登录期消费 token 的调用方（登录时同步资料已由当次 accessToken 完成，见 ADR-0050 修订节）；将来若需服务端静默续期，列现成，不必再设计。

## 范围之外

- 不启用 better-auth `socialProviders`，不改 `better-auth.ts`。
- 封禁清理列表（ADR-0054 决策 4）不动：它按表名精确列举且不含 `auth_account`，绑定行在封禁期间保留、解封后原 openid 可登回——该语义迁移前后一致。
- 短信 / 微信登录预留不动；`signup_source` 语义不动（0157 注释里「不能按绑定表是否存在派生」的理由在合并后同样成立）。
- 历史迁移 0155 / 0157 只追加不改。

## 后果

- 身份模型少一张表：绑定查询、改绑、解绑全部落在 `auth_account` 一张表上，按 `providerId` 分流。
- 账号删除清理少一项登记：`USER_OWNED_TABLES` 移除 `ext_user_oauth` 行（`auth_account` 本就在列）。
- 快照登记少一项：`manage-cli/lib/snapshot.ts` 的 durable 表清单移除 `ext_user_oauth`。
- 兼容点：`app-account-binding.ts` 的绑定列表接口原从 `ext_user_oauth` 取 `created_at_ms`（毫秒），合并后源头只有 `auth_account.createdAt`（DATE 字符串）；响应字段口径需在实施时核对 App 端消费情况后定夺（换算毫秒或去掉字段）。
- 已知量化面：源码 4 文件 6 处 SQL、`tests/worker` 3 文件、快照登记 1 处、删号清理登记 1 处、迁移新增 1 支、文档另有两处提及（`docs/zh/13-request-pipeline.md` 的表清单行、`docs/novel-cms/qq-login-deployment-checklist.md` 的 upsert 流程描述）。
- **部署不可回滚。** 0165 应用后，回滚到旧版 Worker 的代码会查询已删除的表，QQ 登录 / 绑定端点全部 500（`no such table`）。迁移先于 deploy 执行是 `deploySupport` 的既有约定；本迁移使「只回滚代码、保留迁移」不再可行，回滚必须重建表并回灌。
- 迁移文件照 0162 惯例：标识符双引号、DATE 列回填用 `CURRENT_TIMESTAMP`、文件头含背景注释块与 `-- rollback:` 段。
- 实施时顺带修正 `account-insert.ts` 头部「QQ 建号」走凭证行的过时注释——实际 `createQqUser` 不写 `auth_account` 行，该注释与代码不符。

## 被否决的替代方案

- **保留 `ext_user_oauth` 不合并。** 两套抽象的维护成本（两套 SQL、两处登记）持续存在，而合并的全部风险集中在一次可 fail-fast 的迁移里。
- **启用 better-auth `socialProviders` 让插件接管。** 需要接受服务端持久化 QQ token、触碰红线文件 `better-auth.ts`，且 QQ 互联的校验细节（多 AppID 允许清单、fail-closed）要在插件模型里重新表达——为省一张表付出的代价过大。
- **合并的同时落库 token。** 没有消费者，落了即死数据；触发条件（产品要求跨登录期主动刷新资料）出现时再加不迟。
