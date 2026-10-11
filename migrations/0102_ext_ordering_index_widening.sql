-- 0102: 三个排序索引加宽为 `(列, id)`，消除「不等值 + 双键排序」的 TEMP B-TREE
--
-- 背景：后台条目列表与公开搜索的「最新」取数是双键排序：
--   WHERE status != ? ORDER BY <col> <dir>, id <dir> LIMIT ?
-- `col` 取自 ITEM_SORTS（`pub_date` / `updated_at` / `created_at`）。
--
-- 这三列此前各只有一个**单列**索引（`items_pub_date` / `items_updated_at` /
-- `items_created_at`）。单列索引能给出第一排序键的顺序，但第二排序键 `id`
-- 落空，于是计划里出现：
--   SCAN items USING INDEX items_created_at
--   USE TEMP B-TREE FOR LAST TERM OF ORDER BY      ← 每个并列组都要临时排序
--
-- 为什么 0097 的 `(status, col, id)` 帮不上忙：那三条索引以 `status` 打头，
-- 而这里的前置谓词是 **不等值** `status != ?`（后台要连草稿一起列，只有软删除
-- 才排除）。SQLite 无法把不等值列当作索引前缀用于排序，所以规划器只能退回
-- 单列索引 + 临时排序。实测（本地 D1，items 9,506 行）：
--   Admin 列表 created_at ASC  147 → 36 行读
--   Admin 列表 created_at DESC  51 → 36
--   Admin 列表 updated_at DESC  51 → 36
--   Admin 列表 pub_date  ASC   147 → 36
--   Admin 列表 pub_date  DESC   51 → 36
--   latestItems updated_at DESC 21 → 10（TEMP B-TREE 消失）
--
-- 做法：原地重建为 `(col, id)`，**沿用同名**（与 0097 重建 `items_book_id` 的
-- 做法一致）。索引个数不变，所以写入开销不变；只是每个条目多带一个 8 字节的
-- rowid 后缀。`IF NOT EXISTS` 改不了已有索引的列，故先 DROP 再 CREATE。
--
-- 公开 Feed 不受影响：它走 `status = ?` 等值谓词，命中 0097 建的
-- `items_status_pub_date` / `items_status_updated_at` / `items_status_created_at`，
-- 实测加宽前后都是 21 行读。
--
-- 回滚（若需）：把三条索引改回单列即可，索引是纯冗余结构，删掉不丢任何数据。
--   DROP INDEX items_created_at; CREATE INDEX items_created_at ON items (created_at);
--   DROP INDEX items_updated_at; CREATE INDEX items_updated_at ON items (updated_at);
--   DROP INDEX items_pub_date;   CREATE INDEX items_pub_date   ON items (pub_date);

DROP INDEX IF EXISTS items_created_at;
CREATE INDEX IF NOT EXISTS items_created_at
  ON items (created_at, id);

DROP INDEX IF EXISTS items_updated_at;
CREATE INDEX IF NOT EXISTS items_updated_at
  ON items (updated_at, id);

DROP INDEX IF EXISTS items_pub_date;
CREATE INDEX IF NOT EXISTS items_pub_date
  ON items (pub_date, id);
