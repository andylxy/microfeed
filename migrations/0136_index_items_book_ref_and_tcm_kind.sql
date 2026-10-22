-- 0136_index_items_book_ref_and_tcm_kind.sql
--
-- 0136: items 增加两个「筛选列 + 更新时间」复合索引
--
-- 1) ix_items_book_ref_updated 服务后台内容列表按书 / 按分类翻页。
--    书引用表达式与 src/server/items/admin-list.ts 的 bookRef 是同一形态
--    （查询侧的 `items.` 表限定符不影响匹配，`EXPLAIN QUERY PLAN` 已确认走该
--    索引）：`_microfeed.sourceBookId` 优先，缺失时改用 `_microfeed.bookId`。
--    分类筛选按书分成 UNION ALL 分支后，每条分支都是
--    `bookRef = ? ORDER BY updated_at DESC, id DESC LIMIT n`；索引首列是同一个
--    CASE 表达式，后两列直接提供排序，过滤与取数共用一次索引查找。
--    改造前单条语句走 `SCAN items USING INDEX items_updated_at`，本地 9,506 行
--    全表扫描（dbstat 18,395,136 字节 / 4,491 页，`probe-facts17.mjs`）；改造后
--    分支语句用
--    `INDEXED BY ix_items_book_ref_updated` 固定计划为
--    `SEARCH items USING INDEX ix_items_book_ref_updated (<expr>=?)`——不加该
--    约束时，带具体状态、按 created_at / pub_date 排序的查询会改选
--    items_status_created_at / items_status_pub_date，按状态顺序扫描完整个状态
--    （每分支最多 9,506 行）。默认 limit 20 且状态与 tcmKind 匹配前 21 行时
--    每本书读取 21 行（含回看一行）：5 本书 105 行、按本地平均 1,935 字节/行约
--    203 KB；索引在 VACUUM 副本上 540,672 字节。按 created_at / pub_date
--    排序时索引只负责按书定位，该书匹配行仍要进临时 B 树（本地单书上界
--    2,964 行；分类内合计最多 4,127 行约 8.0 MB）。
--    本地 items 9,506 行；创建索引写入 9,506 行是按表行数的推得值（只读探针
--    无法取得 `CREATE INDEX` 的 `rows_written`，部署后在远程计量里核对）。
--
-- 2) ix_items_tcm_kind_updated 服务 tcmKind 筛选：
--    `tcm_kind = ? ORDER BY updated_at DESC, id DESC`。现有
--    items_tcm_kind_parent 只有 (tcm_kind, tcm_parent_id)，排序要另外建立临时
--    B-tree；不带状态等值筛选（默认「all」是 status != ?）时本索引让过滤与
--    排序共用一次索引扫描，查询计划从
--    `SEARCH items USING INDEX items_bie_ming (tcm_kind=?)` 加
--    `USE TEMP B-TREE FOR ORDER BY` 变为
--    `SEARCH items USING INDEX ix_items_tcm_kind_updated (tcm_kind=?)`。
--    本地 tcm_kind='section' 8,066 行：旧计划把这些行全部读入临时 B 树
--    （按平均 1,935 字节/行约 15.6 MB），新计划只读取排序需要的 21 行
--    （约 40 KB）。按 created_at / pub_date 排序时 planner 仍选
--    items_bie_ming (tcm_kind=?) 加临时 B 树，本索引不参与；带具体状态等值
--    筛选时改选 items_status_updated_at，tcm_kind 成为残留条件。索引在
--    VACUUM 副本上 503,808 字节。创建第二个索引再写入 9,506 行（同为推得值）。
--
-- 两个索引合计按表行数推得写入 19,012 行，占远程 D1 每日 100,000 行写入额度
-- 的 19.0%。
-- `data` 仍是唯一事实来源；纯索引，不改任何写入路径。
-- 回滚：DROP INDEX IF EXISTS ix_items_book_ref_updated; DROP INDEX IF EXISTS ix_items_tcm_kind_updated;

CREATE INDEX IF NOT EXISTS ix_items_book_ref_updated
  ON items(
    (CASE
      WHEN json_extract(data, '$._microfeed.sourceBookId') IS NOT NULL
      THEN json_extract(data, '$._microfeed.sourceBookId')
      ELSE json_extract(data, '$._microfeed.bookId')
    END),
    updated_at DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS ix_items_tcm_kind_updated
  ON items(tcm_kind, updated_at DESC, id DESC);
