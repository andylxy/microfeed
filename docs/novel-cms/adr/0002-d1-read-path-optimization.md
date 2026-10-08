# ADR-0002: D1 读路径优化（批处理 / 窄投影 / 表达式索引）

- 状态：Accepted（已实施）
- 日期：2026-10-08
- 决策人：用户 + 设计评审
- 关联设计：`.scratch/microfeed-db/adr/0001-d1-read-write-index-review.md`（Tier 1 修复清单 F1–F9）、`.scratch/microfeed-db/adr/0002-content-write-batch-and-feed-projection.md`（W5 + feed 投影收窄）
- 提交：`9fb77fc`（注：该提交信息误引 ADR-0001，实际对应本 ADR）

## 背景

ADR-0001（`.scratch`）三轮静态审查发现 D1 读路径的多处全表扫描 / 写放大 / filesort / N+1（R1–R6、W1–W5、L1–L3、N1、F7、F8、P2）。这些项不改语义、不改 schema，属 Tier 1 纯收益。另有两个更大重构（审计写与 item 写同批 W5、feed 列表投影收窄）在 ADR-0002（`.scratch`）中单独固定。

## 决策

**D1｜Tier 1 读路径修复一次性实施**：批处理（volume-handlers / rbac-seed / alias upsert / saveRolloutRules 分片 / IN 分片）、窄投影（bookWordCount / extBook / navigationPages / FeedDb 列白名单 ITEM_FEED_COLUMNS）、表达式索引消除 filesort（迁移 0090–0095：FTS 触发器 WHEN、冗余索引清理、bieMing / 源书序 / 条文序 / 书条目+方剂排序索引）、审计写与 item 写同批（W5）、FTS 同步收敛（ItemSearchSql WHEN + UPSERT）。

**D2｜不引入 query logger / 不新增派生真实列**：按 ADR-0001 的 D2/D3 与 G1/G2 保留项，索引化表达式，不改动 schema。

## 依据

- 所有修复项均回代码逐行核实（见 `.scratch` 两 ADR 的证据列与 `execution-results.md` 工单 01–08/10–17 的 done 核对）。
- D1 平台约束（单语句 ≤100 绑定参数、batch ≤1000 语句）由 `D1_MAX_BOUND_PARAMS` 常量 + 分片逻辑固化。

## 影响

- 写放大（FTS 重建、章节批量写）与 D1 越限风险显著下降，语义不变。
- 公开读路径 payload 变小（feed 列表少拉 6 列）；TCM 各读路径消除 filesort（getTcmBookChapters 跨 IN(...) 的 filesort 因 JS 重新分组而保留，正确性不受影响，属已知可接受）。

## 立项边界（Co-landed workstreams，复审发现）

提交 `9fb77fc` 为效率把**三个本应独立立项的工作流**一并提交，记录边界以免后人误读为单一决策：

1. **G3/G4（Tier 2，保留 / 归档 + auth_session 清扫）**：`src/server/maintenance.ts`（新）+ `src/worker.ts` 的 `scheduled` 重写（4 张审计/日志表保留清理 + auth_session 过期行清扫）。这两项在 ADR-0001（`.scratch`）§4 列为 **Tier 2「需 schema/回溯，单独立项」**，本应另有迁移 + 门禁 + 数据校验。它们随本提交一并并入，仅作随行提交；其立项边界、保留策略与回滚仍在 ADR-0001 Tier 2 跟踪，不视为本 ADR 的一部分。
2. **ADR-0002（`.scratch`）内容**：W5（item 写与审计写同批，落在 `src/server/items/service.ts` 与 `extContentReview.ts` 的 `planContentChange`）与 feed 列表投影收窄（`FeedDb.ITEM_FEED_COLUMNS`）属独立决策，由 `.scratch/microfeed-db/adr/0002-content-write-batch-and-feed-projection.md` 固定。
3. **提交信息误引**：`9fb77fc` 的 message 写「ADR-0001 读路径优化」，但已提交的 ADR-0001 是「内容持久化采用 D1（非文件）」（docs/novel-cms/adr/0001）。本 ADR-0002 才是读路径优化的规范文档；历史提交信息不再改写，自此以本 ADR 为准。

## 一致性

- 下游修改若触及上述任一工作流，须各自回溯其立项 ADR（Tier 2 见 ADR-0001 `.scratch`；W5/投影见 ADR-0002 `.scratch`），不得混为一谈。
- 迁移 0090–0095 仍需 `yarn manage migrations apply` / `wrangler d1 migrations apply` 落到本地与远端 D1 才生效。
