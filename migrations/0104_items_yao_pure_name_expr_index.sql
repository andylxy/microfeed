-- 0104: items 加表达式索引，让「中药名」按纯药名（去掉 title 的 `N、` 序号前缀）精确 seek
--
-- 背景：`$u{吴茱萸}` 这类中药标记里存的是**纯药名**，而中药条目的 `data.title`
-- 是带序号的展示名（`1、甘草`、`63、吴茱萸` …）。`items_tcm_kind_name` 建在
-- 原始 title 上，所以按纯名过滤**用不了它**，只能命中 `tcm_kind=?` 前缀、把全部
-- 172 条中药扫一遍（实测 172 行读；对照方剂按名解析只要 5 行）。
--
-- 做法（与 0070 `items_tcm_kind_name`、0093 `items_bie_ming` 同一手法）：把
-- 「纯名」写成确定性表达式再建索引。`instr(title,'、')` 对**不含 `、` 的标题**
-- 返回 0，`substr(title, 0+1)` 即整串，行为安全（本索引只按 `tcm_kind='yao'` 使用）。
--
-- ⚠️ 谓词必须写成**完全相同的表达式**（含空格），SQLite 才会选中本索引：
--   substr(json_extract(data, '$.title'), instr(json_extract(data, '$.title'), '、') + 1)
--   写成 `substr(...)` 的等价变形（如先取 title 到变量、或改动空格）都会失配。
--
-- ⚠️ 配套的查询形状约束（实测，见 `.scratch/fang-marker/shape-matrix*.mts`）：
--   1. `status` **绝不能写等值 `= 1`** —— 规划器会改选 `items_status_created_at`
--      扫全表 9506 行（本库 9506 行全部 status=1，等值过滤无区分度）。
--      一律写 `status IN (1, 4)`（PUBLISHED + UNLISTED，与 `/i/[slug]` 的可见性一致）。
--   2. `tcm_kind` 必须是等值单值 `= 'yao'`；写成 `IN ('fang','yao')` 会让规划器
--      放弃索引，退回 `items_status_created_at` 全表 9508 行。
--   3. 方剂按名解析时 `book_id` **不能进 WHERE**（会让规划器改走 `items_book_id`，
--      5 行 → 659 行）；当前书的过滤放到应用层做。
--
-- `data` 仍是唯一事实来源；纯索引，不改写入路径。回滚：DROP INDEX items_yao_pure_name。

CREATE INDEX IF NOT EXISTS items_yao_pure_name
  ON items (
    tcm_kind,
    substr(json_extract(data, '$.title'), instr(json_extract(data, '$.title'), '、') + 1),
    id
  );
