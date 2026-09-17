# 01 — 数据底座与留痕引擎

**What to build:** 为整个 novel-cms 改造建立可升级的数据底座——新建命名空间隔离的 `ext_*` 表与加性查询列，并实现"字段级 diff + 周期性检查点"的留痕引擎，使其经过单测验证可独立运行。这是后续所有功能工单的前置基础。

**Blocked by:** None — can start immediately.

**Status:** done
- [x] 迁移 `migrations/0023_ext_novel.sql` 创建 `ext_category`（id/name/slug/parent_id/sort/visible/created_at）、`ext_content_audit`（item_id/channel_id/action/actor_type/actor_id/diff_data/checkpoint_data/is_checkpoint/review_status/reason/created_at + 索引）、`ext_content_report`（id/item_id/channel_id/reporter_type/category/detail/status/created_at + 索引）；并以加性 `ALTER TABLE` 给 `items` 加 `review_status` 列+索引、`channels` 加 `genre` 列+索引。
- [x] 在测试实例跑该迁移，确认 `ext_*` 表与两列创建成功，且与上游 microfeed 现有表/列无命名冲突。
- [x] 实现 `src/server/feed/extContentAudit.ts`：`computeDiff(existing, next)` 产出字段级差异 JSON（标题/正文/卷章号/标签逐字段增删改）；`shouldCheckpoint(itemId, K)` 每 K 次编辑返回 true；`record(...)` 落库；`rebuildFromCheckpoint(checkpointData, diffs)` 重放 diff 重建目标版本 `data`。
- [x] 单测：给定前后两份 item `data`，断言 `diff_data` 正确反映增/删/改；断言每 K 次编辑出现一行 `is_checkpoint=1` 的检查点；断言 `rebuildFromCheckpoint` 重建出的 `data` 等于对应历史版本。
- [x] `tsc --noEmit` 全量 0 错误。
