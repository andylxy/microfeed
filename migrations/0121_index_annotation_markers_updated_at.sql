-- 版本号查询 `SELECT MAX(updated_at_ms) FROM ext_annotation_markers`
-- （GetTipsStyleConfig 下发样式目录版本号，ADR-0028）此前没有 `updated_at_ms`
-- 索引，MAX 走全表扫描。加索引后 MAX 走索引 seek（读 1 个索引页）。
-- rollback: DROP INDEX IF EXISTS ix_ext_annotation_markers_updated_at;
CREATE INDEX IF NOT EXISTS ix_ext_annotation_markers_updated_at
  ON ext_annotation_markers (updated_at_ms);
