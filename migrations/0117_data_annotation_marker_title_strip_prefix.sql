-- 0117_data_annotation_marker_title_strip_prefix.sql
--
-- 0068 seeded `title` as `$f 方剂` — the code and the display name in one
-- string. But `title` is a UI label only: it is what the admin table shows and
-- what the wangEditor toolbar button renders. The renderer never reads it
-- (getAppStyleConfig drops it before the styles reach renderTcmMarkers), so the
-- `$f ` prefix is redundant — the `code` column already carries it — and it made
-- the editor button read "$f 方剂" instead of "方剂".
--
-- Strip the prefix so `title` is the plain name. The `code` column keeps the
-- grammar; nothing else changes. Measured before applying (local D1 snapshot,
-- 2026-10-16): 15 rows, all 15 matching the `$<code> ` prefix, 0 exceptions.
--
-- rollback:
--   UPDATE ext_annotation_markers SET title = '$' || code || ' ' || title;

UPDATE ext_annotation_markers
SET title = TRIM(SUBSTR(title, LENGTH('$' || code) + 2))
WHERE title LIKE '$' || code || ' %';
