-- 0138_index_themes_cleanup_cover.sql
--
-- 0138: themes 增加「清理旧版本」的覆盖索引
--
-- ThemeStore.purgeOldVersions 读取 custom 全集：
--   SELECT id, package_id, version, deleted_at FROM themes
--   WHERE source_kind != 'bundled'
-- 现有索引是主键 id、UNIQUE(package_id, version)、created_at、deleted_at
-- 与 asset_owner，没有以 source_kind 打头的索引；判定 custom 行只能
-- `SCAN themes`，投影列随行读取。本索引以 source_kind 打头，后四列覆盖
-- 投影，`EXPLAIN QUERY PLAN` 变为
-- `SCAN themes USING COVERING INDEX ix_themes_cleanup_cover`，表页读取取消。
-- 行数少不代表页数少：本地 10 行占 169 页 / 692,224 字节，扫描整张表要读取全部
-- 主题包；覆盖索引在 `VACUUM` 副本上实测 4,096 字节，读取量降到约 1/169。
-- 本地 10 行（bundled 与 custom 合计）；创建索引写入 10 行是按表行数的推得值
-- （只读探针无法取得 `CREATE INDEX` 的 `rows_written`），推得占每日
-- 100,000 行写入额度的 0.01%；行数上界由 custom live 配额 100、墓碑累积
-- 与 bundled 目录共同决定，清理后回到活跃行数。
-- 回滚：DROP INDEX IF EXISTS ix_themes_cleanup_cover;

CREATE INDEX IF NOT EXISTS ix_themes_cleanup_cover
  ON themes(source_kind, id, package_id, version, deleted_at);
