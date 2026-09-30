-- 0071_ext_annotation_marker_styles.sql
--
-- The marker table so far carried only what the editor toolbar needed
-- (code + title). The source Android renderer (`TipsTextRenderConfig`) styles
-- every marker with a colour, an optional 0.7x small font, and — for the three
-- entity markers — a link type: 1 = 中药, 2 = 方剂, 3 = 名词. This migration
-- adds those three columns and reseeds the full 13-marker catalogue from the
-- source app defaults (spec `.scratch/tcm-import/spec.md` §4.2).
--
-- It also fixes three titles seeded by 0068 that read the source semantics
-- wrong: `$a` is 按语小字 (not 中药), `$u` is 中药/药物 (not 穴位), and `$x`
-- is an orange single-character mark (not 西医/检验).
--
-- Colours are CSS-ready strings (`#RRGGBB` / `rgba(...)`); `small_font` maps
-- to `font-size: 0.7em`; the 名词 half-transparent blue keeps the source's
-- `argb(230, 0, 128, 255)` as `rgba(0, 128, 255, 0.90)`.
--
-- The four rows 0068 seeded already exist, so `INSERT OR IGNORE` alone would
-- never give them the new columns: they get explicit UPDATEs. The remaining
-- nine are `INSERT OR IGNORE`, keeping re-application idempotent.

ALTER TABLE ext_annotation_markers ADD COLUMN color TEXT;
ALTER TABLE ext_annotation_markers ADD COLUMN small_font INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ext_annotation_markers ADD COLUMN link_type INTEGER NOT NULL DEFAULT 0;

UPDATE ext_annotation_markers
   SET title = '$f 方剂', color = '#0000FF', small_font = 0, link_type = 2,
       sort_order = 10, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE code = 'f';

UPDATE ext_annotation_markers
   SET title = '$u 中药', color = '#0000FF', small_font = 0, link_type = 1,
       sort_order = 20, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE code = 'u';

UPDATE ext_annotation_markers
   SET title = '$a 按语', color = '#808080', small_font = 1, link_type = 0,
       sort_order = 50, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE code = 'a';

UPDATE ext_annotation_markers
   SET title = '$x 橙字', color = '#EA8E3B', small_font = 0, link_type = 0,
       sort_order = 90, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE code = 'x';

INSERT OR IGNORE INTO ext_annotation_markers
  (id, code, title, multi, sort_order, color, small_font, link_type,
   created_at_ms, updated_at_ms)
VALUES
  ('am_w', 'w', '$w 剂量',     0, 30,  '#1CB55C',              1, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_q', 'q', '$q 出处',     0, 40,  '#3DC878',              0, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_m', 'm', '$m 强调',     0, 60,  '#FF0000',              0, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_n', 'n', '$n 蓝字',     0, 70,  '#0000FF',              0, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_g', 'g', '$g 名词解释', 0, 80,  'rgba(0, 128, 255, 0.90)', 0, 3,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_r', 'r', '$r 批注',     0, 100, '#FF0000',              1, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_v', 'v', '$v 蓝字',     0, 110, '#0000FF',              0, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_y', 'y', '$y 棕字',     0, 120, '#9A764F',              0, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_h', 'h', '$h 黑字',     0, 130, '#000000',              0, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000);
