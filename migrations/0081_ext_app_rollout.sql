-- 0081_ext_app_rollout.sql
--
-- 灰度强制升级规则（spec §5.2 / §6.3）。解析顺序 device > user > percent > all，
-- 最终地板取 max(命中规则, ext_app_version.min_version_code)（ADR-0002）。
--
-- scope 取值：
--   'all'     —— 全体生效（MVP 只用这一种 + 全局地板）
--   'user'    —— target = userId
--   'device'  —— target = deviceId
--   'percent' —— target = 0..100 的百分比字符串，命中条件 hash(deviceId) % 100 < target
--
-- force = 1 → 命中即 426 硬阻；force = 0 → 仅提示。注意：低于全局 min_version_code
-- 恒为硬阻（force 隐含 true），软提示只适用于地板之上的灰度（ADR-0008）。
--
-- 幂等：IF NOT EXISTS。

CREATE TABLE IF NOT EXISTS ext_app_rollout (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,          -- 'all' | 'user' | 'device' | 'percent'
  target TEXT,                  -- userId / deviceId / 百分比数值字符串
  min_version_code INTEGER NOT NULL,
  force INTEGER NOT NULL DEFAULT 1,   -- 1=强制 426, 0=仅提示
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ext_app_rollout_scope ON ext_app_rollout (scope);
