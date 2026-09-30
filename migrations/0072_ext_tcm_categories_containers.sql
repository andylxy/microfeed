-- 0072_ext_tcm_categories_containers.sql
--
-- Structural seeds for the TCM import (spec `.scratch/tcm-import/spec.md`
-- §5.2 / ticket 05):
--
-- 1. Two navigation categories for the imported works, keyed by the source
--    `WorkInfo.Case` code: 1 = 针灸, 9 = 人纪. 内经类 / 本草 / 伤寒 already
--    exist; 东方玄幻 (novel demo) stays untouched.
-- 2. Three container channels — 方剂 / 本草 / 名词 — that host the fang / yao
--    / term items. Without a channel the theme cannot render those items and
--    the marker link jumps (`$u{}` / `$f{}` / `$g{}`) have no landing page.
--    Each carries `_microfeed.tcmContainer` (`fang` / `yao` / `term`) so the
--    import script can find them; they intentionally have no `genre`, so they
--    never appear in the category navigation.
--
-- `channels.is_primary` is UNIQUE and the site feed holds the single 1:
-- production reads back `is_primary = NULL` for every other row (verified
-- 2026-09-28), so the container inserts leave it NULL rather than 0.
--
-- Fixed 11-char ids keep re-application idempotent via `INSERT OR IGNORE`.

INSERT OR IGNORE INTO ext_category (id, name, slug, parent_id, sort, visible)
VALUES
  ('cat_zhenjiu', '针灸', '针灸', NULL, 10, 1),
  ('cat_renji01', '人纪', '人纪', NULL, 20, 1);

INSERT OR IGNORE INTO channels (id, status, is_primary, data, created_at, updated_at)
VALUES
  ('tcmfang0001', 1, NULL,
   '{"title":"方剂","description":"中医方剂库","_microfeed":{"tcmContainer":"fang"}}',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('tcmyao00001', 1, NULL,
   '{"title":"本草","description":"中药条目库","_microfeed":{"tcmContainer":"yao"}}',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('tcmterm0001', 1, NULL,
   '{"title":"名词","description":"中医名词解释","_microfeed":{"tcmContainer":"term"}}',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
