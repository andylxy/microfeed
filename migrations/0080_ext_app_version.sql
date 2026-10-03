-- 0080_ext_app_version.sql
--
-- App 版本下发配置（单行表）。后台「版本管理」页（/admin/app-versions/）读写这一行，
-- 公共端点 `GET /api/app/version` 与版本门 `requireAppVersion` 从它读全局地板
-- `min_version_code`（spec §5.1 / §6.4，ADR-0002 / ADR-0008）。
--
-- 单行约束用 `CHECK (id = 1)` 表达：配置是全局唯一的，多行没有语义。
-- 初始化 1 行，`min_version_code = 0` 表示「不强制升级」——上线强制升级前必须
-- 先把新 apk 托管到可下载地址，再抬高该值（spec §12 铁律）。
--
-- 幂等：IF NOT EXISTS + INSERT OR IGNORE。

CREATE TABLE IF NOT EXISTS ext_app_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  latest_version_code INTEGER NOT NULL,
  latest_version_name TEXT NOT NULL,
  min_version_code INTEGER NOT NULL DEFAULT 0,   -- 全局强制地板
  download_url TEXT NOT NULL,
  file_md5 TEXT,
  update_log TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO ext_app_version
  (id, latest_version_code, latest_version_name, min_version_code, download_url, file_md5, update_log)
VALUES
  (1, 10, '1.5', 0, '', '', '');
