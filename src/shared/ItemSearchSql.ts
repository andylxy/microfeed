export const SITE_SEARCH_VIRTUAL_TABLE_PREFIXES = [
  "site_search_exact",
  "site_search_title_trigram",
] as const;

// 后台事件源 typeahead 的专用 FTS 表，同样是派生数据，快照导出时一并排除。
// 表名在此单点定义：语句文本里用模板插值引用它——派生表不在本地门禁库里，
// 直写表名会让 check-d1-scan 的 EXPLAIN 报 no such table，插值则由 canPlan
// 判为动态名字并计入 skipped；快照排除名单也由这个常量派生。
export const ADMIN_TYPEAHEAD_TABLE = "ext_admin_typeahead";

// 挂在主表 items 上的三个同步触发器共用的名字前缀，快照导出时同样排除。
export const ADMIN_TYPEAHEAD_TRIGGER_PREFIX = "items_admin_typeahead_";

export const ADMIN_TYPEAHEAD_VIRTUAL_TABLE_PREFIXES = [
  ADMIN_TYPEAHEAD_TABLE,
] as const;

// Compatibility export used by portable-snapshot code. Search now covers
// both feed items and Pages, but these tables remain derived and disposable.
export const ITEM_SEARCH_VIRTUAL_TABLE_PREFIXES = [
  ...SITE_SEARCH_VIRTUAL_TABLE_PREFIXES,
  ...ADMIN_TYPEAHEAD_VIRTUAL_TABLE_PREFIXES,
  "item_search_exact",
  "item_search_title_trigram",
] as const;

export const DROP_SITE_SEARCH_INDEX_SQL = `
UPDATE site_search_metadata
SET ready = 0, normalized_at = NULL
WHERE id = 1;
DROP TRIGGER IF EXISTS items_site_search_after_insert;
DROP TRIGGER IF EXISTS items_site_search_after_update;
DROP TRIGGER IF EXISTS items_site_search_after_delete;
DROP TRIGGER IF EXISTS pages_site_search_after_insert;
DROP TRIGGER IF EXISTS pages_site_search_after_update;
DROP TRIGGER IF EXISTS pages_site_search_after_delete;
DROP TRIGGER IF EXISTS site_search_documents_after_insert;
DROP TRIGGER IF EXISTS site_search_documents_after_update;
DROP TRIGGER IF EXISTS site_search_documents_after_delete;
DROP TABLE IF EXISTS site_search_exact;
DROP TABLE IF EXISTS site_search_title_trigram;
DELETE FROM site_search_documents;
`;

// d1scan:ignore 搜索索引全量重建脚本：清表与从 items/pages 兜底回填本就是整表操作，索引无解
export const CREATE_SITE_SEARCH_INDEX_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS site_search_exact USING fts5(
  content_type UNINDEXED,
  content_id UNINDEXED,
  title,
  content_text,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS site_search_title_trigram USING fts5(
  content_type UNINDEXED,
  content_id UNINDEXED,
  title,
  tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS site_search_documents_after_insert
AFTER INSERT ON site_search_documents
BEGIN
  INSERT INTO site_search_exact(
    rowid, content_type, content_id, title, content_text
  ) VALUES (
    NEW.id, NEW.content_type, NEW.content_id, NEW.title, NEW.content_text
  );
  INSERT INTO site_search_title_trigram(
    rowid, content_type, content_id, title
  ) VALUES (
    NEW.id, NEW.content_type, NEW.content_id, NEW.title
  );
END;
CREATE TRIGGER IF NOT EXISTS site_search_documents_after_update
AFTER UPDATE ON site_search_documents
WHEN OLD.title IS NOT NEW.title
  OR OLD.content_text IS NOT NEW.content_text
  OR OLD.content_type IS NOT NEW.content_type
  OR OLD.content_id IS NOT NEW.content_id
BEGIN
  DELETE FROM site_search_exact WHERE rowid = OLD.id;
  DELETE FROM site_search_title_trigram WHERE rowid = OLD.id;
  INSERT INTO site_search_exact(
    rowid, content_type, content_id, title, content_text
  ) VALUES (
    NEW.id, NEW.content_type, NEW.content_id, NEW.title, NEW.content_text
  );
  INSERT INTO site_search_title_trigram(
    rowid, content_type, content_id, title
  ) VALUES (
    NEW.id, NEW.content_type, NEW.content_id, NEW.title
  );
END;
CREATE TRIGGER IF NOT EXISTS site_search_documents_after_delete
AFTER DELETE ON site_search_documents
BEGIN
  DELETE FROM site_search_exact WHERE rowid = OLD.id;
  DELETE FROM site_search_title_trigram WHERE rowid = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS items_site_search_after_insert
AFTER INSERT ON items
WHEN NEW.status != 3
BEGIN
  INSERT INTO site_search_documents (
    content_type, content_id, status, title, content_text,
    published_at, updated_at, image
  ) VALUES (
    'item', NEW.id, NEW.status,
    COALESCE(json_extract(NEW.data, '$.title'), ''),
    NEW.content_text, NEW.pub_date, NEW.updated_at,
    json_extract(NEW.data, '$.image')
  );
END;
CREATE TRIGGER IF NOT EXISTS items_site_search_after_update
AFTER UPDATE ON items
BEGIN
  DELETE FROM site_search_documents
  WHERE content_type = 'item' AND content_id = OLD.id AND NEW.status = 3;
  INSERT INTO site_search_documents (
    content_type, content_id, status, title, content_text,
    published_at, updated_at, image
  )
  SELECT
    'item', NEW.id, NEW.status,
    COALESCE(json_extract(NEW.data, '$.title'), ''),
    NEW.content_text, NEW.pub_date, NEW.updated_at,
    json_extract(NEW.data, '$.image')
  WHERE NEW.status != 3
  ON CONFLICT(content_type, content_id) DO UPDATE SET
    status = excluded.status,
    title = excluded.title,
    content_text = excluded.content_text,
    published_at = excluded.published_at,
    updated_at = excluded.updated_at,
    image = excluded.image;
END;
CREATE TRIGGER IF NOT EXISTS items_site_search_after_delete
AFTER DELETE ON items
BEGIN
  DELETE FROM site_search_documents
  WHERE content_type = 'item' AND content_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS pages_site_search_after_insert
AFTER INSERT ON pages
WHEN NEW.status != 3 AND NEW.slug != '404' COLLATE NOCASE
BEGIN
  INSERT INTO site_search_documents (
    content_type, content_id, status, title, content_text,
    published_at, updated_at, image
  ) VALUES (
    'page', NEW.id, NEW.status, NEW.title, NEW.content_text,
    NEW.published_at, NEW.updated_at, NULL
  );
END;
CREATE TRIGGER IF NOT EXISTS pages_site_search_after_update
AFTER UPDATE ON pages
BEGIN
  DELETE FROM site_search_documents
  WHERE content_type = 'page' AND content_id = OLD.id
    AND (NEW.status = 3 OR NEW.slug = '404' COLLATE NOCASE);
  INSERT INTO site_search_documents (
    content_type, content_id, status, title, content_text,
    published_at, updated_at, image
  )
  SELECT
    'page', NEW.id, NEW.status, NEW.title, NEW.content_text,
    NEW.published_at, NEW.updated_at, NULL
  WHERE NEW.status != 3 AND NEW.slug != '404' COLLATE NOCASE
  ON CONFLICT(content_type, content_id) DO UPDATE SET
    status = excluded.status,
    title = excluded.title,
    content_text = excluded.content_text,
    published_at = excluded.published_at,
    updated_at = excluded.updated_at,
    image = excluded.image;
END;
CREATE TRIGGER IF NOT EXISTS pages_site_search_after_delete
AFTER DELETE ON pages
BEGIN
  DELETE FROM site_search_documents
  WHERE content_type = 'page' AND content_id = OLD.id;
END;
DELETE FROM site_search_documents;
INSERT INTO site_search_documents (
  content_type, content_id, status, title, content_text,
  published_at, updated_at, image
)
SELECT
  'item', id, status, COALESCE(json_extract(data, '$.title'), ''),
  content_text, pub_date, updated_at, json_extract(data, '$.image')
FROM items
WHERE status != 3;
INSERT INTO site_search_documents (
  content_type, content_id, status, title, content_text,
  published_at, updated_at, image
)
SELECT
  'page', id, status, title, content_text,
  published_at, updated_at, NULL
FROM pages
WHERE status != 3 AND slug != '404' COLLATE NOCASE;
`;

// 后台事件源 typeahead 的专用索引：把 `标题 + 空格 + lower(id)` 逐字切成空格分隔的
// token 存进 unicode61 FTS5，查询侧用短语 `MATCH '"黄 芪"'` 表达子串语义。
// d1scan:ignore 与 CREATE_SITE_SEARCH_INDEX_SQL 同一口径：重建时清表并从 items 兜底回填本就是整表操作
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

// Keep the old names while deployment and snapshot callers migrate. Their
// behavior now prepares the unified site search corpus.
export const DROP_ITEM_SEARCH_INDEX_SQL = DROP_SITE_SEARCH_INDEX_SQL;
export const CREATE_ITEM_SEARCH_INDEX_SQL = CREATE_SITE_SEARCH_INDEX_SQL;
