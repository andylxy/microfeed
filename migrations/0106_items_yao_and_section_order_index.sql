-- 0106: items 补两条「过滤列 + 排序键」复合索引，消掉 App 中药与章节条文的临时排序
--
-- 背景：中医读取路径的过滤条件都是 `tcm_kind = <常量>` 打头，排序键却都藏在
-- `data` 这个 JSON 口袋里（`$._microfeed.no` / `$._microfeed.receiptNo`）。
-- 现有以 `tcm_kind` 打头的索引（`items_tcm_kind_name`、`items_tcm_kind_parent`、
-- `items_bie_ming`）都不带排序键，规划器于是退到 `items_status_created_at`：
-- 先把 `status = 1` 的全部 9,506 行捞出来，再为**最终要返回的 172 行**建临时
-- B-tree 排序。`EXPLAIN QUERY PLAN` 里写着 `SEARCH items USING INDEX`，看着像
-- 索引 seek，实际 seek 前缀只够定位到整张表，随后付的是一次全量排序的钱。
--
-- 本库 `items.status` 恰好只有 1 个取值（`1` = 9,506 行），这进一步放大了问题：
-- `status` 打头的索引没有任何收窄能力，规划器却因为它"看起来有索引"而优先选它。
--
-- 实测（本地 D1 副本，items 9,506 行；耗时为 9 次中位数）：
--   getAppAllYao        src/server/tcm/reads.ts:631   23.48 ms → 0.43 ms
--   getDerivedYaoAliases src/server/tcm/reads.ts:707  21.12 ms → 0.48 ms
--   章节条文列表         src/server/tcm/reads.ts:405   0.68 ms → 0.41 ms（306 行）
--   三条合计                                          45.28 ms → 1.32 ms
-- 返回行数一条都没变（172 / 172 / 306），省下的是为排序而读进来又丢掉的那些行。
--
-- 为什么两条索引都把 `tcm_kind` 放第一列：本库 tcm_kind 取值高度倾斜
-- （section 8,066 / fang 804 / chapter 447 / yao 172 / term 17），把它放在最左
-- 侧能把候选集直接从 9,506 收到 172（yao）或 306（单个父条文）。
--
-- 为什么第二条用 `receiptNo` 而不是 0094 那条索引的
-- `COALESCE(receiptNo, no)`：章节条文列表（`reads.ts:405`）的 ORDER BY 写的是
-- 裸 `json_extract(data,'$._microfeed.receiptNo')`，表达式与 0094 的
-- `items_section_order` 不完全相同，SQLite 无法证明两者同序，那条索引因此不被
-- 选用。这里按查询实际写的表达式原样建索引，让过滤与排序一次走完。
--
-- ⚠️ 不要跑 `ANALYZE` 来替代这两条索引。实测补上 `sqlite_stat1` 之后：
--   getAppAllYao 20.89 → 0.62 ms（变好）
--   待审队列 src/server/feed/extReview.ts:171  ~0 ms → 14.81 ms（严重变慢）
-- 后者因为规划器拿到统计后改走 `SCAN items USING INDEX items_updated_at`，为
-- 一个空结果集扫满 9,506 条索引项。统计信息让计划整体翻转，收益不可预测；
-- 显式给出索引顺序则无论有没有统计都成立。
--
-- 代价：items 索引 19 → 21。单行
-- `UPDATE items SET updated_at = ?, content_text = ? WHERE id = ?`
-- 实测 2.993 ms → 3.001 ms（+0.3%），本库 items 写入是低频人工编辑，可忽略。
-- 离线重索引回填（`manage-cli/lib/item-search.ts:158`）本就要扫全表，实测
-- 17.97 → 19.16 ms（+7%），是新增索引的正常维护开销，该脚本分批改索引，
-- 不影响单次耗时量级。
--
-- `data` 仍是唯一事实来源；纯索引，不改任何写入路径。
-- 回滚：DROP INDEX items_yao_order; DROP INDEX items_section_order_kind;
--       （纯冗余结构，删掉不丢任何数据）

CREATE INDEX IF NOT EXISTS items_yao_order
  ON items (tcm_kind, status, json_extract(data, '$._microfeed.no'), id);

CREATE INDEX IF NOT EXISTS items_section_order_kind
  ON items (tcm_kind, tcm_parent_id, json_extract(data, '$._microfeed.receiptNo'), id);
