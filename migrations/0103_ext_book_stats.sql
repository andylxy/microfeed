-- 0103: 物化「每本书的章节数 / 字数」到 ext_book_stats
--
-- 背景：首页卡片与后台书库看板都要显示每本书的字数，而「字数」不是任何一行的
-- 字段，是**该书所有条目正文字数之和**。本地实测：要产出 13 个数字，必须读
-- 9,506 行正文（首页 9,547 行读、后台 9,523 行读，产出都只有 13 个数字）。
--
-- 这是聚合语义决定的，不是索引能修的：
--   * 加索引 —— 9,506 是「必须读的行」，不是「找不到的行」，加索引不加不减；
--   * 一条 SQL GROUP BY —— 实测 19,012 行读，比逐本读 9,506 更贵；
--   * ANALYZE —— 实测负收益（会把查询从走索引翻成裸 SCAN items）。
-- 唯一出路是**不再每次重算**：把答案存下来。
--
-- 做法：一张 `ext_book_stats`（行数 = 频道数，本地 13）+ **三个失效触发器**。
--
-- 为什么用触发器而不是应用层写入钩子：`items` 的写入点分散在 6 个文件
-- （FeedDb / items/service / ajax/feed / extContentReview / tcm-entry-handlers /
-- volume-handlers），逐处挂钩子**漏一个就静默漂移**——正是 `bookWordCount.ts`
-- 顶部注释警惕的那类问题。触发器把失效钉在数据层：任何一条 items 写入都会把
-- 对应那本书标记为过期，绕不过去。
--
-- 过期标记用 `computed_at_ms = 0`（而不是比时间戳），读路径只判「是否 > 0」，
-- 不需要时钟参与，也不会因为时钟回拨而误判。
--
-- 读路径（`src/server/feed/bookWordCount.ts` 的 `readBookStats`）：
--   读表 → 缺失或过期的书当场重算一次并写回（懒自举）→ 返回。
--   稳态下每次只读 13 行；某本书被编辑后，只有那本书重算一次。
--
-- ⚠️ 2026-10-11 兼容修正（首次上生产时踩到）
--   远程 D1 上**已经存在**一张 `ext_book_stats`，来自一条已不在本仓库的迁移
--   （`0096_book_word_stats.sql`，2026-10-09 应用）。它的列是：
--     book_id, words_published, chapters_published, words_all, chapters_all, updated_at
--   与本文件原本要建的表（用 `computed_at_ms` 当过期标记）**列名不同**。
--   而 `CREATE TABLE IF NOT EXISTS` 在那种情况下是 **no-op** —— 列永远加不上，
--   读路径查 `computed_at_ms` 会直接报 `no such column`，**生产首页会 500**。
--   首次部署正是被这一点（以及 0101 的非幂等 INSERT）拦下的。
--
--   所以改成两步，**全新库与既有库都能跑**：
--     1. `CREATE TABLE IF NOT EXISTS` 按既有库的形状建（含 `updated_at`）；
--     2. `ALTER TABLE ... ADD COLUMN computed_at_ms` 追加过期标记列。
--   全新库：第 1 步建表、第 2 步加列。既有库：第 1 步 no-op、第 2 步加列。
--
--   为什么是加法而不是 DROP + 重建：`manage deploy` **先应用迁移、几分钟后才发布
--   新 Worker**。这期间旧 Worker 仍在读这张表，重建会让它在窗口内报错。
--   `updated_at` 本仓库读路径不使用，保留它纯粹是为了不在窗口里打断旧 Worker。
--
--   `NOT NULL DEFAULT 0` 让既有行全部落在「过期」上 → 读路径自愈重算，值随之收敛。
--
-- 回滚（若需）：`DROP TRIGGER` 掉三个 + `DROP TABLE ext_book_stats`。
--   表和触发器都是纯派生结构，删掉不丢任何原始数据（正文都在 items 里）。

CREATE TABLE IF NOT EXISTS ext_book_stats (
  book_id            VARCHAR(11) PRIMARY KEY,
  -- 公开口径：只算 status = 1
  words_published    INTEGER NOT NULL DEFAULT 0,
  chapters_published INTEGER NOT NULL DEFAULT 0,
  -- 后台口径：连草稿一起算，只排除 status = 3
  words_all          INTEGER NOT NULL DEFAULT 0,
  chapters_all       INTEGER NOT NULL DEFAULT 0,
  -- 旧血统留下的列；本仓库读路径不使用，保留是为了不在发布窗口里打断旧 Worker
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 失效：items 增删改 → 把该书标记为过期。
-- 只 UPDATE 已存在的行；没有行 = 读路径会当作「缺失」补上，不需要在这里插入。
CREATE TRIGGER IF NOT EXISTS ext_book_stats_dirty_on_insert
AFTER INSERT ON items
BEGIN
  UPDATE ext_book_stats SET computed_at_ms = 0 WHERE book_id = NEW.book_id;
END;

CREATE TRIGGER IF NOT EXISTS ext_book_stats_dirty_on_update
AFTER UPDATE ON items
BEGIN
  UPDATE ext_book_stats SET computed_at_ms = 0
   WHERE book_id IN (OLD.book_id, NEW.book_id);
END;

CREATE TRIGGER IF NOT EXISTS ext_book_stats_dirty_on_delete
AFTER DELETE ON items
BEGIN
  UPDATE ext_book_stats SET computed_at_ms = 0 WHERE book_id = OLD.book_id;
END;

-- 0 = 过期，需重算；非 0 = 上次重算的时刻（毫秒）。
-- 既有库的旧行会被这个 DEFAULT 全部标成过期。
--
-- ⚠️ 故意放在**最后**：`ALTER TABLE ADD COLUMN` 是 SQLite 里少数没有
-- `IF NOT EXISTS` 形式的语句（无法写成「有就跳过」）。放在最后能让「部分应用」
-- 变成可重试的：若在它之前失败，重跑时前面的语句全是 `IF NOT EXISTS` 的 no-op，
-- ALTER 照常执行；若它自己失败，说明列没加上，重跑也照常执行。
ALTER TABLE ext_book_stats ADD COLUMN computed_at_ms INTEGER NOT NULL DEFAULT 0;
