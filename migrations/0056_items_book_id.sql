-- 0056_items_book_id.sql
--
-- ADR-0006: promote `items._microfeed.bookId` to a real column.
--
-- "Which book does this chapter belong to" lives inside the `data` JSON pocket.
-- A condition on a JSON path cannot use an index, so "chapters of book X" was
-- necessarily a full table scan. This column is a denormalized, queryable copy;
-- `data._microfeed.bookId` stays the source of truth — the same pattern as
-- `items.review_status` and `channels.genre` (ADR-0004).
--
-- The backfill uses `json_extract` directly: D1 accepts the
-- `'$._microfeed.bookId'` path form (verified 2026-09-24). `SQLITE_ERROR 7500`
-- is a wrangler CLI parameter-binding limitation, not a SQL one — it appears for
-- any query using `?` without bindings, which is why the literals below are
-- inlined rather than bound.
--
-- Additive column, so upstream upgrade compatibility is preserved.

ALTER TABLE items ADD COLUMN book_id TEXT;

CREATE INDEX IF NOT EXISTS items_book_id ON items (book_id);

UPDATE items
   SET book_id = json_extract(data, '$._microfeed.bookId')
 WHERE book_id IS NULL
   AND json_extract(data, '$._microfeed.bookId') IS NOT NULL;
