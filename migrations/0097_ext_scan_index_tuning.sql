-- 0097: items 补 Feed 排序索引，日志 / API Key 表补时间索引
--
-- 背景：公开 Feed 的取数（src/server/feed/FeedDb.ts 的 `_getContent` + `orderBy`）
-- 拼出的是双键排序：
--   ORDER BY <col> <dir>, id <dir>
-- `col` 取自 ITEM_SORTS 三种取值 → items 表列 `pub_date` / `updated_at` /
-- `created_at`（src/shared/ItemPagination.ts `ItemSortDefinition.column`）。
-- 这三列此前各只有一个「单列索引」（items_pub_date / items_updated_at /
-- items_created_at），且没有一个以 `status` 打头。于是 Feed 的
-- `WHERE status = 1 ORDER BY pub_date DESC, id DESC` 只能：
--   SEARCH items USING INDEX items_status (status=?)
--   USE TEMP B-TREE FOR ORDER BY
-- 即先按 status 拉出全部 9,520 行 published，再为 20 条/页的 LIMIT 建临时
-- B-TREE 排序。这是全站最热的查询，也是最贵的一次排序。
--
-- 做法：每个可排序列各建一个三列复合索引 `(status, <col>, id)`。
-- 前两列满足等值前缀 + 第一排序键，第三列 `id` 是第二排序键，
-- 三者齐备才把 TEMP B-TREE 彻底消掉：
--   SEARCH items USING INDEX items_status_pub_date (status=?)
--
-- 为什么必须是三列、不能用两列：两列 `(status, pub_date)` 实测仍残留
-- `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`——它只能吃到第一个排序键，
-- `id` 那个键还是要临时排序。第三列 `id` 是 8 字节，代价可忽略。
--
-- 为什么三个都要：三种排序全部可达，不是死分支——
--   pub_date    默认值（normalizeItemSort 的 fallback = ITEM_SORTS.PUBLISHED_AT），
--               公开首页 / 翻页 / 上一页反向查询 / 游标分页都走它；
--   updated_at  admin-list.ts 的默认排序、middleware.ts 的后台序、
--               后台设置页 ItemsSettingsApp 的下拉选项；
--   created_at  后台设置页下拉选项、AllItemsApp 的「创建时间」列排序。
-- 游标分页的两种方向（下一页 `pub_date < ?`、取上一页 `pub_date > ?`）
-- 都实测走同一索引，无需额外索引。
--
-- 保留而不删旧的单列索引：`items_pub_date` / `items_created_at` /
-- `items_updated_at` 服务的是「不带 status 前缀」的查询，例如
-- src/server/feed/extBook.ts 的 `WHERE status IS NULL OR status != ?
-- ORDER BY created_at ASC`——`status` 不是索引前缀时三列复合索引帮不上忙。
-- 两者互补，不是重复。`items_status` 同理保留。
--
-- ⚠️ 必须同步把 items_book_id 升级为 `(book_id, status)`：
-- 本库没有 sqlite_stat1 / sqlite_stat4（从不做 ANALYZE），规划器只能用
-- 「索引页数」这类粗粒度启发式选索引。只加三列复合索引会让
-- `WHERE status = 1 AND book_id = ?` 改走 `items_status_*` 的 `status=?` 前缀，
-- 把 book_id 降级成残余过滤——实测单本查询从 2.0 ms 涨到 13–20 ms，且耗时
-- 与书的大小无关（每次都读满 9,520 行 published），正好把 F1/F2 的收益吃光。
-- 把第二个谓词 `status` 也塞进索引后，`book_id=?` 只命中约 7.7% 的行，
-- 比 `status=1` 的 99.97% 窄得多，启发式才稳定选回 book_id 前缀，且
-- `status` 也一起被索引吃到（不再做残余过滤）。这一步用结构而非统计解决，
-- 不受 stat1 过期影响。
--
-- 附带两项小修：
--   * ext_api_access_log 是全库唯一的增长型表（90 天保留，当前 2,349 行），
--     之前有三个 `_credential` / `_key` / `_user` 索引，唯独缺 `created_at_ms`。
--     清保留期时 `DELETE FROM ext_api_access_log WHERE created_at_ms < ?`
--     只能 SCAN 全表；这一条把删除改造成索引范围删除。
--   * api_keys 只有 autoindex，`listApiKeys` 的
--     `ORDER BY created_at_ms DESC, id DESC` 实测 `SCAN api_keys` +
--     `USE TEMP B-TREE FOR ORDER BY`。同样是双键，所以第二列要带上 `id`。
--     该表行数极少，属于顺手补齐，不是性能瓶颈。
--
-- 全部 `CREATE INDEX IF NOT EXISTS`，可重复应用。唯一例外是 items_book_id 的
-- 「重建」：`IF NOT EXISTS` 改不了已有索引的列，只能先删后建，与 0091 的做法
-- 一致。删与建是同一逻辑名，应用代码不受影响。
--
-- 回滚（若需）：`DROP INDEX` 掉新增的四条 + 最后两条，再把 items_book_id 还原成
-- `ON items (book_id)` 即可。索引是纯冗余结构，删掉不丢任何数据。

DROP INDEX IF EXISTS items_book_id;
CREATE INDEX IF NOT EXISTS items_book_id
  ON items (book_id, status);

CREATE INDEX IF NOT EXISTS items_status_pub_date
  ON items (status, pub_date, id);

CREATE INDEX IF NOT EXISTS items_status_updated_at
  ON items (status, updated_at, id);

CREATE INDEX IF NOT EXISTS items_status_created_at
  ON items (status, created_at, id);

CREATE INDEX IF NOT EXISTS ext_api_access_log_created_at_ms
  ON ext_api_access_log (created_at_ms);

CREATE INDEX IF NOT EXISTS api_keys_created_at_ms
  ON api_keys (created_at_ms, id);
