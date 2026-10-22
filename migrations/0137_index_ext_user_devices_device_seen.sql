-- 0137_index_ext_user_devices_device_seen.sql
--
-- 0137: ext_user_devices 增加设备维度索引 (device_id, last_seen_at DESC)
--
-- 后台登录日志（src/server/app/version/login-log.ts）只对没有归属
-- （`l.user_id IS NULL`）的日志解析归属账号：
--   d.rowid = (SELECT rowid FROM ext_user_devices
--              WHERE device_id = l.device_id
--              ORDER BY last_seen_at DESC, rowid ASC LIMIT 1)
-- 主键是 (user_id, device_id)，只有账号前缀；设备维度的查找此前要扫描整张设备表。
-- 本索引让该子查询变成 `SEARCH ext_user_devices USING COVERING INDEX
-- ix_ext_user_devices_device_seen (device_id=?)`，排序由索引顺序直接给出。
-- 改造前每条待解析日志都要 `SCAN ext_user_devices` 加
-- `USE TEMP B-TREE FOR ORDER BY`：本地表 51 行 / 12,288 字节 / 3 页，默认每页
-- 200 条日志（上限 500，见 LOGIN_LOG_MAX_ROWS）全部无归属时最坏情况下读取
-- 200 × 3 页 = 2,457,600 字节（10,200 行），上限时 6,144,000 字节
-- （25,500 行）——这两个上界由「每页日志条数 × 每页读取的页数 / 行数」按本地表
-- 行数与页数推得；改造后子查询只读取 1 条覆盖索引项（该索引在 `VACUUM` 副本上
-- 实测 4,096 字节 / 51 项，平均约 80 字节/项，也是推得值）：200 条 ≈ 16 KB，
-- 上限 500 条 ≈ 40 KB，不读取表行。每条日志
-- 另有一次 1 行的设备回表（12,288 字节 / 51 行 ≈ 241 字节/行）与 1 行
-- `auth_user` 点查（4,096 字节 / 4 行 ≈ 1,024 字节/行），这两项改造前后相同，
-- 200 行合计 ≈ 253 KB。本地 ext_app_login_log 54 行、无归属 1 行，常态只执行
-- 1 次子查询。设备行随登录设备增长。
-- 本地 51 行；创建索引写入 51 行是按表行数的推得值（只读探针无法取得
-- `CREATE INDEX` 的 `rows_written`），推得占每日 100,000 行写入额度的 0.05%。
-- 回滚：DROP INDEX IF EXISTS ix_ext_user_devices_device_seen;

CREATE INDEX IF NOT EXISTS ix_ext_user_devices_device_seen
  ON ext_user_devices(device_id, last_seen_at DESC);
