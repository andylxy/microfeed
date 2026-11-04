-- 0177_seed_ming_ci.sql
--
-- ADR-0060：独立「名词」模块 `ming_ci`。
--
-- 参考 `D:\git\web\Vue.NetCore\vol.api.sqlsugar` 的 `BeiMingCi` 实体镜像：
--   MingCiNo/MingCiName/MingCiBeiMing/MingCiText/MingCiList/SoureBook/MingCiType/
--   ShowImage/Remark/IsEnable/SignatureId/Signature。字段名 microfeed 惯例
--   （snake_case）；`MingCiList` 是 JSON 数组字符串（镜像 App 形状
--   `mingCiList: string[]`）；`source_book_id` 是到 `book_info.id` 的逻辑引用
--   （无硬外键，与 ADR-0058 一致）；`ming_ci_type` 是分组 `key`（严格校验命中
--   `mingci_groups`，ADR-0060 决策 4）。
--
-- 与既有 `items`/`channels` 名词机制**完全解耦**：不写 items/channels/ext_*、
-- 不迁移既有 `tcm_kind='term'` 行。两套名词模型并行共存（ADR-0060 决策 2）。
--
-- **无状态枚举**：参考实体只有 `IsEnable`，故只留 `is_enable` 布尔，**不建
-- settings 状态清单**（对比 ADR-0058 的 hot_book + book_info_statuses，刻意取舍）。
--
-- 播种 `page_ming_ci` 权限树页面节点（复用既有 `content:term:read`，
-- 不加新权限码——ADR-0060 决策 6）。列序按 0127 + 0133（path/entry_code/
-- audience），sort=112（group_content 下 book_info=111 之后）。
--
-- 幂等：全部 CREATE IF NOT EXISTS / INSERT OR IGNORE，重复执行安全。

CREATE TABLE IF NOT EXISTS ming_ci (
  id              VARCHAR(11) PRIMARY KEY,      -- 确定性 11 位短 id（真 tcmId 预计算）
  ming_ci_no      INTEGER NOT NULL,             -- MingCiNo 名词ID（种子 0–16，唯一，显示/排序）
  ming_ci_name    VARCHAR(255) NOT NULL,        -- MingCiName 名词名称（必填）
  ming_ci_bei_ming VARCHAR(255),                -- MingCiBeiMing 名词别名
  ming_ci_text    TEXT NOT NULL,                -- MingCiText 名词内容（含 $m{}/$n{}/$x{}/$a{} 标记，原样存储不解析）
  ming_ci_list    TEXT NOT NULL DEFAULT '[]',   -- MingCiList 别名列表（JSON 数组字符串，镜像 App 形状）
  source_book_id  VARCHAR(11),                  -- SoureBook 名词来源书 → book_info.id（逻辑引用，无硬外键）
  ming_ci_type    VARCHAR(255) NOT NULL,        -- MingCiType 归纳分类（必填；取值=分组 key，严格校验命中 mingci_groups）
  show_image      VARCHAR(255),                 -- ShowImage 展示图（源路径字符串；microfeed 内不一定可解析，UI 降级）
  remark          TEXT,                         -- Remark 备注
  is_enable       INTEGER NOT NULL DEFAULT 1,   -- IsEnable 启用（无状态枚举，全 1）
  signature_id    VARCHAR(64),                  -- SignatureId App 签名链路保真（列位保留，admin 不编辑）
  signature       VARCHAR(64),                  -- Signature App 签名链路保真（列位保留，admin 不编辑）
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP,                    -- 软删除
  ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
  ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
);

-- 点查/窄范围索引（08 册，避免全表扫描）：
CREATE INDEX IF NOT EXISTS ming_ci_name    ON ming_ci (ming_ci_name);
CREATE INDEX IF NOT EXISTS ming_ci_type    ON ming_ci (ming_ci_type);
CREATE INDEX IF NOT EXISTS ming_ci_source  ON ming_ci (source_book_id);
-- 名词ID 唯一（seed 0–16；create 走 MAX+1 事务生成，冲突 fail-fast）。
CREATE UNIQUE INDEX IF NOT EXISTS ming_ci_no_unique ON ming_ci (ming_ci_no);

-- 播种页面节点（复用 content:term:read，不加新码；icon 复用 `tags` 免 check-i18n 新图标标签）。
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms, path, entry_code)
VALUES
  ('pn_page_ming_ci', 'page_ming_ci', 'page', 'group_content', 112, 'desktop', NULL,
   '名词', 'Ming ci', 'tags', NULL, 1, 'seed',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'ming-ci', 'content:term:read');
