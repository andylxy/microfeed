-- 0188_data_ming_ci_repair_row10_text.sql
--
-- 单行内容修复：`ming_ci` 中 `ming_ci_no = 10`（名词「须」）的正文在本地实例库里
-- 有一处断行与缺字，与 netcore 导出源（`ctwh/BeiMingCi.sql`）及 0179 种子都不一致。
--
-- 实测（2026-11-06）：
--   源 / 0179 种子：…临床用药要充分利**用；**如麻黄配枝枝…
--   本地 DB      ：…临床用药要充分利<LF><4 空格>如麻黄配枝枝…
--   即 `用；` 缺失、多出一个换行 + 4 空格缩进。
--   全库仅此 1 行命中该模式（`instr(ming_ci_text, '充分利'||char(10)||'    如') > 0`）。
--
-- 幂等：命中模式被替换后不再存在，重放不会二次改写。
--
-- rollback:
--   反向替换会破坏「源本来就是连续文本」的事实，不提供行级回滚；
--   如需还原，从 0179 种子重新播种该表。

UPDATE ming_ci
SET ming_ci_text = replace(
      ming_ci_text,
      '充分利' || char(10) || '    如',
      '充分利用；如'
    )
WHERE ming_ci_no = 10
  AND instr(ming_ci_text, '充分利' || char(10) || '    如') > 0;
