-- 0175_seed_book_info_rows.sql
--
-- ADR-0058：「书本信息」默认书本数据种子。把当下 10 行典籍书随迁移播种，
-- 部署到任何位置 `book_info` 都自带同一份默认数据（分组/状态已由 0172/0174 种子）。
--
-- ## 同 ID 关联 channel 书（用户诉求：book_info.id = channels.id）
--
-- 每行的 `id` 即其在 `channels` 表里对应书行（`data._microfeed.bookNo` 同号）
-- 的主键，双向同 ID 关联：由 book_info 查来源 channel、由 channel 查是否已导入。
-- 十行 id 已与 channels.id 逐一相等（2026-11-03 本地库只读探针核对），本迁移原样播种。
--
-- ## 取舍
--
-- - **只种 10 行典籍书**：排除两行 TCM 条目书（`tcmterm0001` 名词、中药）与站点
--   主 feed channel（`_WgpmyEc5Ze`，本就不在 book_info）。
-- - **空值归一 NULL**：源行 `author`/`cheng_shu`/`image_url`/`comment` 空串与 NULL
--   混杂，种子统一写 NULL（列本就可空），部署后一致。
-- - **时间戳走 DEFAULT**：`created_at`/`updated_at` 不写死，由列默认 `CURRENT_TIMESTAMP`
--   生成（种子时点即部署时点，不保留源行的导入时间）。
-- - **`hot_book` 沿用源行取值**（1 隐藏=9 本 / 0 公开=1 本），与 0174 状态清单取值一致；
--   channel 侧 status（1/2/10）是另一套字典，不参与映射。
--
-- 幂等：`INSERT OR IGNORE`（`id` 主键），重复执行/重放安全；已存在行不覆盖。
-- 类型 seed：豁免 MIG-004 回滚块要求（幂等、纯追加，无数据回退需求）。

INSERT OR IGNORE INTO book_info
  (id, book_name, chapter, author, cheng_shu, case_division, case_tag, book_no,
   image_url, hot_book, parent_id, org_id, is_enable, comment)
VALUES
  ('5IGM9t76quT', '伤寒杂病论・(桂林古本)', NULL, '张仲景', NULL, 'shanghan', '', '1001000', NULL, 1, NULL, NULL, 1, NULL),
  ('XNK0VFX39Xv', '伤寒论・(人纪)', 398, '张仲景(倪・注)', '汉朝', 'shanghan', '', '9040000', NULL, 1, NULL, NULL, 1, NULL),
  ('q6u5siNb2hT', '伤寒金匮・(宋版)', NULL, NULL, NULL, 'shanghan', '', '10001', NULL, 1, NULL, NULL, 1, NULL),
  ('ZhuBd0Vj7kl', '神农本草经・(人纪)', NULL, '倪・注', NULL, 'bencao', '', '9020000', NULL, 1, NULL, NULL, 1, NULL),
  ('OsOP62cyp3j', '神农本草经疏', NULL, '缪希雍.明', '著于公元1625年', 'bencao', '', '400100', NULL, 1, NULL, NULL, 1, NULL),
  ('Kcb7X2K5LTh', '金匮要略・(人纪)', NULL, '张仲景・汉', NULL, 'shanghan', '', '9050000', NULL, 1, NULL, NULL, 1, NULL),
  ('ydyQltIuQv6', '金匮要略・(宋版)', NULL, NULL, NULL, 'shanghan', '', '10002', NULL, 1, NULL, NULL, 1, NULL),
  ('tZYk25WiJ0R', '难经', NULL, NULL, NULL, 'neijing', '', '20100000', NULL, 1, NULL, NULL, 1, NULL),
  ('ghBqURJwurj', '黄帝内经・灵枢', NULL, NULL, NULL, 'neijing', '', '20300000', NULL, 1, NULL, NULL, 1, NULL),
  ('drsRImTi5tv', '黄帝内经・素问', NULL, NULL, NULL, 'neijing', '', '20200000', NULL, 1, NULL, NULL, 1, NULL);
