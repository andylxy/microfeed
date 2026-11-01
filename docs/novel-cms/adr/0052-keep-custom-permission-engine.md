# ADR-0052: 权限判定保持自研，不迁入 Better Auth access control

- 状态：Accepted（已否决迁移方向，只保留三项定向优化；**决策 2 与「保留的缺陷」段已被 ADR-0054 撤回**，决策 1/3/4 仍有效）
- 日期：2026-11-01
- 关联：ADR-0008（API 认证与授权收敛，`mflc_` 凭证与自研 RBAC 码的来源）、ADR-0038（自持权限树）、ADR-0039（按终端归属分区）、ADR-0040（角色级「允许登录后台」，`allow_admin_login` 即 `userMayEnterAdmin` 的判据）、ADR-0053（权限快照，判定链路已改）、ADR-0054（移除 admin 插件，撤回本 ADR 决策 2）、`CONTEXT.md`（角色分配 / 角色镜像 / 通配权限 / 权限判定）、`docs/zh/user-system-optimization-spec.md`（本次实际执行的改动）

## 背景

曾有提案主张把权限判定整体迁回 Better Auth：用 `createAccessControl` + `ac.newRole(...).authorize()` 替换自研的 `permissionsInclude`，把角色分配从 `ext_user_roles` 搬到 `auth_user.role`（逗号分隔的角色码），并把 `ext_roles` / `ext_role_permissions` 降级为目录。

该提案按「判定引擎 + 角色单源」细化到可实施程度后，做了一次量化评估。评估口径：2026-11-01，`better-auth@1.6.26` 源码 + 本机实例副本（9 个账号、76 张表）。评估结论是**收益不成立**，本次评估据此否决该提案。

## 决策

1. **权限判定保持自研。** `src/server/rbac/resolve.ts` 的 `permissionsInclude` 仍是唯一判定规则；通配权限继续短路放行，不展开。
2. **角色分配的单源保持 `ext_user_roles`。** `auth_user.role` 继续只是有损派生镜像（`admin` / `user`），只供 Better Auth admin 插件端点使用，不承载授权。**（该条已被 ADR-0054 撤回：插件删除，列停写停读，存量值由 `0163` 清空。可见的只有「单源保持 `ext_user_roles`」这半句，镜像半句作废。）**
3. **不引入 Better Auth 的 access control、organization 动态角色或 `userHasPermission` 端点。**
4. 只执行三项定向优化：去掉一处冗余 `DISTINCT`、合并两条账号闸门查询、订正 `auth_user.role` 的存量漂移（含 `password-setup.ts` 的授权时机调整，理由见下文「保留的缺陷与它的修法」）。

> **修订（ADR-0054，2026-11-01）**：决策 2 撤回。admin 插件已移除，`auth_user.role` 停写停读，`migrations/0163_data_clear_auth_user_role.sql` 把存量值清为 NULL；镜像不再有读者，也就不存在「只供插件使用」这个用途。
>
> 决策 4 的第三项（订正镜像存量漂移）随决策 2 一起成为历史动作：`0161` 那一版让镜像与真源取同一值，`0163` 把镜像清空，两步都保留在台账里。决策 4 的前两项（去冗余 `DISTINCT`、合并闸门查询）已由 ADR-0053 的权限快照取代实现。
>
> 决策 1、决策 3 不受影响。下文「否决依据（量化）」表的四行随插件移除失去分母，逐行处置见 ADR-0054「量化依据差量」；重算之前不能继续引用原表数字，但拒绝迁移的结论维持。

## 否决依据（量化）

下表所有数字来自 2026-11-01 的同一次评估，范围同上（`better-auth@1.6.26` + 本机实例副本）。

| 维度 | 实测结果 |
|---|---|
| 代码量 | 用户体系自有代码 6,262 行，迁移后约 6,353 行 —— **+91 行（+1.5%）**，是增不是减 |
| DB 往返 | `resolveRbacContext` 每请求 4 条语句 / 3 个串行往返（请求带 `x-device-id` 时 6 条 / 5 趟），迁移前后 **不变** |
| 查询计划 | `SELECT DISTINCT` 仍在，`USE TEMP B-TREE FOR DISTINCT` **依旧存在**，无性能收益 |
| 判定耗时 | 38 次判定的每页成本从 0.48 µs 涨到 749 µs（草案实现，含 `ac.newRole` 重建角色对象）；加缓存后才拉回现状 —— 属于自造回归再修补 |
| 能力覆盖 | 迁移后真正归位 Better Auth 的只有 2 / 12 项（17%）：判定原语、角色分配字段。权限树、`audience` 分区、菜单 gate、后台在线改权、审计、配额、设备、`mflc_` 凭证、登录节流共 10 项 Better Auth 没有原生对应，仍须自建 |
| 加权评分 | 标准度权重 30% 时 51.8 → 86.1；权重降到 10% 时 66.5 → 82.4。收益几乎全部来自「标准度」这一个主观权重，而非任何可测指标 |

三条工程约束进一步压低了收益的确定性：

- Better Auth 的 `authorize` 只做精确匹配，**不认 `*`**。`super_admin` 的通配必须展开成全量 action，从「零维护的通配」变成「漏一个码就对相应功能 403」（1 / 64 ≈ 1.6%）。
- 传给 `admin()` 的自定义 `ac` 必须合并 `defaultStatements`，否则插件自带判据（`user:["set-role"]`、`session:["revoke"]` 等）会让**所有角色** 403，含超管。
- `admin({adminRoles})` 在初始化时同步校验角色码必须存在于 `roles` 配置，导致「后台在线改权」与「官方端点」之间必然出现缓存陈旧窗口，或每请求多付一次目录读。

## 后果

- 判定语义保持两套并存：项目 RBAC 一套、Better Auth admin 插件端点一套（后者只读 `auth_user.role`）。本次评估接受这一份冗余，代价由本 ADR 记录。
- 项目继续承担 `ext_*` 表的自维护成本（156 个迁移里 49 个与 RBAC 相关，占 31.4%）。
- 后续若有人重启该提案，需先推翻本 ADR 的量化口径；「标准」不能单独作为重启理由。

## 被否决的替代方案

- **判定引擎 + `auth_user.role` 单源**：否决理由同上（无指标改善，收益不可量化）。
- **迁到 organization 插件的 `dynamicAccessControl`**：需引入「单组织」建模，迁移与回滚面最大，收益同样不成立。
- **角色权限全部固定写在代码 `ac.newRole` 里**：最标准，但会取消后台在线改权，属产品能力倒退。
- **只改 `auth_user.role` 承载真实角色码、判定引擎不动**：改动最小，但仍是双写，且把有损镜像改成有损真源，问题更多。

## 保留的缺陷与它的修法（整段已由 ADR-0054 撤回）

> 本节描述的是「镜像继续存在」前提下的漂移问题。ADR-0054 清空了镜像，两侧不再并存，漂移无从产生；`0161` 与本节引用的运维查询归档为历史记录，`password-setup` 的授权时机调整仍留在代码里（它同时是 ADR-0053 快照写入点之一）。

否决迁移**不**等于现状无缺陷。评估过程中实测到一处真问题（2026-11-01，本机实例 9 个账号）：`auth_user.role` 与 `ext_user_roles` 漂移。

- 本地 9 个账号中 1 个错向（`6022f637…`：`role = NULL` 却是 `super_admin`），表现为能进用户管理页、但调 Better Auth 的封禁/删除端点返回 403；另一个方向（`role = admin` 但无 `super_admin`，越权）实测 0 例。
- 代码侧写入点由 `tests/unit/auth-role-mirror.test.ts` 约束，但覆盖面只到 `UPDATE` 与其两处映射；`INSERT INTO auth_user` 那半只校验文件清单，不校验写入的 `role` 值。
- `password-setup.ts` 的 `ext_user_roles` 授予在建号 `batch` 之后单独执行，窗口内失败会留下「`role = admin` 但无 `super_admin`」的越权行。这一处需随迁移一起调整（授予移进同一 `batch`）。
- 修法是 `migrations/0161_data_sync_auth_user_role.sql` 一次性订正 + 一处授权时机调整 + 一条运维查询，详见 `docs/zh/user-system-optimization-spec.md` §§5、6。
