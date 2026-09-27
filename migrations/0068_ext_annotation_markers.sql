-- Annotation markers: a runtime-managed list of inline annotation tags
-- (e.g. $f{方剂} / $a{中药} / $u{穴位} / $x{西医}) that the wangEditor rich
-- text editor turns into toolbar buttons. Adding/removing a marker no longer
-- needs a redeploy — the editor fetches this table on mount and registers a
-- button per row. See `src/components/admin/shared/AdminRichEditor/...` and
-- `src/server/admin/annotation-marker-handlers.ts`.

CREATE TABLE IF NOT EXISTS ext_annotation_markers (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  multi        INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_ext_annotation_markers_sort
  ON ext_annotation_markers (sort_order);

-- Seed the four TCM annotation markers so the editor keeps working out of the
-- box. `INSERT OR IGNORE` keeps these idempotent across re-deploys.
INSERT OR IGNORE INTO ext_annotation_markers
  (id, code, title, multi, sort_order, created_at_ms, updated_at_ms)
VALUES
  ('am_f', 'f', '$f 方剂', 0, 10, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_a', 'a', '$a 中药', 0, 20, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_u', 'u', '$u 穴位', 0, 30, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_x', 'x', '$x 西医/检验', 1, 40, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- Permission catalog: anyone who can read content may see the buttons
-- (`:read`), only managers may add/edit/remove them (`:manage`).
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_annotation_markers_read',   'content:annotation-markers:read',   '标注标记查看'),
  ('p_content_annotation_markers_manage', 'content:annotation-markers:manage', '标注标记管理');

-- Admin menu entry — visible only to accounts holding `:manage`.
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_annotation_markers', 'annotation_markers', NULL, 'annotation-markers',
   'menu.item.annotation_markers', 'tags', 'content:annotation-markers:manage', 165, 1,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000);
