-- 0086_ext_app_announcement.sql
--
-- App 消息通知（Announcements，需求衍生；DESIGN.md §5.1）。
-- 后端主动给移动端推送「运营/系统消息」（停服通知、版本说明、活动提示等）。
--
-- ## 状态语义（软删，不 DROP）
--
--   status: 1 draft 草稿 / 2 published 已发布 / 3 expired 已过期 / 4 deleted 已删除
--
-- 删除动作 = 置 `4`（保留审计）；过期动作 = 置 `3`。两者都让该条「不再生效」，
-- 与 `valid_to` 自动过期（时间窗口越过仍 published）并列，结果等价。
-- 公开端点 `GET /api/app/announcements` 只取 `status=2` 且在 `[valid_from, valid_to]`
-- 窗口内的行，所以「已发布但 valid_to 已过」的行在公开侧自然消失，但在管理后台
-- 的「已过期」标签下仍需单独列出（见 §5.4，status=3 或 status=2 且 valid_to<now）。
--
-- ## 时间字段
--
-- `valid_from` / `valid_to` 以 **unix 毫秒（UTC）** 存储，可空：空端 = 无边界
-- （空 from = 立即可见；空 to = 永不过期，除非手动置 status=3）。
-- 客户端只比较大小，不涉时区换算（§5.6）。
--
-- ## version：客户端去重用的「内容指纹」
--
-- 每次**内容编辑**（title/body 改动）自增；仅改时间窗口/状态不增。
-- 客户端按 `id→version` 记忆已读，`seenVersion < ann.version` 即视为「改过内容→重弹一次」。
--
-- ## 索引
--
-- 公开查询固定 `WHERE status=2` + `ORDER BY priority DESC, updated_at DESC`，
-- 复合索引 `(status, priority DESC, updated_at DESC)` 直接覆盖，避免全表排序。
-- 升/降序必须与查询完全一致，否则索引失效（priority 必须 DESC）。
--
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / INSERT OR IGNORE。

-- 1. 公告表
CREATE TABLE IF NOT EXISTS ext_app_announcement (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL DEFAULT '',
  status      INTEGER NOT NULL DEFAULT 1,          -- 1 draft / 2 published / 3 expired / 4 deleted
  priority    INTEGER NOT NULL DEFAULT 0,          -- 越大越先弹
  valid_from  INTEGER,                             -- unix ms，可空 = 无起点
  valid_to    INTEGER,                             -- unix ms，可空 = 无终点
  version     INTEGER NOT NULL DEFAULT 1,          -- 内容编辑自增，供客户端判断重弹
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 公开查询（status=2 过滤 + priority desc, updated_at desc 排序）的覆盖索引。
CREATE INDEX IF NOT EXISTS idx_ann_status ON ext_app_announcement (status, priority DESC, updated_at DESC);
