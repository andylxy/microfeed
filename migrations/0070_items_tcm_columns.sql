-- 0070_items_tcm_columns.sql
--
-- Two real columns that index the TCM content imported from the ctwh dump
-- (spec: `.scratch/tcm-import/spec.md` §5.3 / §16).
--
-- `tcm_kind`      — which TCM entity an item carries: `chapter`(篇章) /
--                   `section`(条文) / `fang`(方剂) / `yao`(中药) / `term`(名词).
-- `tcm_parent_id` — the *parent item's* 11-char id, for the one relation a
--                   channel cannot express: 条文 → its 篇章 item.
--                   (Channel membership goes through the existing `book_id`
--                   column, which the save path mirrors from
--                   `_microfeed.bookId` — 篇章 → its 典籍 channel, 方剂 / 中药 /
--                   名词 → their container channel. `book_id` cannot double as
--                   the chapter link: novel-cms reads it as "chapters of this
--                   book", so 条文 tagged with a chapter id would surface there
--                   as chapters.)
--
-- All relationships live on current-project 11-char ids. The source dump's
-- int64 ids (ChapterId / BookInfoId / FangId / YaoId / ReceiptNo) are consumed
-- by the import script in memory only and are never stored — there is no
-- source-id column anywhere (user decision 2026-09-28: 以当前项目为主).
-- `section` / `receiptNo` stay in the pocket as *ordering* keys, not relations.
--
-- Why real columns instead of `_microfeed` pocket keys:
--   1. The dashboard save path (`FeedDb._putItemToContentStatement`) rewrites
--      `data` wholesale, so a business key that lives only in the pocket is
--      one editor save away from being dropped. Real columns are untouched by
--      that upsert (it only writes its eight known columns).
--   2. A condition on a JSON path cannot use an index — the same reason
--      `book_id` and `review_status` became real columns (ADR-0004/0006).
--      Without `tcm_parent_id`, "条文 of this 篇章" (8066 rows after import,
--      the App's main reading query) is a full table scan.
--
-- Index shapes and the queries they serve:
--   items_tcm_kind_name   (tcm_kind, title)         — marker link jumps
--                         (`$u{}` 中药 / `$f{}` 方剂 / `$g{}` 名词 → that
--                         entity's own page) plus kind-only filters through
--                         the leading column.
--   items_tcm_kind_parent (tcm_kind, tcm_parent_id) — 条文 of a 篇章.
-- SQLite only picks an expression index when the query uses the *same*
-- expression, so the reading functions must filter with exactly
-- `json_extract(data, '$.title')`.
--
-- Additive: no existing column or row is touched.

ALTER TABLE items ADD COLUMN tcm_kind TEXT;
ALTER TABLE items ADD COLUMN tcm_parent_id TEXT;

CREATE INDEX IF NOT EXISTS items_tcm_kind_name
  ON items (tcm_kind, json_extract(data, '$.title'));

CREATE INDEX IF NOT EXISTS items_tcm_kind_parent
  ON items (tcm_kind, tcm_parent_id);
