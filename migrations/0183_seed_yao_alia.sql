-- 0183_seed_yao_alia.sql
--
-- ADR-0064：独立「药材别名」模块 yao_alia 建表 + 专属权限码 + 页面节点 + 47 行默认种子。
-- 数据源 `ctwh/YaoAlia.sql`（47 行、32 列），镜像上游 `vol.api.sqlsugar` 的 YaoAlia 实体。
-- 范式照抄 ADR-0060 ming_ci / ADR-0061 zhong_yao / ADR-0062 book_chapter：自持一张表，
-- 不碰 items/channels/settings/ext_tcm_aliases，与既有「层层叠加」的别名链路
-- （items 口袋字段 → getDerivedYaoAliases → getAppYaoAliases → GetAliaZhongYao / /admin/aliases/）
-- 并行共存、互不读写、互不迁移。部署到任何位置 yao_alia 都自带同一份 47 行默认数据。
--
-- ## 数据变换（2026-11-04 只读探针审计，证据 .scratch/yao-alia-module/probe-output.txt）
--
-- - id：确定性 10 字符 `ya` + 源 Id 8 位零填充（ya00000001..ya00000047）。刻意**不调用**
--   scripts/import-ctwh/build.ts 的 tcmId，避免与 TCM 导入管线产生作者期耦合；
--   新建行走 randomShortUUID()（默认 11 位）。与既有四张独立表种子 id 碰撞核对见 ADR-0064。
-- - yao_alia_no：源 yaoAliasNo 1-47 连续，原样。create 走 MAX+1（next=48），UNIQUE 冲突 fail-fast。
-- - yao_alia_bie_ming：源 YaoBieMing 原样、不 trim 不归一。47/47 distinct，UNIQUE。
--   软删行仍占用该唯一键，要复用同名别名须先在「已删除」折叠区物删该行。
-- - yao_alia_name：源 YaoName 原样。30/47 distinct（地黄 6、白术/大枣/小麦 各 3 …），
--   非 UNIQUE——左栏按正名只读派生分组即依据此列。
-- - is_enable：源 IsEnable 47/47 全 1。无状态枚举，不建 settings 状态清单（同 ADR-0060 决策 1）。
-- - signature_id / signature：源 SignatureId/Signature 47/47 全 NULL，列位保留（同 0177/0180 先例），
--   admin 不编辑、不做外键。
-- - 行尾空格：源实测 0；4 个文本字段内 CR/LF 0、单引号 0、别名内空格 0。
--   源物理换行是 CRLF（47 处），属行分隔符，非字段内容；迁移用 LF 书写不构成内容损失。
-- - 去框架专属列：源 20 列全 NULL（Extend01-12/OtherMark/ParentId/ExtJson/OrgId/
--   YaoText/CreateID/Creator/CreateDate/ModifyID/Modifier/ModifyDate/IsDelete 等）不建，
--   以 ext1-ext10 预留。审计列（Create*/Modify*）不迁移——microfeed 用 created_at/updated_at。
--
-- ## 权限（ADR-0064：专属码，不复用 content:alias:*）
--
-- 新增专属码 `content:yao-alia:read` / `content:yao-alia:manage`。不复用既有
-- `content:alias:*`（旧 /admin/aliases/ 页占用，授权边界须独立）、`content:yao:*`
-- （yao/zhongyao 占用）、`content:book:*`（book-info 占用）。连字符合法，
-- 先例 `content:book-status:manage`。三镜像的另两处在 `src/shared/Constants.ts`
-- 与 `src/server/rbac/seed.ts`。
--
-- 页面节点 sort=115（book_chapter=114 之后，当前 group_content 下最大），icon 复用 `tags`
-- （MENU_ICON_NAMES 已含，免新增 `menu.icon.*` 双语标签）。
--
-- 幂等：全部 CREATE IF NOT EXISTS / INSERT OR IGNORE，重复执行安全，只播不覆盖。

-- 1. 别名实体表
CREATE TABLE IF NOT EXISTS yao_alia (
  id                VARCHAR(11) PRIMARY KEY,       -- randomShortUUID()；种子确定性 ya+源Id
  yao_alia_no       INTEGER NOT NULL,              -- 源 yaoAliasNo（种子 1-47；create 走 MAX+1）
  yao_alia_bie_ming VARCHAR(255) NOT NULL,         -- 源 YaoBieMing 别名（必填，唯一）
  yao_alia_name     VARCHAR(255) NOT NULL,         -- 源 YaoName 正名（必填，非唯一，分组键）
  is_enable         INTEGER NOT NULL DEFAULT 1,    -- 源 IsEnable（无状态枚举，全 1）
  signature_id      VARCHAR(64),                   -- 源 SignatureId（列位保留，admin 不编辑）
  signature         VARCHAR(64),                   -- 源 Signature（列位保留，admin 不编辑）
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at        TIMESTAMP,                     -- 软删（源 IsDelete 全 0）
  ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
  ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
);

-- 2. 索引：点查/窄范围，避免全表扫描（08 册）
-- 看板整表 ORDER BY yao_alia_no 走唯一索引全序扫，免表扫 + 免外排。
CREATE UNIQUE INDEX IF NOT EXISTS yao_alia_no_unique       ON yao_alia (yao_alia_no);
CREATE UNIQUE INDEX IF NOT EXISTS yao_alia_bie_ming_unique ON yao_alia (yao_alia_bie_ming);
CREATE INDEX IF NOT EXISTS yao_alia_name                   ON yao_alia (yao_alia_name);

-- 3. 权限码（id 与 permissionId() 逐字节一致：p_<code 中 ':' → '_'>）
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_yao-alia_read',   'content:yao-alia:read',   '药材别名查看'),
  ('p_content_yao-alia_manage', 'content:yao-alia:manage', '药材别名维护');

-- 4. 页面节点 + 码叶子（侧栏读节点表；ADR-0038：码叶子挂 page 下）
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms, path, entry_code) VALUES
  ('pn_page_yao_alia', 'page_yao_alia', 'page', 'group_content', 115, 'desktop', NULL,
   '药材别名', 'Yao aliases', 'tags', NULL, 1, 'seed',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'yao-alia', 'content:yao-alia:read');

INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_content_yao-alia_read', 'content:yao-alia:read', 'code', 'page_yao_alia', 1, 'desktop', 'content:yao-alia:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_content_yao-alia_manage', 'content:yao-alia:manage', 'code', 'page_yao_alia', 2, 'desktop', 'content:yao-alia:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 5. 47 行默认种子（源 YaoAlia.sql 全量；INSERT OR IGNORE 只播不覆盖）
INSERT OR IGNORE INTO yao_alia
  (id, yao_alia_no, yao_alia_bie_ming, yao_alia_name, is_enable)
VALUES
  ('ya00000001', 1, '术', '白术', 1), -- 1 术
  ('ya00000002', 2, '朮', '白术', 1), -- 2 朮
  ('ya00000003', 3, '白朮', '白术', 1), -- 3 白朮
  ('ya00000004', 4, '桂', '桂枝', 1), -- 4 桂
  ('ya00000005', 5, '桂心', '桂枝', 1), -- 5 桂心
  ('ya00000006', 6, '白芍药', '芍药', 1), -- 6 白芍药
  ('ya00000007', 7, '枣', '大枣', 1), -- 7 枣
  ('ya00000008', 8, '枣膏', '大枣', 1), -- 8 枣膏
  ('ya00000009', 9, '枣肉', '大枣', 1), -- 9 枣肉
  ('ya00000010', 10, '生姜汁', '生姜', 1), -- 10 生姜汁
  ('ya00000011', 11, '姜', '生姜', 1), -- 11 姜
  ('ya00000012', 12, '生葛', '葛根', 1), -- 12 生葛
  ('ya00000013', 13, '生地黄', '地黄', 1), -- 13 生地黄
  ('ya00000014', 14, '干地黄', '地黄', 1), -- 14 干地黄
  ('ya00000015', 15, '生地', '地黄', 1), -- 15 生地
  ('ya00000016', 16, '熟地', '地黄', 1), -- 16 熟地
  ('ya00000017', 17, '生地黄汁', '地黄', 1), -- 17 生地黄汁
  ('ya00000018', 18, '地黄汁', '地黄', 1), -- 18 地黄汁
  ('ya00000019', 19, '甘遂末', '甘遂', 1), -- 19 甘遂末
  ('ya00000020', 20, '茵陈蒿末', '茵陈蒿', 1), -- 20 茵陈蒿末
  ('ya00000021', 21, '大附子', '附子', 1), -- 21 大附子
  ('ya00000022', 22, '川乌', '乌头', 1), -- 22 川乌
  ('ya00000023', 23, '粉', '白粉', 1), -- 23 粉
  ('ya00000024', 24, '白蜜', '蜜', 1), -- 24 白蜜
  ('ya00000025', 25, '食蜜', '蜜', 1), -- 25 食蜜
  ('ya00000026', 26, '杏子', '杏仁', 1), -- 26 杏子
  ('ya00000027', 27, '葶苈', '葶苈子', 1), -- 27 葶苈
  ('ya00000028', 28, '香豉', '豉', 1), -- 28 香豉
  ('ya00000029', 29, '肥栀子', '栀子', 1), -- 29 肥栀子
  ('ya00000030', 30, '生狼牙', '狼牙', 1), -- 30 生狼牙
  ('ya00000031', 31, '清酒', '酒', 1), -- 31 清酒
  ('ya00000032', 32, '白酒', '酒', 1), -- 32 白酒
  ('ya00000033', 33, '艾叶', '艾', 1), -- 33 艾叶
  ('ya00000034', 34, '乌扇', '射干', 1), -- 34 乌扇
  ('ya00000035', 35, '赭石', '代赭石', 1), -- 35 赭石
  ('ya00000036', 36, '代赭', '代赭石', 1), -- 36 代赭
  ('ya00000037', 37, '煅灶下灰', '煅灶灰', 1), -- 37 煅灶下灰
  ('ya00000038', 38, '干苏叶', '苏叶', 1), -- 38 干苏叶
  ('ya00000039', 39, '蛇床子仁', '蛇床子', 1), -- 39 蛇床子仁
  ('ya00000040', 40, '小麦汁', '小麦', 1), -- 40 小麦汁
  ('ya00000041', 41, '小麦粥', '小麦', 1), -- 41 小麦粥
  ('ya00000042', 42, '麦粥', '小麦', 1), -- 42 麦粥
  ('ya00000043', 43, '大麦粥', '大麦', 1), -- 43 大麦粥
  ('ya00000044', 44, '大麦粥汁', '大麦', 1), -- 44 大麦粥汁
  ('ya00000045', 45, '葱白', '葱', 1), -- 45 葱白
  ('ya00000046', 46, '法醋', '苦酒', 1), -- 46 法醋
  ('ya00000047', 47, '硝石', '赤消', 1); -- 47 硝石
