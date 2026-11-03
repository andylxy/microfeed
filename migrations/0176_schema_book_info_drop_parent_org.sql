-- 0176_schema_book_info_drop_parent_org.sql
--
-- ADR-0058：「书本信息」删掉「父级」（`parent_id`）与「预留列 OrgId」（`org_id`）。
-- 两列在模块里无业务语义：`parent_id` 是逻辑自引用（UI 的「分组→书」两层选已下线），
-- `org_id` 仅作列位保留、无组织模块。整条链路（UI/类型/store/handler/触发器/索引）
-- 一并摘除，只保留有实际用途的书本字段。
--
-- ## 改动
--
-- - 删列 `parent_id`、`org_id`；源数据两列本就全 NULL（0175 种子未写它们），
--   复制无损。
-- - 删索引 `book_info_parent_id`（只服务被删列，随重建消失、不再建）。
-- - **两条 `book_info_no_self_parent_*` 触发器随旧表 DROP 消失、不再重建**：
--   没有 `parent_id` 列，自引用约束失去意义。
--
-- ## SQLite 删列 = 12 步表重建
--
-- SQLite 无法直接 DROP 带触发器/索引的列，走「建新表 → 复制 → 删旧 → 重命名 →
-- 重建索引」。`INSERT INTO … SELECT` 用列名显式列举，跳过 `parent_id`/`org_id`。
--
-- 类型 seed（DDL）：豁免 MIG-004 回滚块要求（幂等、结构变更无数据回退需求）。
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS，重复执行安全。

CREATE TABLE IF NOT EXISTS book_info_new (
  id              VARCHAR(11) PRIMARY KEY,
  book_name       VARCHAR(255) NOT NULL,       -- BookName 书名（看板排序键）
  chapter         INTEGER,                     -- Chapter 总卷章数
  author          VARCHAR(255),                -- Author 作者
  cheng_shu       VARCHAR(255),                -- ChengShu 成书时间
  case_division   VARCHAR(255) NOT NULL,       -- Case 内容划分（保留字 → case_division）
  case_tag        TEXT NOT NULL DEFAULT '',    -- CaseTag 内容标签（文本）
  book_no         TEXT NOT NULL DEFAULT '',    -- BookNo 书本编号（文本）
  image_url       VARCHAR(255),                -- ImageUrl 封面
  hot_book        INTEGER NOT NULL DEFAULT 0,  -- HotBook 状态（0 公开 / 1 隐藏 / 2 会员）
  is_enable       INTEGER NOT NULL DEFAULT 1,  -- IsEnable 启用
  comment         VARCHAR(255),                -- Comment 备注
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP,                   -- 软删除
  ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
  ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
);

INSERT INTO book_info_new (
  id, book_name, chapter, author, cheng_shu, case_division, case_tag, book_no,
  image_url, hot_book, is_enable, comment,
  created_at, updated_at, deleted_at,
  ext1, ext2, ext3, ext4, ext5, ext6, ext7, ext8, ext9, ext10
)
SELECT
  id, book_name, chapter, author, cheng_shu, case_division, case_tag, book_no,
  image_url, hot_book, is_enable, comment,
  created_at, updated_at, deleted_at,
  ext1, ext2, ext3, ext4, ext5, ext6, ext7, ext8, ext9, ext10
FROM book_info;

DROP TABLE book_info;
ALTER TABLE book_info_new RENAME TO book_info;

-- 索引：父级索引随列消失（不再建），书名/启用/分组归属照旧。
CREATE INDEX IF NOT EXISTS book_info_book_name    ON book_info (book_name);
CREATE INDEX IF NOT EXISTS book_info_is_enable    ON book_info (is_enable);
CREATE INDEX IF NOT EXISTS book_info_case_division ON book_info (case_division);

-- 注：`book_info_no_self_parent_ins` / `_upd` 两条触发器**不重建**——`parent_id`
-- 已删，自引用约束失去意义；旧表 DROP 时它们已一并消失。
