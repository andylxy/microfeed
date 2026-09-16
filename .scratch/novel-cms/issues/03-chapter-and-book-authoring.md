# 03 — 章节与书录入

**What to build:** 让管理员/作者能高效地录入与管理小说内容——在章节编辑页填卷名与章号、在书设置里标连载/签约状态，并支持把整本 txt 批量拆章入库。端到端覆盖：章节编辑 UI → `_microfeed` 扩展字段落库 → 批量导入工具。

**Blocked by:** 01 — 数据底座与留痕引擎.

**Status:** ready-for-agent

- [ ] `src/components/admin/items/EditItemApp/index.tsx` 增加「卷名」与「章号」输入，保存到 item 的 `_microfeed.volume` / `chapterNo`（schema 为 `.loose()`，不校验、不报错）。
- [ ] Channel 设置增加「连载状态」(`serialStatus`: serializing/finished) 与「签约状态」(`signStatus`: signed/unsigned)，写入 `_microfeed`。
- [ ] 后台「txt 分章导入」工具：① 粘贴文本框（作者粘入 txt，按空行/标题正则切章，零额外依赖）；② 文件上传（存 R2 后解析，需启用 R2），两种来源都逐条调公开 API 建 item。
- [ ] 端到端验证：编辑某章的卷名/章号 → 重新打开该章确认值已持久化；粘贴一段含多个章节标题的 txt → 生成对应数量的 item（章）。
- [ ] `tsc --noEmit` 全量 0 错误。
