# ADR-0004: 高频查询字段落成真实列（review_status / genre）

- 状态：Accepted
- 日期：2026-09-16
- 决策人：用户

## 背景（G2 设计硬 bug）

设计原 §7.4 写"查询 `items WHERE _microfeed.reviewStatus='submitted'`"——**无效 SQL**。因为 `_microfeed` 是塞在 `data` JSON 内部的字段，不是数据库列，D1 不会自动索引它。审核队列（按 reviewStatus 查）、分类筛选（按 genre 查 channel）都依赖这类查询，原写法做不出来。

## 决策

将高频查询字段**落成真实加性列 + 索引**（在我们的迁移 `0023` 内）：
- `items` 表加 `review_status TEXT` + 索引（审核队列查询）。
- `channels` 表加 `genre TEXT` + 索引（分类筛选查询）。

写入时在 item/channel 写入 handler 同步镜像：`_microfeed.reviewStatus` / `_microfeed.genre` 仍作为 API 面向字段（宽松 schema 不变），同时写入对应列供查询。

## 理由（trade-off）

- **A（真实列，本决策）**：查询干净、可索引、快；属于"加性改动"（`ALTER TABLE ... ADD COLUMN`），上游升级不会删我们的列，仍升级安全。
- 备选 B（`json_extract(data, ...)`，零碰核心表）：最纯净但大站点（数千章）JSON 查询慢，且需配合生成列才有索引。
- 选 A 是因审核队列/分类筛选是核心查询，值得索引；加性列不破坏上游兼容性。

## 影响

- 修订 §7.4 / §5 分类页查询：改用 `WHERE review_status=?` / `WHERE genre=?`。
- 卷章排序（`volume` / `chapter_no` / `order`）暂仍走 `_microfeed` + 应用层分组/排序（单 channel 内章节量可控）；若未来单书章节量极大，再评估把这些也落成列。
- 主设计文档 `novel-cms-design.md` 相关段落待共识达成后统一回写。
