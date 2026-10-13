-- 0109_schema_annotation_marker_small_font_scale.sql
--
-- 0071 gave every annotation marker a `small_font` on/off flag, and the renderer
-- mapped that flag to a hard-coded `font-size: 0.7em` (src/shared/TcmMarkers.ts).
-- The ratio itself was therefore not configuration — the admin could toggle the
-- 0.7x size but could not change it. This adds the ratio as data.
--
-- The default is the value that was hard-coded, so every existing row keeps
-- rendering byte-identically until someone edits it.
--
-- The usable range is enforced at the write layer (the admin handler accepts
-- 0.3–1.0); the column deliberately carries no CHECK constraint so a future
-- content import can write outside that range without needing a migration.
--
-- rollback:
--   ALTER TABLE ext_annotation_markers DROP COLUMN small_font_scale;

ALTER TABLE ext_annotation_markers ADD COLUMN small_font_scale REAL NOT NULL DEFAULT 0.7;
