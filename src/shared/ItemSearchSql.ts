// 后台事件源 typeahead 的专用 FTS 表，同样是派生数据，快照导出时一并排除。
// 表名在此单点定义：语句文本里用模板插值引用它——派生表不在本地门禁库里，
// 直写表名会让 check-d1-scan 的 EXPLAIN 报 no such table，插值则由 canPlan
// 判为动态名字并计入 skipped；快照排除名单也由这个常量派生。
// 站点全文搜索表族（site_search_*）已于迁移 0151 整体退役（ADR-0051）。
export const ADMIN_TYPEAHEAD_TABLE = "ext_admin_typeahead";

// 挂在主表 items 上的三个同步触发器共用的名字前缀，快照导出时同样排除。
export const ADMIN_TYPEAHEAD_TRIGGER_PREFIX = "items_admin_typeahead_";

export const ADMIN_TYPEAHEAD_VIRTUAL_TABLE_PREFIXES = [
  ADMIN_TYPEAHEAD_TABLE,
] as const;

// Portable-snapshot code uses this for its derived-table exclusion list.
// item_search_* 与 site_search_* 两族都列进来：前者是统一改名前的旧前缀，
// 后者是 0151 已退役的族——两者都只可能出现在「迁移重放到 0151 之前」的库与
// 老快照里，快照导出必须照样排除它们的影子表，否则虚拟表与显式影子表会撞名。
export const ITEM_SEARCH_VIRTUAL_TABLE_PREFIXES = [
  ...ADMIN_TYPEAHEAD_VIRTUAL_TABLE_PREFIXES,
  "item_search_exact",
  "item_search_title_trigram",
  "site_search_exact",
  "site_search_title_trigram",
] as const;

// 后台事件源 typeahead 的专用索引：把 `标题 + 空格 + lower(id)` 逐字切成空格分隔的
// token 存进 unicode61 FTS5，查询侧用短语 `MATCH '"黄 芪"'` 表达子串语义。
// d1scan:ignore 重建时清表并从 items 兜底回填本就是整表操作，索引无解
export const CREATE_ADMIN_TYPEAHEAD_INDEX_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS ext_admin_typeahead USING fts5(
  haystack,
  content_id UNINDEXED,
  tokenize = 'unicode61'
);
CREATE TRIGGER IF NOT EXISTS items_admin_typeahead_after_insert
AFTER INSERT ON items
WHEN NEW.status != 3
BEGIN
  INSERT INTO ext_admin_typeahead(rowid, haystack, content_id)
  SELECT (SELECT COALESCE(MAX(rowid), 0) + 1 FROM ext_admin_typeahead),
         (WITH RECURSIVE
            src(t) AS (SELECT COALESCE(json_extract(NEW.data, '$.title'), '') || ' ' || lower(NEW.id)),
            chars(t, i, ch) AS (
              SELECT t, 1, substr(t, 1, 1) FROM src WHERE t <> ''
              UNION ALL
              SELECT t, i + 1, substr(t, i + 1, 1) FROM chars WHERE i < length(t)
            )
          SELECT group_concat(ch, ' ') FROM chars),
         NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS items_admin_typeahead_after_update
AFTER UPDATE ON items
BEGIN
  DELETE FROM ext_admin_typeahead WHERE content_id = OLD.id;
  INSERT INTO ext_admin_typeahead(rowid, haystack, content_id)
  SELECT (SELECT COALESCE(MAX(rowid), 0) + 1 FROM ext_admin_typeahead),
         (WITH RECURSIVE
            src(t) AS (SELECT COALESCE(json_extract(NEW.data, '$.title'), '') || ' ' || lower(NEW.id)),
            chars(t, i, ch) AS (
              SELECT t, 1, substr(t, 1, 1) FROM src WHERE t <> ''
              UNION ALL
              SELECT t, i + 1, substr(t, i + 1, 1) FROM chars WHERE i < length(t)
            )
          SELECT group_concat(ch, ' ') FROM chars),
         NEW.id
  WHERE NEW.status != 3;
END;
CREATE TRIGGER IF NOT EXISTS items_admin_typeahead_after_delete
AFTER DELETE ON items
BEGIN
  DELETE FROM ext_admin_typeahead WHERE content_id = OLD.id;
END;
DELETE FROM ext_admin_typeahead;
INSERT INTO ext_admin_typeahead(rowid, haystack, content_id)
WITH RECURSIVE
src(id, t) AS (
  SELECT id, COALESCE(json_extract(data, '$.title'), '') || ' ' || lower(id)
  FROM items WHERE status != 3
),
chars(id, t, i, ch) AS (
  SELECT id, t, 1, substr(t, 1, 1) FROM src WHERE t <> ''
  UNION ALL
  SELECT id, t, i + 1, substr(t, i + 1, 1) FROM chars WHERE i < length(t)
)
SELECT ROW_NUMBER() OVER (ORDER BY id), group_concat(ch, ' '), id FROM chars GROUP BY id;
`;

export const DROP_ADMIN_TYPEAHEAD_INDEX_SQL = `
DROP TRIGGER IF EXISTS items_admin_typeahead_after_insert;
DROP TRIGGER IF EXISTS items_admin_typeahead_after_update;
DROP TRIGGER IF EXISTS items_admin_typeahead_after_delete;
DROP TABLE IF EXISTS ext_admin_typeahead;
`;
