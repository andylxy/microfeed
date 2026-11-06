-- 0187_data_tcm_align_netcore.sql
--
-- 把 `zhong_yao` / `ming_ci` 的别名列与文本换行对齐 netcore 后端导出的原始形态。
-- 背景：0179 / 0180 导入时做过两处多余转换（ADR-0060 / ADR-0061 勘误见同批文档）：
--   1) `zhong_yao_list` / `ming_ci_list` 用 `JSON.stringify(split(',').map(trim))`
--      写成了 JSON 数组字符串，且 split 后残留的 SQL 单引号被一并 stringify
--      （如 `["'地文","水玉","守","示姑'"]`）；netcore 原列是纯逗号文本
--      （`地文,水玉,守,示姑`）。
--   2) `ming_ci_text` 的换行被改写为 CRLF；netcore 源（ctwh/BeiMingCi.sql）
--      实测 0 个 `\r\n`、108 个 `\n`，为纯 LF。
--   3) `ming_ci_name` 的源行「畏\n」被 trim 成「畏」。
--
-- 量化（本地实例库，2026-11-06 只读探针）：
--   zhong_yao_list  172 行全部为 JSON 形态，转换后 120 行空 / 52 行非空（与源一致）
--   ming_ci_list     17 行全部为 JSON 形态，转换后  12 行空 /  5 行非空（与源一致）
--   ming_ci_text      7 行含 CRLF
--   ming_ci_name      1 行为「畏」（需还原尾随换行）
--
-- 幂等：三条 UPDATE 均带前置条件（`LIKE '[%'` / `instr(…)>0` / `= '畏'`），
-- 重放时已转换的行不再命中，不会二次改写。
--
-- 刻意不修：`fang_yao.fang_text` 有 15 行与 netcore 源不同，差异全部是花括号
-- 标记不配平（源如 `$w{四两|` 缺 `}`），microfeed 导入时做了配平修复；去掉花括号后
-- 15/15 正文相同。这是有意修复源数据缺陷，不属导入错误，故本迁移不碰 fang_yao。
--
-- rollback:
--   本迁移只做「收敛到 netcore 源形态」的确定性变换，回滚需从 0179 / 0180 种子
--   重新播种两表（`INSERT OR IGNORE` 不含已存在行，须先 DELETE 再重放种子段）。
--   文本换行（CRLF / 尾随换行）无法从变换后的数据反推原本形态，故不提供行级回滚。

-- 1) zhong_yao_list：JSON 数组 → 纯逗号文本（清残留单引号、丢空 token）
UPDATE zhong_yao
SET zhong_yao_list = COALESCE(
    (
      SELECT group_concat(
        CASE
          WHEN replace(trim(je.value), '''', '') = '' THEN NULL
          ELSE replace(trim(je.value), '''', '')
        END,
        ','
      )
      FROM json_each(zhong_yao.zhong_yao_list) je
    ),
    ''
  )
WHERE zhong_yao_list LIKE '[%';

-- 2) ming_ci_list：同上
UPDATE ming_ci
SET ming_ci_list = COALESCE(
    (
      SELECT group_concat(
        CASE
          WHEN replace(trim(je.value), '''', '') = '' THEN NULL
          ELSE replace(trim(je.value), '''', '')
        END,
        ','
      )
      FROM json_each(ming_ci.ming_ci_list) je
    ),
    ''
  )
WHERE ming_ci_list LIKE '[%';

-- 3) ming_ci_text：CRLF → LF（netcore 源为纯 LF）
UPDATE ming_ci
SET ming_ci_text = replace(ming_ci_text, char(13) || char(10), char(10))
WHERE instr(ming_ci_text, char(13) || char(10)) > 0;

-- 4) ming_ci_name：还原「畏」的尾随换行（精确匹配，防重跑追加成两个换行）
UPDATE ming_ci
SET ming_ci_name = ming_ci_name || char(10)
WHERE ming_ci_name = '畏';
