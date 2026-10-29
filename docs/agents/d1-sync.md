# 本地 D1 到远程 D1 同步与核对

实例 `ctwh-881019-xyz`。本册从仓库根 `AGENTS.md` 移出，规则条文与实测数据逐字保留；触发条件见 `AGENTS.md` 的读取约定。

## 方向与标准

- 同步永远是**本地 → 远程**单向；核对以**本地 D1 为准**，任何一行 `local ≠ remote` 都判定为不一致。
- 反向（远程 → 本地）不在这套方案内；需要把生产数据回灌时另行立项。

## 唯一通道

- 写远程一律走 D1 REST 的 `{sql, params}` 批量接口（`.scratch/backups/sync-tables.mjs`：SQL 文本只有 `?` 占位、值全部经 `params` 传递、每批 ≤20 条语句且 ≤4,000,000 字节请求体、逐批回报 `rows_written`）。
- 字面量分片通道（`import-local-to-remote.sh`、`themes_chunked.sql`、`push-remote.sh`）与「占位 INSERT + 分块 UPDATE 拼列」不再使用。
- 该工具读远程快照按主键排序分页，每页 1,000 行（2026-10-26 加）：`items` 全表 9,506 行 / `data` 列合计 4,451,700 字节，一次 `SELECT *` 的 JSON 响应体约 5MB，分页避免响应体上限把差异检测打断；OFFSET 会连带扫描被跳过的行，代价见阶段 3 的 `rows_read` 上界。
- 本通道只搬运 D1 行。R2 对象不在内：2026-10-26 实测本地 media 桶只有 1 个对象（`production/app/AndroidProject-old_v1.5_debug-e4b2607f.apk`，20,670,678 字节）。主题的 CSS/JS 全部在 `themes.bundle_json` 里（本地 12 行 `json_array_length(bundle_json,'$.assets')` 全为 0），所以推 `themes` 行不需要配套搬 R2；条目附件一旦新增就要单独核对远程同名 key。
- 派生表不推送原始行：`ext_admin_typeahead_*` 6 张由 `items` 上的 INSERT / DELETE 触发器在远程重建。原 `site_search_*` 14 张与 `items` / `pages` / `site_search_documents` 上的 9 条触发器已随迁移 0151 退役（ADR-0051）；`reconcile-local-remote.mjs` 只遍历本地清单，报不出远程多出来的表，所以远程残留要在阶段 0 用「远程表清单 − 本地表清单」差集发现，处置是阶段 1 的部署把 0151 的 DROP 在远程应用。

## 五个阶段（顺序固定）

| 阶段 | 动作 | 远程读取（行） | 远程写入（行） |
| --- | --- | --- | --- |
| 0 | `wrangler whoami` 续期令牌 + 远程 schema 只读盘点（表与列逐一比对本地表清单，2026-10-26 本地实测 `sqlite_master` 76 张表，扣除 `sync-table-classification.mjs` 的 `EXCLUDE` 两张平台内部表 `d1_migrations`、`_cf_METADATA` 参与核对 **74 张**；真实 D1 另有内部表 `_cf_KV`，miniflare 的本地库不建这张，远程盘点按 `startsWith('_cf_')` 统一排除） | 探针不回报 `meta`，读数并入阶段 2/4 | 0 |
| 1 | `yarn manage deploy`：代码发布 + 待应用迁移在远程生效 | ≈19,000（推断值） | 迁移 DML 的影响行数之和，2026-10-26 口径（0142–0152）≈60 行（种子 INSERT 与排序 UPDATE，0144/0147/0149/0151 是 DDL，`api_keys` 拷行数另算）；2026-10-22 口径 ≈19,083 + 种子 DML（按被索引表行数：`items` 9,506×2 + `themes` 10×2 + `ext_user_devices` 51 + 两张空表 0）。deploy 不回报写入行数，这一项永远是推断值 |
| 2 | `reconcile-local-remote.mjs`（counts 模式）取差异表清单 | 2026-10-26 口径 74 次 `COUNT(*)` 调用（2026-10-22 实测 89 行 / 89 次调用，`COUNT(*)` 走索引，方案初稿的 111,523 是按全表行数累加的上界） | 0 |
| 3 | 将改表的远程快照 → `sync-tables.mjs --dry-run` 看计划 → 正式补推（仅差异表） | 差异表远程行数（远程读已改为分页，每页 1,000 行：`items` **一轮**的 OFFSET 扫描算术上界 55,000 行 = 日读额度 1.1%，2026-10-26 算得；这只是单轮上界，当天真实读取量打满了 5,000,000 行，别拿它估计全日，见「额度纪律与本地读取」） | 差异行数 × 2；2026-10-22 实测 862 行（11 + 776 + 75，含索引维护） |
| 4 | `reconcile-local-remote.mjs --deep` 复核 + 两侧 `theme_state → themes` 引用完整性 | 2026-10-22 实测 12,207 行 / 161 次调用；2026-10-26 口径 = 74 次行数 + 32 次主键哈希 + 31 次全列哈希 + 2 次引用检查 = **139 项**（`items` 9,506 行超 500 阈值只做行数与主键哈希） | 0 |

- 判定：阶段 4 退出码 `0` 才是「远程 = 本地」；`1` 回到阶段 3 只补报出的表；`2` 是令牌过期，回阶段 0。
- 报出「真不一致」时先确定改动在哪一侧，再决定要不要推：把同一张表在历次报告里的内容哈希排成时间线，本地哈希全程不变而远程哈希在补推之后又动过，说明是有人在生产后台改了数据，按本地补推会覆盖那次改动，必须先向用户报明两侧的值与时刻。2026-10-22 实测：`ext_permission_nodes` 本地哈希 `08d27c316b` 从 07:54 到 08:48 未变，远程 `d49620adc9 → 08d27c316b`（补推生效）`→ 6d11b2a359`（08:06–08:48 之间产生），差异是 `page_all_items.name_zh` 一行一列，远程值「全部条目」、本地值（迁移 0127 种子）「查看全部条目」。
- 结论只建立在阶段 4 的复核报告上，不建立在过程日志上。
- 核对范围随本地表清单更新：2026-10-26 迁移 0151 之后本地 76 张表（扣除 `sync-table-classification.mjs` 的 `EXCLUDE` 两张平台内部表 `d1_migrations`、`_cf_METADATA` 共 **74 张**参与核对；退役前 88 张 / 86 张），其中派生表只剩 `ext_admin_typeahead_*` **6 张 / 28,821 行**（退役前 20 张 / 97,086 行）。`reconcile-local-remote.mjs` 与 `sync-tables.mjs` 的 `DERIVED`、`RUNTIME_DRIFT`、`ENV_BOUND`、`LAZY_INDEX`、`DEEP_TABLES` 五个集合现在都由 `.scratch/backups/sync-table-classification.mjs` 单点导出，与 `.scratch/backups/realtables.txt` 一起每次同步前按本地实测刷新，否则新表会被漏检。
- 2026-10-26 的刷新结果（本地实测 `.scratch/d1-sync-20261026/probe-cost-20261026.stdout.txt`）：`DEEP_TABLES` 32 张（移出已退役的 `item_search_metadata` 与改为 `ENV_BOUND` 的 `ext_login_credentials`，补入迁移 0145 / 0142 新增的 `ext_app_about_info`、`ext_book_status`）；`RUNTIME_DRIFT` 23 张（补入迁移 0147 的 `ext_app_request_quota`）；`ENV_BOUND` 5 张（补入 `api_keys`、`ext_login_credentials`）；判定范围内的内容表 37 张 / 本地 9,915 行，整表重推的写额度上界 19,830 行写（日额度的 19.8%）。只比行数、不做内容哈希的内容表 5 张：`ext_api_key_owners`、`ext_content_correction`、`ext_content_report`、`passkey`、`theme_drafts`。
- `DEEP_TABLES` 与 `RUNTIME_DRIFT` 必须互斥：`auth_session` 同时属于两者时，两侧 Worker 各自的会话会让全列内容哈希永远报「真不一致」。2026-10-22 实测把 `auth_session` 从 `DEEP_TABLES` 移出后，深校验项从 162 降到 160。2026-10-26 起 `reconcile-local-remote.mjs` 对不在本地清单里的 `DEEP_TABLES` 成员打 `[跳过]` 并继续（表退役时不再让本地取数那一步抛 `no such table` 打断整份报告），互斥性由 `.scratch/d1-sync-20261026/probe-cost-20261026.mjs` 只读校验。

## 不参与一致性判定的四类表

一张表只要属于下面任一类，就既不判定、也不补推；判定「远程 = 本地」时把它们排除在外。分类与 `manage-cli/lib/snapshot.ts` 的快照口径同源（`ephemeral` 的密钥类表与 `targetSpecific` 的 `microfeed_installation` 都不跨部署边界搬运）。

| 集合 | 成员 | 为什么不能比 | 处理动作 |
| --- | --- | --- | --- |
| `DERIVED` | `ext_admin_typeahead_*` 6 张（`site_search_*` 14 张已随迁移 0151 退役，不再登记） | items 的触发器在各自环境同步写入影子行；FTS5 的 `_data`/`_idx` 两张内部 B-tree 的行数随写入顺序与 compaction 历史变化，两侧各按自身写序必然不同（2026-10-26 实测：主表 9,506/9,506、`_content` 9,506/9,506、`_docsize` 9,506/9,506、`_config` 1/1 全等，只有 `_data` 174/134 与 `_idx` 128/98 不等） | 主表行数相等即内容等价；核对工具把它们单列成「派生索引分段差」，不计入真不一致；`sync-tables.mjs` 第四道护栏把它们剔出同步对象（往内部 B-tree 硬写键页会破坏索引结构，远程要重建走 `rebuildItemSearchIndexes`：DROP + CREATE + 从 items 回填） |
| `RUNTIME_DRIFT` | 23 张：登录流水、审计、会话、nonce、设备、`item_create_idempotency`、4 张 `oauth_*` 会话行、`theme_management_tokens`、5 张 `webhook_*` 投递与记账、`ext_app_request_quota` | 两侧 Worker 各自写，行数是各自流量的函数；`ext_app_request_quota`（迁移 0147）由处理请求的一侧按 `credential_id` UPSERT 递增计数（`src/server/rbac/app-quota.ts:114-119`），`reset_at_ms` 是各自环境的窗口终点 | 只比行数，报「预期漂移」；`sync-tables.mjs` 同样把它们剔出同步对象（推过去会用本地的行覆盖远程自己写的行，例如清空远程的 Webhooks 投递历史、当日记账与 App 读额度计数） |
| `ENV_BOUND` | `ext_cloud_usage_token`、`webhook_endpoints`、`microfeed_installation`、`api_keys`、`ext_login_credentials` | 行内容是这一套部署自己的密钥、凭证或身份。密文 KEK 由 `manage-cli/lib/config.ts:711-713`（本地）与 `manage-cli/lib/deploySupport.ts:827-829`（首次部署）各生成一次 `randomBytes(32)`，两端必然不同；`microfeed_installation.instanceId` 由 `src/server/installation-identity.ts:39-43` 每套部署自己生成并经 `/.well-known/microfeed.json` 对外公布；`api_keys` 自迁移 0148 起只存 `secret_hash`（明文列已删除，本地 0 行推过去等于把远程已签发的 Key 全删且无备份）；`ext_login_credentials.secret` 由 `src/server/auth/login-credentials.ts:72` 随机生成、`:123` 写入，明文只回给客户端一次 | `sync-tables.mjs` 命中即退出码 `2` 中止；远程侧恢复：Token 由用户在远程设置页重新保存，`microfeed_installation` 删行后由远程自己再生成，API Key 与登录凭证在各自环境后台重新签发 |
| `LAZY_INDEX` | `ext_marker_citations`、`ext_marker_citation_state`、`ext_book_stats` | 行只在「某个读者打开某本书」时物化该书那一行/那批行（迁移 0111：「没有行 = 从未算过」；迁移 0103 同形状），`computed_at_ms` 是各自环境的上次重算时刻 | `sync-tables.mjs` 命中即跳过并给提示（推过去要烧 `ext_marker_citations` 1,818×2 = 3,636 行写，却不产生正确性）；远程读同书时若被触发器标脏会自行重算 |

- `ENV_BOUND` 与 `LAZY_INDEX` 都不许进 `DEEP_TABLES`：跨环境内容哈希**相等**恰恰是错误状态（两端报同一个安装身份，或远程在用本地的密钥密文）。2026-10-22 实测：`ext_cloud_usage_token` 本地 1 行推到远程后，`feed.881019.xyz` 的云用量看板显示「已保存的 Token 无法读取」（`src/server/cloud-usage/token-store.ts:90-97` 解密失败，返回 `unreadable`）。
- 新表的归类用只读探针找，不靠猜：密钥类看 `.scratch/d1-sync-20261022/probe-secret-columns.mjs`（按列名 `cipher|secret|token|nonce|signing|credential|_key$|^key` 扫全库，只打印行数、长度与形状，不打印值）和宽词形版 `probe-secret-columns-wide.mjs`（再加 `key|signature|hash|salt|password|hmac|bearer|jwt|otp|fingerprint`，2026-10-22 实测 23 个候选列，逐列判定结果见 `.scratch/d1-sync-20261022/sync-plan-2026-10-22.md` 第 8.1 节的表）；懒建类看迁移里有没有 `UPDATE <state 表> SET computed_at_ms = 0` 形状的失效触发器。
- 归类名单的唯一来源是 `.scratch/backups/sync-table-classification.mjs`（2026-10-26 抽出）：`EXCLUDE` 2、`DERIVED` 6、`RUNTIME_DRIFT` 23、`ENV_BOUND` 5、`LAZY_INDEX` 3、`DEEP_TABLES` 32、`FULLHASH_MAX_ROWS` 500。核对工具 `reconcile-local-remote.mjs` 与补推工具 `sync-tables.mjs` 都 import 它，新增表只改这一处；此前两个工具各写一份集合，2026-10-26 阶段 2 就是因为补推工具漏了 `DERIVED` 才需要补第四道护栏。
- `sync-tables.mjs` 的四道护栏（前三道 2026-10-22 加，第四道 2026-10-26 加，全部本地只读计算，中止时不发起任何远程调用）：① `ENV_BOUND` 命中 → 退出码 `2`；② `LAZY_INDEX` 与 `RUNTIME_DRIFT` 命中 → 从同步对象里剔除并打 `[跳过]`；③ 从本地库读全部 `ON DELETE CASCADE` 边做级联闭包，父表在对象里而子表既不在对象里、也不属于上面两类 → 退出码 `2` 并逐条列出 `父 → 子`（子表属运行态时打 `[注意]` 放行），父子同在对象里时按级联深度稳定排序、父表先发；④ `DERIVED` 命中 → 剔除并打 `[跳过]`。实测：`auth_user` 单独作为对象时报出 5 张必须一并列入的子表（`auth_account`、`oauth_client`、`passkey`、`ext_user_roles`、`ext_user_security`）；`ext_permissions` 报 `ext_permissions → ext_role_permissions`；`ext_user_roles ext_role_permissions ext_roles` 三个一起给时按 `ext_roles` 先、两张子表后发送。
- 移出后深校验项从 160 降到 151（2026-10-22 实测：`DEEP_TABLES` 33 张，检查 151 项 = 86 张行数 + 33 主键哈希 + 30 全列哈希 + 2 引用完整性 + …）。

## 触发器连带写入（决定单日能追平多少条目）

- 本地实测比例（2026-10-26 迁移 0151 之后）：`items` 9,506 行对应派生表 28,821 行（`ext_admin_typeahead_*` 6 张）→ **3.03 连带行 / 条**。退役前是 97,086 行 / 10.21 连带行（多出来的 68,265 行 = 已退役的 `site_search_*` 14 张）。
- `items` 上共 9 条触发器（2026-10-26 实测）：3 条写 `ext_admin_typeahead_*`、6 条把 `ext_book_stats` 与 `ext_marker_citation_state` 的 `computed_at_ms` 置 0（`ext_book_stats_dirty_on_*` 3 条 + `ext_marker_citations_dirty_on_*` 3 条）。
- **单条差异行的实际写代价（2026-10-26 阶段 3 实测，`.scratch/d1-sync-20261026/stage3-items.txt`）**：补推 1,574 条差异行 = 3,148 条语句（每行 1 DELETE + 1 INSERT）分 158 批发送，回报 `rows_written` 合计 **50,082** ⇒ **31.82 行写 / 条**。分批回报的分布显示两侧不对称：工具先发全部 DELETE 再发全部 INSERT，按每批 20 条算，前 78 批（DELETE 段）每语句 3~4 行写、合计约 5,310，其后（INSERT 段）每语句 28~29 行写、合计约 44,772。此前按「派生 3.03 连带行 + 脏标记 ≤4」推得的 8.06~12.06 行写/条被这次实测推翻：FTS5 影子表的一次 INSERT 会同时写 `_content`/`_data`/`_docsize`/`_idx` 四张内部表并按 segment 追加，代价远高于按行数外推。
- 单日上界按实测 31.82 算：未占用写额度时 100,000 / 31.82 ≈ **3,142 条**；2026-10-26 当天已烧 50,374 行写（阶段 3 两批：188 + 50,082，加上定向补推三张小表 80 + 24），剩 49,626 行写 ⇒ 当日只能再追平 ≈ **1,559 条**。⇒ **整表 9,506 条差异一天内追不完**（9,506 × 31.82 ≈ 302,480 行写），只在 `--dry-run` 报出差异行、并按首批 `rows_written` 回报外推确认剩余额度够时才推。
- 小表没有该瓶颈：`themes` 全表重推 24 行写（12 行 × 2，该表无触发器）、`theme_state` 2 行写、`channels` 每行 3 行写（`channels_genre_mirror_after_insert` 在 INSERT 后同事务再 UPDATE 一次 `genre`）、判定范围内 37 张内容表（不含 `items`）整表重推 502 行写 = 日额度的 0.5%。
- **外键级联（`ON DELETE CASCADE`）会被「DELETE+INSERT 整行替换」触发。** 2026-10-22 全库实测（`.scratch/d1-sync-20261022/probe-fk-all-edges.stdout.txt`：88 张表、29 条外键边、23 条 CASCADE / SET NULL）：以 `auth_user(id)` 为父的 CASCADE 边 **12 条**（`auth_account`、`auth_session`、`ext_app_login_log`、`ext_user_devices`、`ext_user_roles`、`ext_user_security`、`oauth_access_token`、`oauth_client`、`oauth_connection`、`oauth_consent`、`oauth_refresh_token`、`passkey`），`ext_roles(role_id)` 出 2 条（`ext_role_permissions`、`ext_user_roles`），`ext_permissions(id)` 出 1 条（`ext_role_permissions`），`oauth_client(clientId)` 出 4 条，`webhook_endpoints(id)` 出 1 条（`webhook_subscriptions`）。补推 `ext_roles` 里 1 行时，远程把指向该角色的 23 条权限行与 2 条用户角色行一并删掉，本地 62/4 对远程 39/2。
- ⇒ 阶段 3 的补推必须**先父表、后子表，并在推完子表后重新跑一次阶段 4**；只看父表本身的行数与哈希查不出这种丢失。`sync-tables.mjs` 已把这条做成护栏：从本地库读全部 `ON DELETE CASCADE` 边，父表在对象里而子表不在 → 退出码 `2` 中止并列出缺失子表（运行态子表给 `[注意]` 提示后放行，懒建索引与环境绑定子表豁免）；父子同在时按级联深度排序，父表先发。

## 额度纪律与本地读取

- 派生索引重建的连带写入来源：触发器往 `ext_admin_typeahead` 逐字索引写海量 token 行；`site_search_*` FTS 表族已随迁移 0151 退役（ADR-0051）。写额度耗尽后的报错原文是 `[code:7500] exceeded D1's free tier daily row write limit`。
- 首批 `rows_written` 回报用于外推剩余量；外推总量超过当日剩余额度即刻停止，剩余行改期，绝不整表补跑。
- 本地库在同步与核对全程只读（探针与两个同步工具一律 `{readOnly: true}`，工具自身只发远程语句）。读取必须经 SQLite 打开（WAL 模式自动生效），不复制文件、不以文件时间戳代替内容判断。
- **本地 dev server 在跑的时候，「本地为标准」是一个时间点**：本地 Worker 会持续写登录流水、审计与派生表。2026-10-22 实测：主文件 89,976,832 字节、WAL 0 字节（07:25 由本地 dev server 检查点写入，该进程不属于同步流程，也不得停止）。2026-10-26 复测：主文件同样 89,976,832 字节、WAL 0 字节，`page_count` 21,636 / `freelist` 13,123，按页算的实际占用 34,869,248 字节。阶段 4 报告只代表它生成的那一刻；要确认当下状态就复跑阶段 4。
- 2026-10-22 一次完整执行的额度实测：远程读取按**返回行数下限**计 36,664 行 / 574 次调用（阶段 2 的 89 行 + 阶段 4 三次深校验的 12,211 / 12,157 / 12,207 行；该口径不含 `COUNT(*)` 与全表扫描实际烧读的计费行，真实读量更高，见下一条），占 5,000,000 行/日 的 0.73%；远程写入 862 行（阶段 3 三轮、18 个批次回报之和，含索引维护），占 100,000 行/日 的 0.86%。`yarn manage deploy` 不回报写入行数，所以阶段 1 的迁移写入量始终是推断值。
- 2026-10-26 一次完整执行的额度实测（时刻取各输出文件的 mtime，UTC）：远程写入 **50,374 行**（批次 A 8 个批次 188 行（10:30:45）+ `items` 158 个批次 50,082 行（10:31:56）+ 定向补推三张小表 80 行（11:12:13）+ 幂等补发 24 行（11:17:14）），占 100,000 行/日 的 **50.4%**。远程读取：第一次 `[code:7500] Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.` 出现在 11:12:13，而 10:45:00 的只读探针还能正常返回，所以打满发生在 10:45–11:12 之间；此前写的「当日合计 ≈121,000 行，占 2.4%」是按 `sync-tables.mjs` 分页 OFFSET 上界外推的估算，与「已打满 5,000,000」的报错相差 40 倍以上，作废。
- 2026-10-27 一次完整执行的额度实测（差量口径，逐步记录 `meta.rows_read`，明细见 `.scratch/d1-sync-20261027/quantified-report-2026-10-27.md`）：阶段 2 counts 44,219 行 / 77 次、阶段 3 `items` dry-run 54,506 行 / 10 次、阶段 4 深校验 54,545 行 / 140 次、步骤 4 的备份与补推 74 行 / 19 次，调用口径合计 153,344 行；账户级 GraphQL（`d1AnalyticsAdaptiveGroups`，过滤器字段现为 `accountTag`）读到 147,197 行，占 5,000,000 行/日 的 2.94%。远程写入 67 行（0.067%），其中 `channels` 的 12 条语句（6 删 6 插）回报 `rows_written=60`、主频道行 `UPDATE data` 回报 3 行 —— **`rows_written` 把该表的索引条目与触发器重算一并计费**，「每行 3 行写」只是单行删插的估算单位，不能当成一批语句的总量。当日一致性：`items` 与 74 张清单里除 `channels`、`auth_account` 两个已表态例外之外全部一致；`channels` 与 `auth_account` 都是「行数相同、内容不同」，counts 模式查不出这类差异，只有阶段 3 的 dry-run 与阶段 4 的深校验能报。
- **打满 5M 的读取量无法归因到具体步骤，原因是工具没记录一手数据**：D1 REST 响应的 `meta` 里带 `rows_read`（11:18:37 实测 `.scratch/d1-sync-20261026/probe-meta-rowsread.stdout.txt`：`SELECT COUNT(*) FROM ext_menu` 回报 `rows_read=36`，正好等于该表行数 ⇒ `COUNT(*)` 按行扫描计费；11:24:51 按主键 `IN (4 个)` 取 `ext_book_status` 回报 `rows_read=8` ⇒ 走主键索引的定向读只按命中行计费，2 行读/返回行）。三个工具原先都只累加 `meta.rows_written`、把 `rows_read` 丢掉，`reconcile-local-remote.mjs` 甚至写着「本账户响应不含 meta 字段」并用**返回行数**当读量，所以 2026-10-22 那两条「读取 36,664 / 70,570 行」是返回行数下限，`COUNT(*)` 与全表扫描烧掉的计费行一条都没计进去，真实量必然更高（高多少无从引用）。归因要从已补上的计数取，候选消耗方按代价排序：① `items` 的 3,148 条补推语句，`rows_written` 实测 31.82 行/条 ⇒ 每条语句在 `ext_admin_typeahead_*` 与 `items` 索引上做几十次读写，触发器侧是否有走不上索引的读是唯一没测的环节，下一次执行按批打 `rows_read` 就能判定；② `manage deploy` 里 `prepareItemSearch`→`normalizeItemSearchContent`（`manage-cli/lib/item-search.ts:170-201`，谓词含列比列 `content_text_updated_at != updated_at` 与 `content_text_revision != N` 的 OR，任何索引都用不上，代码内注释 D1SCAN-001 已承认接受全表扫描；每次调用至少「扫到 0 行的收尾一轮 9,506 行 + 末尾 COUNT 9,506 行」，`deploySupport.ts:333/373/399` 三个调用点 ⇒ 单次部署 ≥57,036 行，当天两次部署尝试 ≈114,000 行）；③ `sync-tables.mjs` 的远程分页快照（10:28:45 的 dry-run 与 10:31:56 的正式各一轮）；④ 阶段 4 深校验（10:33:30 一次，32 张表全量读）。②③④ 三项相加的量级仍在十万级。22:54 的归因探针（`.scratch/d1-sync-20261026/probe-read-attribution-20261026.mjs`）补上了 ② 的最坏形态：归一化「全部脏」时单调用点计费读 ≈926,306 行、三个调用点 ≈2,778,918 行，当天两次部署尝试 ≈5,557,836 行，超过 5,000,000——与「10:45–11:12 之间打满」量级吻合，判定为读额度打满的最可能来源（部署日志不回报 `rows_read`，属间接证据）。**这只解释读侧；`items` 的内容差异不由它解释**——2026-10-26 23:40 本地实测 `content_text_revision` 9,506 行全部 = 1、按部署谓词的本地脏行 0 行（本地早已全部归一化），且 10-26 实际差异是 dry-run 报出的 1,574 条（已全部推送并逐批验证），「9,506 条差异」是把全表行数误当差异基数。1,574 条的差异列与改动侧别未逐列定位，再次出现时先按本节「报出真不一致时先确定改动在哪一侧」的流程定位，不盲目推送。
- **读额度的拒绝是间歇性的，小读在大读被拒之后仍能成功**：11:12:13 一个 16 条语句的写批因读额度整批被拒；11:17:14 一个 8 条语句的写批成功（`rows_written=24`）；11:18:37 一次 `COUNT(*)`（36 行读）成功；11:20:13 取 10 行成功、紧接的取 4 行被拒；11:20:58 取 4 行成功、紧接的取 4 行被拒；11:24:51 取 4 行成功。所以「一次被拒」不等于当天作废，「一次成功」也不等于恢复：核对类操作一次只发一条语句、失败就换更小对象重试，别把已验过的行重复读。
- **一个 `{batch}` 请求是全有全无的**：定向补推 36 条语句分 2 批，第 1 批 20 条提交（`rows_written=80` `changes=20`），第 2 批 16 条被读额度整批拒绝，远程只有第 1 批生效。补发用幂等形态：把 `INSERT INTO` 改写成 `INSERT OR REPLACE INTO` 并跳过 `DELETE`（`push-known-rows.mjs --skip=20 --replace`，8 条语句 `rows_written=24` `changes=8`）——无论被拒的那批里有没有半生效，结束状态都是本地行内容，且省掉 `DELETE` 自身的读取。当天 11:12:13 被拒时写额度还剩 49,730 行 / 100,000，拒它的是**读**计数，所以发批前只核写额度够不够是不够的。
- 同日修复环境绑定数据后的累计实测：再加三次深校验 13,208 行 / 157 次 + 10,349 行 / 152 次 + 10,349 行 / 152 次（后两次是移出 `ENV_BOUND` / `LAZY_INDEX` 之后的口径），以及远程删两行（`ext_cloud_usage_token`、`microfeed_installation` 各 1 行，`meta.changes = 1` / `rows_written = 1`）。当日合计远程读取（返回行数下限，同上条口径说明）70,570 行 / 1,035 次调用，远程写入 864 行（0.86%）。
- 运行态表（两侧 Worker 各自写入的登录流水、审计、会话、nonce、设备）按口径跳过，不追平；要求逐行一致必须先停止生产写入。

## 远程操作的授权

- 阶段 0 / 2 / 4 的只读查询、阶段 1 的部署、阶段 3 的补推，都要用户当场指令；执行前复述命令、影响范围与写入行数。
- 部署从当前工作树构建，未提交的改动会一同上线；要让生产只运行已提交代码，先完成手动提交再部署。

## 主题写库必须用绑定参数（完整条文）

`AGENTS.md` 常驻区只保留这条规则的四条结论，以下是完整条文与量化理由。数字与常驻区同源，改动时两处一起改。

- 一切向 `themes` / `theme_drafts` 写行的代码——Worker `src/server/themes/ThemeStore.ts`、管理 CLI `manage-cli/theme.ts`，以及任何后续新增的主题安装 / 发布 / 草稿 / 迁移路径——都必须使用**绑定参数**：SQL 里只写 `?` 占位，值经 `.bind(...)` / `queryD1WithParameters(...)` 传。严禁把 `bundle_json` 等大列用模板插值拼进 SQL 字面量。
- 理由（量化）：D1 对**单条 SQL 语句的字面量长度有上限，实测约 100KB**（75KB 可通过、135KB 报 `SQLITE_TOOBIG`）。中文主题 `feed-zh` 的 `bundle_json` 按 2026-10-26 本地 `themes` 表实测：未删除 9 行最大 **119,974 字节**（激活行 `local.feed-zh@0.1.54`）、合计 513,506 字节；含 3 行墓碑的 12 行最大 121,180 字节、合计 816,400 字节。按字面量拼必失败；绑定参数不计入 SQL 文本长度，可正常入库。
- **安装主题时的确认动作**（每次 `manage theme install`、后台安装、草稿发布之前都要做）：确认写 `themes` / `theme_drafts` 的 SQL 文本只有 `?` 占位、`bundle_json` 与 `preview_fixture_json` 全部经绑定参数传入。绑定参数不计入 SQL 文本长度，所以 2026-10-26 本地实测最大 **119,974 字节**（墓碑行内 121,180 字节）的 `bundle_json` 不占用语句文本，一条 INSERT 即可入库；只要看到 SQL 文本里出现大列内容或者分块 UPDATE 拼接，该次安装通道不合格，先改造通道再执行。
- 该不变量由 `tests/unit/theme-install-bound-params.test.ts` 守护：写 `themes` / `theme_drafts` 的 INSERT SQL 中不得出现 `${` 插值。
- **数据同步场景同样适用**：本地→远程同步、整库覆盖、差量补推等一切向 `themes` / `theme_drafts` 写行的路径（含 `.scratch` 下的一次性同步脚本、D1 REST 批量接口）都必须走绑定参数——SQL 文本只写 `?` 占位，值经 `.bind(...)`、`queryD1WithParameters(...)` 或 REST `{sql, params}` 传。把大列拼成 SQL 字面量（`VALUES ('<大列文本>')`）、以及「占位 INSERT + 分块 UPDATE 拼列」都是历史应急通道，不作为常规方案。
- **安装或同步主题前的确认清单**（三条全部满足才算通过）：① 写库 SQL 文本中只有 `?` 占位、无任何大列字面量；② 全部值（含 `bundle_json`、`preview_fixture_json`）经绑定参数传递；③ 预期效果：feed-zh 整行 `bundle_json`（2026-10-26 本地实测未删除行最大 119,974 字节、9 行合计 513,506 字节）**一条 INSERT 即可入库**，不出现为绕过文本长度上限而做的分块 UPDATE。若不满足（例如拿到的是字面量 SQL 文件），先改造通道再执行。
- 通道级护栏（2026-10-26 写进工具）：`sync-tables.mjs` 的 `sendBatch()` 在发任何一批之前逐条校验「`?` 个数 == `params` 个数」且「单条 SQL 文本 ≤64KB」，任一条不满足直接抛错、不发起远程调用。后台安装通道另有 `tests/unit/theme-install-bound-params.test.ts`。
- 主题的 CSS/JS 资产全在 `themes.bundle_json` 内（2026-10-26 本地实测 12 行的 `json_array_length(bundle_json,'$.assets')` 均为 0，本地 media 桶只有 1 个 APK 对象），所以跨环境同步主题只需要推 D1 行，不需要配套搬 R2。
- **同步额度纪律**（2026-10-18 实测教训）：单表同步失败不得触发全表补跑——整表重推会把日写额度（100,000 行）翻倍烧光；核对通过即零写入；一次到位、不重推。
