# D1 查询调优只用显式复合索引，不跑 ANALYZE

本地 D1（`items` 9,506 行）上最贵的两条读取（App 中药全量、派生别名）各要 21~23 ms，
原因是以 `tcm_kind` 过滤、`data` 里的 JSON 字段排序时，规划器退到 `status` 打头的索引，
把整张表捞出来再建临时 B-tree 排序。我们决定用两条「过滤列 + 排序键」复合索引
（迁移 0106）直接给出查询所需的顺序，并且**明确不通过补统计信息（`ANALYZE`）来让规划器自己选对**。

## 背景

本库从来没有 `sqlite_stat1`，规划器只能靠索引页数这类粗粒度启发式挑索引。
`items.status` 在本地又恰好只有 1 个取值（`1` = 9,506 行），`status` 打头的索引
没有任何收窄能力，规划器却因为它看着像可用索引而优先选它。

## 决策

新增两条复合索引，把过滤列放最左、把查询实际书写的排序表达式原样跟进：

- `items_yao_order (tcm_kind, status, json_extract(data,'$._microfeed.no'), id)`
- `items_section_order_kind (tcm_kind, tcm_parent_id, json_extract(data,'$._microfeed.receiptNo'), id)`

实测（副本，9 次中位数）：三条热查询合计 43.82 ms → 1.36 ms（−96.9%），返回行数不变；
单行 `UPDATE` 2.993 → 3.001 ms（+0.3%）。

## 考虑过的其他做法

**补 `sqlite_stat1`（跑 `ANALYZE`）**：实测让四条查询变好，同时让待审队列
（`src/server/feed/extReview.ts:171`）从 ~0 ms 退到 14.81 ms——规划器拿到统计后
改走 `SCAN items USING INDEX items_updated_at`，为一个空结果集扫满 9,506 条索引项。
统计信息会整体翻转计划，收益不可预测，因此不采纳。D1 是否允许 `ANALYZE` 也未经确认。

**改写查询（去掉 `ORDER BY` 或改排序键）**：两条排序键都决定 App 端下发的条目顺序，
改顺序会改变客户端可见结果，风险高于加索引。

**给离线重索引回填（`manage-cli/lib/item-search.ts:158`）加索引**：该脚本本就要扫全表
并按批推进，加索引只会让它变慢（实测 +7%），保持原样。

## 后续影响

- items 索引 19 → 21；写入放大可忽略（低频人工编辑）。
- 43 条小表（≤101 行）全表扫描保留原样，那些表一页内存装得下，走索引反而更慢。
- 若日后有人想删 `items_status` / `items_review_status`（本地 100% 无收窄能力），
  必须先在生产库复核这两列的取值分布，本地数据比生产干净。
- 本决策只覆盖索引。库文件 `VACUUM` 可回收 31.9 MB（85.8 → 53.9 MB），属独立运维动作。
