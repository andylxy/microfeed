-- 0107: items 补一条以 status 打头的方剂索引，修回 getAppBookFang 被 0106 引错的查询计划
--
-- 背景：迁移 0106 新建了 `items_yao_order (tcm_kind, status, no, id)`，它让
-- App 中药与派生别名的临时排序得以消除。但它同时改变了方剂查询的计划——
-- `src/server/tcm/reads.ts` 的 `getAppBookFang` 写的是
--
--     WHERE tcm_kind = 'fang' AND status = 1
--       AND json_extract(data, '$._microfeed.sourceBookId') = ?
--
-- 规划器改走 `items_yao_order`，只能 seek 前两列（tcm_kind + status），
-- `sourceBookId` 排在该索引第三列之后，于是把全库 804 个方剂全部读进来，
-- 再逐行过滤 sourceBookId，最后只留 113 行。实测 805 行读 / 返回 113 行，
-- 其中 691 行是白扫。
--
-- 做法：把 `sourceBookId` 提到 `status` 之后，让三个过滤条件一次 seek 完。
-- 与 0092 的 `items_fang_order` 是同形索引，差异只在 `status` 的位置：
--   0092  (tcm_kind, sourceBookId, no, id)             —— 服务 status != ? 的排除式
--   0107  (tcm_kind, status, sourceBookId, no, id)     —— 服务 status = 1 的等值式
-- 两条各服务一种 status 写法，并存保留。
--
-- A/B 实测（本地 D1，同一连接同一数据，各 7 轮取中位数）：
--   现状                         805 行读 / 返回 113 行 / 82.2 ms
--   加本索引                     114 行读 / 返回 113 行 / 86.4 ms
--   删除本索引后回归              805 行读 / 返回 113 行 / 85.7 ms
-- 读数降 85.8%，返回行数一条不变。耗时基本持平——该查询的瓶颈在 JS 侧解析
-- 113 行 data，不在数据库扫描；省下的是 D1 的 rows_read 额度。
--
-- 代价：items 索引 21 → 22。单行 UPDATE 维护开销与既有索引同级，可忽略。
--
-- 纯索引，不改任何写入路径与返回结构。
-- 回滚：DROP INDEX items_fang_order_v2;（纯冗余结构，删掉不丢任何数据）

CREATE INDEX IF NOT EXISTS items_fang_order_v2
  ON items (
    tcm_kind,
    status,
    json_extract(data, '$._microfeed.sourceBookId'),
    json_extract(data, '$._microfeed.no'),
    id
  );
