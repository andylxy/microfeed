# ADR-0070: 清理退役看板遗留的无活跃调用索引与孤儿数据层

ADR-0069 退役 6 个 legacy 内容看板、ADR-0068 退役 alias 模块后，`items` 表上一批专为看板查询建立的索引失去了全部活跃调用方，`extVolume` / `extFang` / `extTcmEntries` / `tcmSections` 四个 feed 数据层文件与 `extCategory` 的 6 个 TCM 专用函数成了无活跃调用者的孤儿代码。本决策删除这些不再被任何活跃查询使用的索引（5 个 DROP + `items_book_kind` 回退去掉 0116 追加的 `tcm_parent_id`），并删除对应的孤儿数据层文件与函数；不删任何表、不动任何仍有活跃调用方的索引与公开函数。

- 状态：Accepted（2026-11-09 实施完成；迁移 `0193` = commit `a705b3e`，代码删除提交 = commit `913b2d6`，见「实施范围」）
- 关联：ADR-0069（退役 6 看板，决策 1/2 保留共享数据层——本决策是其后清理，不推翻「不删表」）、ADR-0068（退役 alias，`DROP TABLE ext_tcm_aliases` 后无遗留索引）、ADR-0025 / 0027（卷看板与索引取舍）、迁移 0091（删除冗余索引先例）、0092 / 0094 / 0095 / 0107 / 0108 / 0112 / 0116 / 0136（本决策涉及索引的建迁）
- 证据范围：本地真库只读探针 2026-11-09，实例 `ctwh-881019-xyz`（主库 `e60aa88…`，80 表 / 148 显式索引 / 台账 190 条止 0192）；代码调用链只读调查（`src/server/feed/*`、`src/server/tcm/reads.ts`、`src/server/items/admin-list.ts`、`src/server/api/content-read.ts`）

## 背景

ADR-0069 退役的是 6 个看板的**页面 / ajax / 组件 / handler**（0191 提交：6 看板组件 + 19 ajax 端点 + 4 handler + 4 个 `volumes-*.test.ts`），按决策 1/2 **不删表**，`items` / `channels` / `ext_category` 与 6 个 feed 数据层文件全部保留。但「保留文件」不等于「保留调用链」：看板删除后，一部分数据层函数失去全部调用方，成为孤儿；它们服务的索引于是也不再被任何活跃查询使用。

ADR-0068（0190）退役 alias 模块是 `DROP TABLE ext_tcm_aliases`——索引随表消失，**无遗留索引**，不在本决策范围。

## 无活跃调用索引（5 个 DROP）

调用链判据：索引服务查询的「唯一活跃调用链」已断（函数 0 调用者，或文件 0 导入者，或 App 查询已改走同形新索引）。全仓库无 `INDEXED BY` 显式引用（仅注释与 `frozen-migration-names.txt` 迁移名登记，非引用）。

| 索引 | 建迁 | 原服务查询 | 无活跃调用链的证据 |
|---|---|---|---|
| `items_section_order` | 0094 | `extVolume.ts`「按篇章取条文」 | `extVolume.ts` 仅 `listVolumeBooks` 被 `extFang.ts` 用，`extFang.ts` 0 导入者 |
| `items_book_entries_order` | 0095 | `extCategory.ts` `getTcmBookEntries`「书页目录取条目」 | `getTcmBookEntries` 0 调用者（定义即孤儿） |
| `items_fang_order` | 0092/0095 | `extFang.ts` + `getTcmBookFang`「status ≠ ? 方剂」 | 活跃文件 0 引用（App 方剂 `getAppBookFang` 已改走 `items_fang_order_v2`） |
| `items_section_order_kind2` | 0108 | `tcmSections.ts` `fetchSectionsByParents`「书页目录 COALESCE 排序」 | 只被无活跃调用链用（`getTcmBookChapters` / `getBookVolumes` / `getVolumeSections` / `listVolumeEntries`） |
| `items_source_book_id` | 0092 | `getAppBookFang` 早期版「单列 sourceBookId」 | 0107 已由 `items_fang_order_v2` 取代，无活跃单列查询 |

**保留（有活跃调用方）**：`items_bie_ming`（`getDerivedYaoAliases`）、`items_yao_pure_name`（中药标记解析）、`items_yao_order`（`getAppAllYao`）、`items_section_order_kind`（`reads.ts` 章节条文，裸 `receiptNo` 排序）、`items_fang_order_v2`（`getAppBookFang`）、`items_tcm_kind_name`、`ix_items_book_ref_updated` / `ix_items_tcm_kind_updated`（`admin-list.ts`）及通用 `items_status*` / `created_at` / `updated_at` / `pub_date` / `book_id` / `review_status`。

## items_book_kind 回退（去掉 0116 追加列）

`items_book_kind` 现为 `(book_id, tcm_kind, status, pub_date, tcm_parent_id)`（0112 加 `pub_date`、0116 加 `tcm_parent_id`）。`tcm_parent_id` 只为「卷看板逐卷计数」（`tcm_kind != 'chapter' GROUP BY tcm_parent_id, tcm_kind`，已无活跃调用）；App「书页最近更新」（`book_id = ? AND tcm_kind = ? AND status = ? ORDER BY pub_date DESC LIMIT 1`）只用前 4 列，0112 已实测回退到 4 列形态不损该查询。回退 = 重建为 `(book_id, tcm_kind, status, pub_date)`（0112 形态）。

## 孤儿数据层（代码删除）

| 对象 | 类型 | 无活跃调用证据 |
|---|---|---|
| `extVolume.ts` | 整文件 | 6 导出函数，仅 `listVolumeBooks` 被 `extFang.ts` 用（后者 0 导入者） |
| `extFang.ts` | 整文件 | 0 导入者 |
| `extTcmEntries.ts` | 整文件 | 0 导入者 |
| `tcmSections.ts` | 整文件 | `fetchSectionsByParents` 只被 `extCategory.ts` / `extVolume.ts` 的孤儿函数用 |
| `extCategory.ts` 内 `mapTcmSectionRow` + 6 函数 | 函数级 | `getTcmBookChapters` / `getBookVolumes` / `getVolumeSections` / `getLatestBookSection` / `getTcmBookFang` / `getTcmBookEntries` 均 0 调用者；`mapTcmSectionRow` 只被其中两个用；公开函数（`getBookById` / `getBookChapters` / `listCategoryNav` / `listChannelsByGenre` / `getCategoryBySlugOrId` 等）**不调用**它们（676/964 行仅注释提及），删除不影响公开函数 |
| `tests/unit/server/extVolume.test.ts` | 整文件 | 全部用例测卷功能（无活跃模块） |
| `tests/unit/server/extCategory.test.ts` | 行级 | 删 3 个 import（`getBookVolumes` / `getTcmBookEntries` / `getVolumeSections`）+ 3 个 describe（`TCM flat-entry books` / `getBookVolumes` / `getVolumeSections`）；保留 `novel-cms public categories` describe |

## 实施范围

1. **D1 迁移 `0193_index_drop_retired_dashboard_indexes.sql`**（`index` 类，MIG-003 合法、MIG-004 不强制 rollback 块）：`DROP INDEX` 5 个 + `items_book_kind` 原地重建去 `tcm_parent_id`；文件头注释写清回滚方式（重建 5 索引 / 加回 `tcm_parent_id`）与「纯结构、不丢数据」。删前先导出 5 索引 + `items_book_kind` 完整 `CREATE` 定义到 `.scratch/backups/` 作回滚依据。
2. **代码删除提交**（与迁移分开提交）：删 4 文件 + `extCategory.ts` 删 import / `mapTcmSectionRow` / 6 函数 + 测试调整（删 `extVolume.test.ts`、改 `extCategory.test.ts`）。
3. **验证**：`migrations:check` OK；`tsc --noEmit` exit 0；`source-architecture` / `AdminReturnTarget` / `admin-page-guards` 等既有测试绿；删后对保留索引（`items_section_order_kind` / `items_fang_order_v2` / `items_book_kind` 4 列形态）跑 `EXPLAIN QUERY PLAN` 确认无活跃查询受损。**已实测**（0193 应用到快照副本 `e60aa88…`）：`items` 索引 25 → 20；4 个活跃查询——fang-references 草稿 / App 书页最近更新 / extBook 章 id / reads 682——全部仍命中 `items_book_kind`，无任何活跃查询受损。

## 后果

- `items` 索引数 25 → 20（含 1 个 `sqlite_autoindex_items_1` 隐式索引；5 个 DROP + `items_book_kind` 原地重建，净减 5）；写入放大下降，D1 写额度与 `rows_read` 受益。
- `items` 表与全部数据**不删**（ADR-0069 决策 1/2 不变）；App 8 端点与前台独立引擎的活跃查询不受影响。
- 孤儿数据层文件删除后，若未来要恢复卷 / 方剂 / 术语管理，需从 git 历史取回文件（文件本身是领域知识，删除是刻意为之，非数据丢失）。
- 「无活跃调用链」判据基于当前代码；若未来新增查询重新用到某列组合，需重建对应索引（回滚方式已在迁移注释写明）。
