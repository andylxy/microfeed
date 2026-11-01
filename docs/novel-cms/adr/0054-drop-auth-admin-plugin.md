# ADR-0054: 移除 better-auth admin 插件与 `auth_user.role` 镜像

- 状态：Accepted（本 ADR 撤回 ADR-0052 的决策 2 与「保留的缺陷」段）
- 日期：2026-11-01
- 关联：ADR-0052（权限判定保持自研，本 ADR 撤回其中一条）、ADR-0053（权限快照，判定链路已改）、ADR-0008（API 认证与授权收敛，`mflc_` 凭证）、ADR-0039（按终端归属分区）、`CONTEXT.md`（角色分配 / 角色镜像 / 权限判定）

## 背景

`auth_user.role` 是 `ext_user_roles` 的有损派生镜像：持 `super_admin` 记 `admin`，其余记 `user`。它唯一的消费者是 better-auth 的 admin 插件——该插件挂出 15 条 `/api/auth/admin/*` 端点，每条用自己一套判据（只读 `auth_user.role`）决定放行。

于是同一件事有了两个授权面。RBAC 侧摘掉某账号的 `super_admin` 之后，插件端点仍认 `role = 'admin'`，封号、改密、删号照旧生效；反方向，镜像漏写时超管调插件端点得到 403。ADR-0052 把这份冗余记为「接受」的代价，代价实际集中在 6 个写入点与 2 个读取点上，其中 4 个写入点（安装引导、安装流程、QQ 建号、`manage-cli`）与授权无关，只为喂插件。

ADR-0053 把判定链路改成一条点查之后，镜像的消费者只剩插件，插件的消费者只剩 5 处调用：建号、删号、封禁/解封、改密、改资料。此时继续维护镜像不换取任何东西。

## 决策

1. **删除 admin 插件。** `plugins` 只剩 `passkey` / `username` / `oauthProvider`。
2. **`auth_user.role` 停写停读**，存量值由 `migrations/0163_data_clear_auth_user_role.sql` 清为 NULL。列本身保留：删列要重建 `auth_user`，而它被 18 张表按 `userId` 引用。
3. **五个后台账号写操作改为自研。** 建号、删号、封禁/解封、改密、改资料不再经过 `auth.api`。建号与凭证两条语句由 `src/server/auth/account-insert.ts` 统一给出，列清单全仓唯一一份在 `src/shared/AdminAccountColumns.ts`。
4. **封禁 = 收回该账号的全部身份凭据。** 一次清 `auth_session`、`ext_login_credentials`、`oauth_access_token`、`oauth_refresh_token`、`oauth_consent`、`oauth_connection`；解封只改标志，**不恢复任何已吊销的凭据**。

## 范围之外

- `passkey` / `username` / `oauthProvider` 三个插件保留，`banned` 列保留（三处登录闸门与 App 侧都读它）。
- `auth_user` 其余列不动。`signup_source` 只做一次越界值订正，与清镜像同支迁移。
- RBAC 判定规则、权限码集合、菜单 gate、`audience` 分区不动。

## 与 ADR-0052 的关系

0052 决策 2 主张「`auth_user.role` 继续只是有损派生镜像，只供 Better Auth admin 插件端点使用」，前提是那套端点存在。本 ADR 把这个前提删除，因此撤回该条；0052「保留的缺陷与它的修法」段描述的漂移问题随之失去对象（镜像已清空，没有可漂移的两侧），一并标注撤回。

0052 的决策 1（判定保持自研）、决策 3（不引入 access control、organization 动态角色、`userHasPermission` 端点）、决策 4（三项定向优化）不受影响，仍然有效。

撤回位置写在 0052 正文里（状态行括注 + 决策 2 后的引用块），本 ADR 不复制它的表格与论证。

## 量化依据差量

0052 的否决结论建立在一张七行表上。删插件改变了其中四行的分母或刻度，逐行结论如下：

| 0052 的行 | 本次之后 |
|---|---|
| 代码量 6,262 → 6,353 行（+91，是增不是减） | **失效，需重算**。两侧分母都减小：自研侧不再有镜像读写，迁移侧不再有插件依赖。差值可能反转 |
| DB 往返每请求不变 | 仍成立，但已被 ADR-0053 改写：后台判定从 3 条 / 1 趟变 1 条 / 1 趟 |
| 查询计划 `USE TEMP B-TREE FOR DISTINCT` 依旧存在 | **被 0053 部分作废**：判定实现换了，该子句不再出现在这条路径上 |
| 判定耗时 0.48 µs → 749 µs | 不受影响，仍是「无缓存即回归」的证据 |
| 能力覆盖 2 / 12 归位 Better Auth | 构成仍准，刻度变了。插件端点提供的「用户管理」本就不是 12 项之一，删掉它不动分子；删掉自研侧的镜像维护让分母的意义更弱 |
| 加权评分 51.8 → 86.1（权重 30%）/ 66.5 → 82.4（权重 10%） | **基线需下修**。收益仍几乎全部来自「标准度」这一个主观权重，删插件没有给它加分 |
| 三条工程约束 | 前两条（`authorize` 不认 `*`、自定义 `ac` 必须合并 `defaultStatements`）失去对象——它们是插件侧的实现约束；第三条（`adminRoles` 初始化校验）同样随之消失 |

净效果是往「迁 Better Auth」那一侧移动了一小步，但没有任何可测指标的相对关系被反转。0052 拒绝迁移的结论维持，依据须按上表重算，不能继续引用原表数字；重算之前那张表不再是可用的挡箭牌。

## 新增实测

2026-11-01，`better-auth@1.6.26` + 本机实例副本（9 个账号、76 张表）。

| 项 | 数字 |
|---|---|
| admin 插件端点 | 15 条 `/api/auth/admin/*`，对应 `api` 上 15 个方法名 |
| 代码侧调用点 | 5 处（建号、删号、封禁/解封、改密、改资料） |
| `auth_user.role` 写入点 | 6 处；读取点 2 处（`manage-cli` 那处装进 `AuthOwner.role`，无消费者） |
| 按 `userId` / `user_id` 引用 `auth_user` 的表 | 18 张：14 `CASCADE` + 2 `ON DELETE NO ACTION`（`ext_api_key_owners`、`ext_login_credentials`）+ 1 无外键（`auth_password_setup`）+ 1 审计流水（`ext_api_access_log`，13,068 行） |
| 删号需显式清理的表 | 17 张（`USER_OWNED_TABLES`），审计流水豁免 |

外键 `CASCADE` 只在删 `auth_user` 那一行时触发，而 `auth_user` 的 DELETE 必须排在批次最后（前面的语句都依赖这行存在）。因此 18 张表逐张显式 DELETE，不依赖级联；`ext_api_access_log` 刻意不删，账号消失后调用流水仍需可查。

## 后果

- 授权面收敛为一套：账号级操作全部过 RBAC 的码判定，`auth_user.role` 不再参与任何决定。
- 安装流程的建号批次从 3 条语句变 4 条（账号、凭证、授予、快照）。令牌校验留在两条建号语句自身里，并发消费时仍返回 0 changes，`password-setup` 的原子性不变。
- 后台建号、改密、改资料、封禁不再经过 better-auth，错误语义由 handler 自己给出（`duplicateEmail` / `unknownUser` / `lastSuperAdmin` 等），`mapBetterAuthError` 随之删除。
- **封禁语义变重。** 过去封禁只拦登录：已签发的 OAuth 令牌校验不查 `banned`，被封账号持旧令牌仍可读写；现在封禁即吊销，两类凭据一起失效。
- 0163 之后 0161 成为历史动作：那一版让镜像与真源取同一值，这一版把镜像清空。两条迁移都保留，台账按文件名记账。
- `scripts/frozen-migration-names.txt` 只到 0107，0163 走 `NNNN_<type>_<desc>.sql` 命名。

## 被否决的替代方案

- **保留插件，只把镜像写对。** 6 个写入点要一直维护，插件端点的判据与 RBAC 永远是两套。ADR-0052 已把这份冗余记为代价，本次判定它不再换取任何东西。
- **删列，不只清值。** 删 `auth_user.role` 要重建表，18 张按 `userId` 引用的表全部要跟着处理外键；收益只是省一列存储。
- **封禁只拦登录，不吊销凭据。** 改动更小，但 OAuth 令牌校验不查 `banned`，被封账号持旧令牌可继续读写。两套凭据要能一起失效，只能一起删。
- **自己实现一个同名的 `userHasPermission` 端点。** 它依赖 BA 的 `role` 字段做判据，等于把 `auth_user.role` 换个形式请回来。
