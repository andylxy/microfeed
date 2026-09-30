# 07 — 本地导入与数据核对

**What to build:** 在本地库副本上完整跑一遍导入，用**数量与抽样**两把尺子证明数据没丢、没变形。这一步不碰生产，是后面所有工单的信心里来源。

判定标准很硬：每张表的行数必须与源库一致；抽出的正文里，$u/$w/$f 标记必须逐字符还在；不得出现字面 `\n`。

**Blocked by:** 06（转译脚本）

**Status:** done（2026-09-28，本地 miniflare 库验证全绿）

- [x] 导入本地库副本（`wrangler d1 migrations apply` 应用 0070-0072 + 33 个批次文件全部 `executed successfully`）
- [x] 行数核对（能数行的才数行）：书 13（频道）+ 3 个容器频道；**篇章 445 / 条文 8066 / 方剂 804 / 中药 172 / 名词 17 —— 与源库完全一致**
- [x] **组成与别名不是行，是内嵌数组**：`fangYaoList[]` 元素总数 = 2023、`aliases[]` = 47（随方剂/中药条目内嵌，来源由 06 的构建保证）
- [x] 按 `tcm_kind` 分组计数与源表一一对应（SQL 实测）
- [x] 正文抽验：桂枝汤全文标记逐字符完好（`$f{桂枝汤} 5味`、`$u{桂枝}$w{三两。去皮}…$u{大枣}$w{十二枚。擘}`）；标记守恒全量对账 **13342 = 13342**
- [x] 异常样本：`$m{{虚者}` 脏括号随正文完整入库（单测断言 + 桂枝汤条文序里同类样本确认）
- [x] **关联审计**：条文孤儿 0、条文与篇章跨频道 0、方剂来源频道缺失 0；长整数只出现在 `section`/`receiptNo` 排序序号
- [x] 抽查条文 → `tcm_parent_id` → 篇章条目 → `_microfeed.bookId` → 典籍频道 的链路（NOT EXISTS 全量孤儿查询 = 0）
- [x] **索引生效验证**：`EXPLAIN QUERY PLAN` 三条查询全部命中——`items_tcm_kind_parent`（篇章→条文）、`items_tcm_kind_name`（名字跳转，表达式索引生效）、`items_book_id`（书→篇章）；**无 `SCAN items`**
- [x] 重跑安全：批次为 `INSERT OR REPLACE` + 确定性 id，重放 33 个批次无重复无报错
- [x] **全量保真审计（用户要求：数据准确性必须与原始一致）**：`verify-fidelity.mts` 重新解码源 dump → 与本地 D1 读回的实际行**逐字段 diff，共 85601 个字段**（title/description 逐字节/status/book_id/tcm_parent_id/pub_date/content_text/_microfeed/genre），**0 不一致**；9504/9504 条目 + 13 频道，多出 0。（工具 `scripts/import-ctwh/verify-fidelity.mts` 直接用 node:sqlite 读 miniflare sqlite，工单 16 生产导入后可用 wrangler --json 落盘复用同一比对逻辑）
