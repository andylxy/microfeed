# 本地 D1 到远程 D1 同步与核对

实例 `ctwh-881019-xyz`。本册从仓库根 `AGENTS.md` 移出，规则条文与实测数据逐字保留；触发条件见 `AGENTS.md` 的读取约定。

## 方向与标准

- 同步永远是**本地 → 远程**单向；核对以**本地 D1 为准**，任何一行 `local ≠ remote` 都判定为不一致。
- 反向（远程 → 本地）不在这套方案内；需要把生产数据回灌时另行立项。

## 唯一通道

- 写远程一律走 D1 REST 的 `{sql, params}` 批量接口（`.scratch/backups/sync-tables.mjs`：SQL 文本只有 `?` 占位、值全部经 `params` 传递、每批 ≤20 条语句且 ≤4,000,000 字节请求体、逐批回报 `rows_written`）。
- 字面量分片通道（`import-local-to-remote.sh`、`themes_chunked.sql`、`push-remote.sh`）与「占位 INSERT + 分块 UPDATE 拼列」不再使用。
- 派生表不推送原始行：`ext_admin_typeahead_*` 6 张由 `items` 上的 INSERT / DELETE 触发器在远程重建。原 `site_search_*` 14 张与 `items` / `pages` / `site_search_documents` 上的 9 条触发器已随迁移 0151 退役（ADR-0051）；远程若仍残留旧表，核对会按「本地缺表」报出，手工在远程执行 0151 的 DROP 即收敛。

## 五个阶段（顺序固定）

| 阶段 | 动作 | 远程读取（行） | 远程写入（行） |
| --- | --- | --- | --- |
| 0 | `wrangler whoami` 续期令牌 + 远程 schema 只读盘点（表与列逐一比对本地表清单，2026-10-26 迁移 0151 后为 75 张） | 探针不回报 `meta`，读数并入阶段 2/4 | 0 |
| 1 | `yarn manage deploy`：代码发布 + 待应用迁移在远程生效 | ≈19,000（推断值） | ≈19,083 + 种子 DML（推断值，按被索引表行数：`items` 9,506×2 + `themes` 10×2 + `ext_user_devices` 51 + 两张空表 0；deploy 不回报写入行数） |
| 2 | `reconcile-local-remote.mjs`（counts 模式）取差异表清单 | 2026-10-22 实测 89 行 / 89 次调用（`COUNT(*)` 走索引，方案初稿的 111,523 是按全表行数累加的上界） | 0 |
| 3 | 将改表的远程快照 → `sync-tables.mjs --dry-run` 看计划 → 正式补推（仅差异表） | 差异表远程行数 | 差异行数 × 2；2026-10-22 实测 862 行（11 + 776 + 75，含索引维护） |
| 4 | `reconcile-local-remote.mjs --deep` 复核 + 两侧 `theme_state → themes` 引用完整性 | 2026-10-22 实测 12,207 行 / 161 次调用 | 0 |

- 判定：阶段 4 退出码 `0` 才是「远程 = 本地」；`1` 回到阶段 3 只补报出的表；`2` 是令牌过期，回阶段 0。
- 报出「真不一致」时先确定改动在哪一侧，再决定要不要推：把同一张表在历次报告里的内容哈希排成时间线，本地哈希全程不变而远程哈希在补推之后又动过，说明是有人在生产后台改了数据，按本地补推会覆盖那次改动，必须先向用户报明两侧的值与时刻。2026-10-22 实测：`ext_permission_nodes` 本地哈希 `08d27c316b` 从 07:54 到 08:48 未变，远程 `d49620adc9 → 08d27c316b`（补推生效）`→ 6d11b2a359`（08:06–08:48 之间产生），差异是 `page_all_items.name_zh` 一行一列，远程值「全部条目」、本地值（迁移 0127 种子）「查看全部条目」。
- 结论只建立在阶段 4 的复核报告上，不建立在过程日志上。
- 核对范围随本地表清单更新：2026-10-26 迁移 0151 之后本地 76 张表（`_cf_METADATA` 与 `d1_migrations` 除外共 **74 张**参与核对；退役前 88 张 / 86 张），其中派生表只剩 `ext_admin_typeahead_*` **6 张 / 28,821 行**（退役前 20 张 / 97,086 行）。`reconcile-local-remote.mjs` 的 `DERIVED`、`RUNTIME_DRIFT`、`ENV_BOUND`、`LAZY_INDEX`、`DEEP_TABLES` 五个集合与 `.scratch/backups/realtables.txt` 每次同步前按本地实测刷新，否则新表会被漏检。
- `DEEP_TABLES` 与 `RUNTIME_DRIFT` 必须互斥：`auth_session` 同时属于两者时，两侧 Worker 各自的会话会让全列内容哈希永远报「真不一致」。2026-10-22 实测把 `auth_session` 从 `DEEP_TABLES` 移出后，深校验项从 162 降到 160。

## 不参与一致性判定的四类表

一张表只要属于下面任一类，就既不判定、也不补推；判定「远程 = 本地」时把它们排除在外。分类与 `manage-cli/lib/snapshot.ts` 的快照口径同源（`ephemeral` 的密钥类表与 `targetSpecific` 的 `microfeed_installation` 都不跨部署边界搬运）。

| 集合 | 成员 | 为什么不能比 | 处理动作 |
| --- | --- | --- | --- |
| `DERIVED` | `ext_admin_typeahead_*` 6 张（`site_search_*` 14 张已随迁移 0151 退役，不再登记） | items 的触发器在各自环境同步写入影子行 | 只比行数 |
| `RUNTIME_DRIFT` | 22 张：登录流水、审计、会话、nonce、设备、`item_create_idempotency`、4 张 `oauth_*` 会话行、`theme_management_tokens`、5 张 `webhook_*` 投递与记账 | 两侧 Worker 各自写，行数是各自流量的函数 | 只比行数，报「预期漂移」；`sync-tables.mjs` 同样把它们剔出同步对象（推过去会用本地的行覆盖远程自己写的行，例如清空远程的 Webhooks 投递历史与当日记账） |
| `ENV_BOUND` | `ext_cloud_usage_token`、`webhook_endpoints`、`microfeed_installation` | 行内容是这一套部署自己的密钥或身份。密文 KEK 由 `manage-cli/lib/config.ts:711-713`（本地）与 `manage-cli/lib/deploySupport.ts:827-829`（首次部署）各生成一次 `randomBytes(32)`，两端必然不同；`microfeed_installation.instanceId` 由 `src/server/installation-identity.ts:39-43` 每套部署自己生成并经 `/.well-known/microfeed.json` 对外公布 | `sync-tables.mjs` 命中即退出码 `2` 中止；远程侧恢复：Token 由用户在远程设置页重新保存，`microfeed_installation` 删行后由远程自己再生成 |
| `LAZY_INDEX` | `ext_marker_citations`、`ext_marker_citation_state`、`ext_book_stats` | 行只在「某个读者打开某本书」时物化该书那一行/那批行（迁移 0111：「没有行 = 从未算过」；迁移 0103 同形状），`computed_at_ms` 是各自环境的上次重算时刻 | `sync-tables.mjs` 命中即跳过并给提示（推过去要烧 `ext_marker_citations` 1,818×2 = 3,636 行写，却不产生正确性）；远程读同书时若被触发器标脏会自行重算 |

- `ENV_BOUND` 与 `LAZY_INDEX` 都不许进 `DEEP_TABLES`：跨环境内容哈希**相等**恰恰是错误状态（两端报同一个安装身份，或远程在用本地的密钥密文）。2026-10-22 实测：`ext_cloud_usage_token` 本地 1 行推到远程后，`feed.881019.xyz` 的云用量看板显示「已保存的 Token 无法读取」（`src/server/cloud-usage/token-store.ts:90-97` 解密失败，返回 `unreadable`）。
- 新表的归类用只读探针找，不靠猜：密钥类看 `.scratch/d1-sync-20261022/probe-secret-columns.mjs`（按列名 `cipher|secret|token|nonce|signing|credential|_key$|^key` 扫全库，只打印行数、长度与形状，不打印值）和宽词形版 `probe-secret-columns-wide.mjs`（再加 `key|signature|hash|salt|password|hmac|bearer|jwt|otp|fingerprint`，2026-10-22 实测 23 个候选列，逐列判定结果见 `.scratch/d1-sync-20261022/sync-plan-2026-10-22.md` 第 8.1 节的表）；懒建类看迁移里有没有 `UPDATE <state 表> SET computed_at_ms = 0` 形状的失效触发器。
- `sync-tables.mjs` 的三道护栏（2026-10-22 加，全部本地只读计算，中止时不发起任何远程调用）：① `ENV_BOUND` 命中 → 退出码 `2`；② `LAZY_INDEX` 与 `RUNTIME_DRIFT` 命中 → 从同步对象里剔除并打 `[跳过]`；③ 从本地库读全部 `ON DELETE CASCADE` 边做级联闭包，父表在对象里而子表既不在对象里、也不属于上面两类 → 退出码 `2` 并逐条列出 `父 → 子`（子表属运行态时打 `[注意]` 放行），父子同在对象里时按级联深度稳定排序、父表先发。实测：`auth_user` 单独作为对象时报出 5 张必须一并列入的子表（`auth_account`、`oauth_client`、`passkey`、`ext_user_roles`、`ext_user_security`）；`ext_permissions` 报 `ext_permissions → ext_role_permissions`；`ext_user_roles ext_role_permissions ext_roles` 三个一起给时按 `ext_roles` 先、两张子表后发送。
- 移出后深校验项从 160 降到 151（2026-10-22 实测：`DEEP_TABLES` 33 张，检查 151 项 = 86 张行数 + 33 主键哈希 + 30 全列哈希 + 2 引用完整性 + …）。

## 触发器连带写入（决定单日能追平多少条目）

- 本地实测比例（2026-10-26 迁移 0151 之后）：`items` 9,506 行对应派生表 28,821 行（`ext_admin_typeahead_*` 6 张）→ **3.03 连带行 / 条**。退役前是 97,086 行 / 10.21 连带行（多出来的 68,265 行 = 已退役的 `site_search_*` 14 张）。
- 一条 `items` 差异行 = 1 DELETE + 1 INSERT + 派生写入（INSERT 侧按 3.03 计，DELETE 侧在只读条件下无法量得，按同一比例计入上界）≈ **8.1 行写**（退役前 22.4）。
- 单日上界：当天已应用迁移（剩 80,917 行写额度）≈ **10,040 条**；未占用写额度时 ≈ **12,406 条**。整表 9,506 条差异现已在单日额度内（9,506 × 8.06 ≈ 76,619 行写 < 100,000），不必再分两日推送。
- 小表没有该瓶颈：`themes` 全表重推 20 行写（该表无触发器）、`theme_state` 2 行写、其余内容表合计 4,562 行写上界。
- **外键级联（`ON DELETE CASCADE`）会被「DELETE+INSERT 整行替换」触发。** 2026-10-22 全库实测（`.scratch/d1-sync-20261022/probe-fk-all-edges.stdout.txt`：88 张表、29 条外键边、23 条 CASCADE / SET NULL）：以 `auth_user(id)` 为父的 CASCADE 边 **12 条**（`auth_account`、`auth_session`、`ext_app_login_log`、`ext_user_devices`、`ext_user_roles`、`ext_user_security`、`oauth_access_token`、`oauth_client`、`oauth_connection`、`oauth_consent`、`oauth_refresh_token`、`passkey`），`ext_roles(role_id)` 出 2 条（`ext_role_permissions`、`ext_user_roles`），`ext_permissions(id)` 出 1 条（`ext_role_permissions`），`oauth_client(clientId)` 出 4 条，`webhook_endpoints(id)` 出 1 条（`webhook_subscriptions`）。补推 `ext_roles` 里 1 行时，远程把指向该角色的 23 条权限行与 2 条用户角色行一并删掉，本地 62/4 对远程 39/2。
- ⇒ 阶段 3 的补推必须**先父表、后子表，并在推完子表后重新跑一次阶段 4**；只看父表本身的行数与哈希查不出这种丢失。`sync-tables.mjs` 已把这条做成护栏：从本地库读全部 `ON DELETE CASCADE` 边，父表在对象里而子表不在 → 退出码 `2` 中止并列出缺失子表（运行态子表给 `[注意]` 提示后放行，懒建索引与环境绑定子表豁免）；父子同在时按级联深度排序，父表先发。

## 额度纪律与本地读取

- 派生索引重建的连带写入来源：触发器往 `ext_admin_typeahead` 逐字索引写海量 token 行；`site_search_*` FTS 表族已随迁移 0151 退役（ADR-0051）。写额度耗尽后的报错原文是 `[code:7500] exceeded D1's free tier daily row write limit`。
- 首批 `rows_written` 回报用于外推剩余量；外推总量超过当日剩余额度即刻停止，剩余行改期，绝不整表补跑。
- 本地库在同步与核对全程只读（探针与两个同步工具一律 `{readOnly: true}`，工具自身只发远程语句）。读取必须经 SQLite 打开（WAL 模式自动生效），不复制文件、不以文件时间戳代替内容判断。
- **本地 dev server 在跑的时候，「本地为标准」是一个时间点**：本地 Worker 会持续写登录流水、审计与派生表。2026-10-22 实测：主文件 89,976,832 字节、WAL 0 字节（07:25 由本地 dev server 检查点写入，该进程不属于同步流程，也不得停止）。阶段 4 报告只代表它生成的那一刻；要确认当下状态就复跑阶段 4。
- 2026-10-22 一次完整执行的额度实测：远程读取 36,664 行 / 574 次调用（阶段 2 的 89 行 + 阶段 4 三次深校验的 12,211 / 12,157 / 12,207 行），占 5,000,000 行/日 的 0.73%；远程写入 862 行（阶段 3 三轮、18 个批次回报之和，含索引维护），占 100,000 行/日 的 0.86%。`yarn manage deploy` 不回报写入行数，所以阶段 1 的迁移写入量始终是推断值。
- 同日修复环境绑定数据后的累计实测：再加三次深校验 13,208 行 / 157 次 + 10,349 行 / 152 次 + 10,349 行 / 152 次（后两次是移出 `ENV_BOUND` / `LAZY_INDEX` 之后的口径），以及远程删两行（`ext_cloud_usage_token`、`microfeed_installation` 各 1 行，`meta.changes = 1` / `rows_written = 1`）。当日合计远程读取 70,570 行 / 1,035 次调用（1.41%），远程写入 864 行（0.86%）。
- 运行态表（两侧 Worker 各自写入的登录流水、审计、会话、nonce、设备）按口径跳过，不追平；要求逐行一致必须先停止生产写入。

## 远程操作的授权

- 阶段 0 / 2 / 4 的只读查询、阶段 1 的部署、阶段 3 的补推，都要用户当场指令；执行前复述命令、影响范围与写入行数。
- 部署从当前工作树构建，未提交的改动会一同上线；要让生产只运行已提交代码，先完成手动提交再部署。

## 主题写库必须用绑定参数（完整条文）

`AGENTS.md` 常驻区只保留这条规则的四条结论，以下是完整条文与量化理由。数字与常驻区同源，改动时两处一起改。

- 一切向 `themes` / `theme_drafts` 写行的代码——Worker `src/server/themes/ThemeStore.ts`、管理 CLI `manage-cli/theme.ts`，以及任何后续新增的主题安装 / 发布 / 草稿 / 迁移路径——都必须使用**绑定参数**：SQL 里只写 `?` 占位，值经 `.bind(...)` / `queryD1WithParameters(...)` 传。严禁把 `bundle_json` 等大列用模板插值拼进 SQL 字面量。
- 理由（量化）：D1 对**单条 SQL 语句的字面量长度有上限，实测约 100KB**（75KB 可通过、135KB 报 `SQLITE_TOOBIG`）。中文主题 `feed-zh` 的 `bundle_json` 按 2026-10-22 本地 `themes` 表实测最大 **121,180 字节**（全表 9 行未删除合计 512,664 字节），按字面量拼必失败；绑定参数不计入 SQL 文本长度，可正常入库。
- **安装主题时的确认动作**（每次 `manage theme install`、后台安装、草稿发布之前都要做）：确认写 `themes` / `theme_drafts` 的 SQL 文本只有 `?` 占位、`bundle_json` 与 `preview_fixture_json` 全部经绑定参数传入。绑定参数不计入 SQL 文本长度，所以 2026-10-22 本地实测最大 **121,180 字节** 的 `bundle_json` 不占用语句文本，一条 INSERT 即可入库；只要看到 SQL 文本里出现大列内容或者分块 UPDATE 拼接，该次安装通道不合格，先改造通道再执行。
- 该不变量由 `tests/unit/theme-install-bound-params.test.ts` 守护：写 `themes` / `theme_drafts` 的 INSERT SQL 中不得出现 `${` 插值。
- **数据同步场景同样适用**：本地→远程同步、整库覆盖、差量补推等一切向 `themes` / `theme_drafts` 写行的路径（含 `.scratch` 下的一次性同步脚本、D1 REST 批量接口）都必须走绑定参数——SQL 文本只写 `?` 占位，值经 `.bind(...)`、`queryD1WithParameters(...)` 或 REST `{sql, params}` 传。把大列拼成 SQL 字面量（`VALUES ('<大列文本>')`）、以及「占位 INSERT + 分块 UPDATE 拼列」都是历史应急通道，不作为常规方案。
- **安装或同步主题前的确认清单**（三条全部满足才算通过）：① 写库 SQL 文本中只有 `?` 占位、无任何大列字面量；② 全部值（含 `bundle_json`、`preview_fixture_json`）经绑定参数传递；③ 预期效果：feed-zh 整行 `bundle_json`（本地实测最大 121,180 字节、全表合计 512,664 字节）**一条 INSERT 即可入库**，不出现为绕过文本长度上限而做的分块 UPDATE。若不满足（例如拿到的是字面量 SQL 文件），先改造通道再执行。
- **同步额度纪律**（2026-10-18 实测教训）：单表同步失败不得触发全表补跑——整表重推会把日写额度（100,000 行）翻倍烧光；核对通过即零写入；一次到位、不重推。
