-- 0110_data_annotation_marker_colors.sql
--
-- Aligns two marker colours with the source Android renderer's definitions
-- (`TipsTextRenderConfig`), supplied by the owner 2026-10-13. Both markers were
-- off by one column in a different way:
--
--   $w 剂量 — the source uses `Color.GREEN` (#00FF00). 0071 seeded a softer
--             custom green (#1CB55C) that is not in the source definition.
--   $y 棕字 — the row had no colour at all (NULL). `TcmMarkers.wrap()` emits
--             `color:${style.color}`, so the span shipped `color:null` — an
--             invalid declaration that browsers drop, leaving the marker to
--             inherit its parent's colour instead of the intended brown.
--
-- The other eleven markers were verified row-by-row against the same source
-- list and already match (including `$g`'s `argb(230, 0, 128, 255)`, which 0071
-- stored as the equivalent `rgba(0, 128, 255, 0.90)`), so they are untouched.
--
-- rollback:
--   UPDATE ext_annotation_markers SET color = '#1CB55C' WHERE code = 'w';
--   UPDATE ext_annotation_markers SET color = NULL      WHERE code = 'y';

UPDATE ext_annotation_markers
   SET color = '#00FF00',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE code = 'w';

UPDATE ext_annotation_markers
   SET color = '#9A764F',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE code = 'y';
