-- 0111_schema_marker_citations.sql
--
-- 把「哪条条文引用了哪个标注实体」物化成表。
--
-- 背景：正文里的 `$f{桂枝汤}` / `$u{桂枝}` 要渲染成可点实体，浮层还要列出「被哪些
-- 条文引用」。这份反向索引现在是**每次渲染现算**的（`markerPopover.ts`）：先把整本
-- 书的条文全读一遍（实测本书 847 rows_read），再对每行正文做名字的字符串包含判断。
-- 它只随「条文正文」变化，却要在每次缓存回源时重算。
--
-- ⚠️ 前置不变量（这张表成立的前提，别搞反方向）：
--   正文在 `data.description` 里**按原形保存**，`$f{桂枝汤}` 是原文的一部分；渲染成
--   `<span class="mf-mk">` 只发生在**显示时**（`renderTcmMarkers` 是纯函数，收字符串吐
--   字符串，不碰 DB，结果只进响应、从不写回）。本表只是从那份原文里**提取**出来的派生
--   副本，本身不含任何 HTML。
--   ⇒ 一旦有人把标记在入库前剥掉、或在写路径里改存渲染后的 HTML，本表会**静默变空**
--      （不报错，只是浮层不再有引用列表）。改正文存储格式前必须先改这里。
--
-- 本迁移只建表与失效触发器，**不在触发器里重算**（照 0103 `ext_book_stats` 的既有
-- 模式）：触发器把该书标记为过期，读路径发现过期才重算并写回。稳态下渲染一页只读
-- 该页出现的名字对应的几行。
--
-- 为什么带 `marker_code`：`$f{桂枝汤}` 与 `$u{桂枝}` 是两套命名空间，一条条文完全
-- 可能同时引用二者；只用名字做键会在主键上撞车。读路径按 (code, name) 取。
--
-- 键是**名字**不是实体 id：源数据的引用就是按名字写的（`$f{桂枝汤}`），
-- `markerPopover` 的解析也是按名字查表（`resolveHref`）。所以重算时直接从正文里
-- 提取名字即可，不需要先知道该书的方剂名单。
--
-- 关于 `json_extract(NEW.data, …)` 的安全性 —— 2026-10-13 实测结论，别凭直觉改：
--   「触发器对每行求值 json_extract，遇到非法 JSON 会中止写入」听起来像风险，但**在这张表上不可达**：
--   `items` 上有 11 条以 `json_extract(data, …)` 为表达式的索引（`items_tcm_kind_name`、
--   `items_source_book_id`、`items_section_order`、`items_fang_order_v2` …），维护索引就必须求值表达式
--   ⇒ 非法/空串的 `data` **根本写不进 items**，与触发器无关。
--   证据：把全库 10 个触发器**全部 DROP** 之后，`UPDATE items SET data = '' …` 仍抛 `malformed JSON`。
--   ⇒ 这里**不设 `json_valid` 守卫**（那条分支不可达，是死代码）。真要防，该防的是「有人删掉那些表达式索引」，
--      而那不归本迁移管。
--   `items.data` 是可空、无默认的 TEXT；`json_extract(NULL, …)` 返回 NULL、不抛错，所以 NULL 行也安全。
--
-- 回滚：
--   DROP TRIGGER IF EXISTS ext_marker_citations_dirty_on_insert;
--   DROP TRIGGER IF EXISTS ext_marker_citations_dirty_on_update;
--   DROP TRIGGER IF EXISTS ext_marker_citations_dirty_on_delete;
--   DROP TABLE IF EXISTS ext_marker_citation_state;
--   DROP TABLE IF EXISTS ext_marker_citations;

-- 一行 = 「某书里，某条条文引用了某个名字（方剂或中药）」。
-- `section_title` 冗余存一份：浮层要显示条文标题，而任何条目改动都会把该书标脏重算，
-- 所以它不会比现状更容易陈旧。
-- `section_seq` 记住重算时的 `items.rowid`，用来复刻现状的展示顺序（现状是无
-- `ORDER BY` 的 rowid 顺序）。
CREATE TABLE IF NOT EXISTS ext_marker_citations (
  book_id       TEXT    NOT NULL,
  marker_code   TEXT    NOT NULL,
  marker_name   TEXT    NOT NULL,
  section_id    TEXT    NOT NULL,
  section_title TEXT    NOT NULL DEFAULT '',
  section_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, marker_code, marker_name, section_id)
);

-- 读路径的查询形状：按书 + 该页出现的 (code, name) 取引用，按 seq 复刻顺序。
CREATE INDEX IF NOT EXISTS ext_marker_citations_lookup
  ON ext_marker_citations (book_id, marker_code, marker_name, section_seq);

-- 每本书一行的过期标记。0 = 过期需重算；非 0 = 上次重算时刻（毫秒）。
-- 没有行 = 从未算过，读路径同样当作需要重算（照 0103：触发器只 UPDATE 已存在的行）。
CREATE TABLE IF NOT EXISTS ext_marker_citation_state (
  book_id        TEXT    PRIMARY KEY,
  computed_at_ms INTEGER NOT NULL DEFAULT 0
);

-- 失效：items 增删改 → 把该书标记为过期。
-- `COALESCE(sourceBookId, book_id)`：方剂/中药行的 `book_id` 可能是容器频道，真正受
-- 影响的是 `sourceBookId` 指向的那本书；条文/篇章行没有 `sourceBookId`，取 `book_id`。
CREATE TRIGGER IF NOT EXISTS ext_marker_citations_dirty_on_insert
AFTER INSERT ON items
BEGIN
  UPDATE ext_marker_citation_state SET computed_at_ms = 0
   WHERE book_id = COALESCE(json_extract(NEW.data, '$._microfeed.sourceBookId'), NEW.book_id);
END;

CREATE TRIGGER IF NOT EXISTS ext_marker_citations_dirty_on_update
AFTER UPDATE ON items
BEGIN
  UPDATE ext_marker_citation_state SET computed_at_ms = 0
   WHERE book_id IN (
     COALESCE(json_extract(OLD.data, '$._microfeed.sourceBookId'), OLD.book_id),
     COALESCE(json_extract(NEW.data, '$._microfeed.sourceBookId'), NEW.book_id)
   );
END;

CREATE TRIGGER IF NOT EXISTS ext_marker_citations_dirty_on_delete
AFTER DELETE ON items
BEGIN
  UPDATE ext_marker_citation_state SET computed_at_ms = 0
   WHERE book_id = COALESCE(json_extract(OLD.data, '$._microfeed.sourceBookId'), OLD.book_id);
END;
