-- 0115_seed_annotation_marker_site_local.sql
--
-- 站点自有标记码补样式配置（票04）。源 App `TipsTextRenderConfig` 的目录只有
-- 13 枚（spec `.scratch/tcm-import/spec.md` §4.2：u/w/f/q/a/m/n/x/g/r/v/y/h）；
-- 本批两枚**不在源目录里**，是导入数据中反复出现、语义稳定的站点自有码，按 `$a`
-- （灰 `#808080` + 0.7× 小字、linkType 0）的既有处理补配置，使其从
-- `mf-mk-unknown` 灰色降级升级为带语义类名（`mf-mk-s` / `mf-mk-l`）的正式条目：
--
--   $s  方剂「右X味」总起（煎服说明的引出句）——227 条，全部出现在 fang 条目
--   $l  校勘异文注（如「一本作常」「一作癃」）——18 条，全部出现在《难经》篇章
--
-- **明确不为 `$fm` 补配置**：全库仅 1 处，且是把「温中」的「中」字重复包了一层
-- 的录入误标（`$m{温中}的$fm{中}就是$n{肠胃消化系统}`），属数据噪音，继续走
-- `mf-mk-unknown` 灰色降级即可，不为一个错标污染标记目录。
--
-- 这两枚是站点本地约定，**不是源 App 定义**；颜色 / 小字后续可在后台直接改，
-- 不影响渲染链路（渲染器按 code 通用查找，见 `src/shared/TcmMarkers.ts`）。
-- sort_order 取 140 / 150，接在源目录 13 枚（10–130）之后，不打乱既有顺序。
--
-- rollback:
--   DELETE FROM ext_annotation_markers WHERE code IN ('s', 'l');

INSERT OR IGNORE INTO ext_annotation_markers
  (id, code, title, multi, sort_order, color, small_font, link_type,
   created_at_ms, updated_at_ms)
VALUES
  ('am_s', 's', '$s 总起', 0, 140, '#808080', 1, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('am_l', 'l', '$l 异文', 0, 150, '#808080', 1, 0,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000);
