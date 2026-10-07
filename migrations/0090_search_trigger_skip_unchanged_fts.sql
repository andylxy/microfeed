-- 0090: 搜索同步触发器只在 FTS 相关列变化时重建 FTS 索引
--
-- 背景：site_search_exact / site_search_title_trigram 只索引 title / content_text /
-- content_type / content_id。原 items/pages 的 *_after_update 触发器用 DELETE+INSERT
-- 重写 site_search_documents，无论这次 UPDATE 是否触及这些列，都级联重建 4 行 FTS。
-- 内容保存总会写 data，而 title 取自 data——但「只改 data 里与 title 无关的字段」
-- （如卷标签 _microfeed.volume、chapterNo）同样触发重建，属纯浪费。
--
-- 改法：把 items/pages 的 *_after_update 从 DELETE+INSERT 改为原地 UPSERT（让
-- site_search_documents 各列——含 updated_at——始终最新），并给 site_search_documents
-- 的 after_update 触发器加 WHEN，仅当 FTS 实际索引的列变化时才重建 FTS 行。
-- 语义不变：FTS 内容在所有路径下与原实现一致；site_search_documents 的元数据
-- （status / updated_at / published_at / image）仍在每次 items/pages 更新时刷新。
--
-- 与 src/shared/ItemSearchSql.ts 的 CREATE_SITE_SEARCH_INDEX_SQL 必须保持一致。

DROP TRIGGER IF EXISTS site_search_documents_after_update;
CREATE TRIGGER site_search_documents_after_update
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

DROP TRIGGER IF EXISTS items_site_search_after_update;
CREATE TRIGGER items_site_search_after_update
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

DROP TRIGGER IF EXISTS pages_site_search_after_update;
CREATE TRIGGER pages_site_search_after_update
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
