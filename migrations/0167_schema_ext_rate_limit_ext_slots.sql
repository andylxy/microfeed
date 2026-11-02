-- 0167_schema_ext_rate_limit_ext_slots.sql
--
-- 按分册 08「常备 ext1~ext10 扩展槽位」规则，给 ext_rate_limit 补齐 10 个可空
-- 类型化列。该规则对运行态热表同样生效（不豁免）；0166 建表时未带槽位，本迁移补齐。
--
-- 只改 schema、不重写已有行：SQLite 的 ALTER TABLE ADD COLUMN 只更新表结构，
-- 已有行新列取 NULL；10 列均可空、默认 NULL，行宽代价可忽略（NULL 只占行内标记位）。
--
-- 用途：后续给 ext_rate_limit 新增字段时直接写 ext 槽位，不必每次 ALTER TABLE。
--
-- type = schema。
-- rollback:
--   SQLite 3.35+ 支持 ALTER TABLE DROP COLUMN，可逐列回退；若运行时 SQLite 版本
--   不支持 DROP COLUMN，则按「建新表（不含 ext 列）+ 拷贝 + 改名」重建。本迁移只加
--   可空列，不破坏既有数据。

ALTER TABLE "ext_rate_limit" ADD COLUMN "ext1"  TEXT;
ALTER TABLE "ext_rate_limit" ADD COLUMN "ext2"  TEXT;
ALTER TABLE "ext_rate_limit" ADD COLUMN "ext3"  TEXT;
ALTER TABLE "ext_rate_limit" ADD COLUMN "ext4"  TEXT;
ALTER TABLE "ext_rate_limit" ADD COLUMN "ext5"  TEXT;
ALTER TABLE "ext_rate_limit" ADD COLUMN "ext6"  TEXT;
ALTER TABLE "ext_rate_limit" ADD COLUMN "ext7"  TEXT;
ALTER TABLE "ext_rate_limit" ADD COLUMN "ext8"  TEXT;
ALTER TABLE "ext_rate_limit" ADD COLUMN "ext9"  TEXT;
ALTER TABLE "ext_rate_limit" ADD COLUMN "ext10" TEXT;
