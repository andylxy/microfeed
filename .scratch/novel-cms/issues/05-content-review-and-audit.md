# 05 — 内容审核与留痕

**What to build:** 实现带留痕的内容审核——每次章节修改自动记录字段级 diff + 周期性检查点（回答"原始/修改/时间/谁/改了什么"），提供审核队列、审计详情（diff 高亮）、恢复到任意历史版本、匿名举报与下架。端到端覆盖：写接缝挂留痕 → 状态机 → 队列/详情页 → 举报下架。

**Blocked by:** 01 — 数据底座与留痕引擎, 03 — 章节与书录入.

**Status:** ready-for-agent

- [ ] 在 item 写接缝（`src/server/api/handlers.ts` 的 item PUT/POST 处）挂 `extContentAudit.record(...)`（字段级 diff + 每 K 次检查点），并把 `reviewStatus` 镜像进 `items.review_status` 真实列；核心仅此一处调用，逻辑收口在 `extContentAudit` 模块。
- [ ] 审核状态机：`draft → submitted → approved / rejected`，配合 item `status`（`unpublished ↔ published`）；通过=`approved`+`published`，驳回=`rejected`+`unpublished`+`reason`。
- [ ] 后台审核队列页：`SELECT * FROM items WHERE review_status='submitted'` 列出待审章；`ext_content_report WHERE status='pending'` 列出待处理举报。
- [ ] 审计详情页：列出某 item 的全部审计行（时间/谁/动作），点开渲染 `diff_data` 字段级差异高亮（增/删/改）。
- [ ] 恢复：定位目标版本之前最近检查点 → 向前重放 diff 序列重建目标版本 `data` → 回填 item。
- [ ] 读者匿名举报表单 → 写 `ext_content_report`；后台「违规下架」置 `status=unpublished` 或加 `_microfeed.takedown=true` 并记一条 `takedown` 审计。
- [ ] 端到端验证（用手动走查）：作者提交章 → 进审核队列；修改章 → `ext_content_audit` 出现 `diff_data`/时间/作者/动作；从检查点+diff 恢复 → 内容回到目标版本；读者举报 → 举报队列出现 `pending`。
- [ ] `tsc --noEmit` 全量 0 错误。
