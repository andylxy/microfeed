# 06 — 新后台页中文化（可选）

**What to build:** 把 novel-cms 新增的后台管理页（分类管理、章节录入扩展项、审核队列、审计详情、举报下架）的文案接入既有 i18n 体系，显示为简体中文，与项目已有的后台中文化风格一致。

**Blocked by:** 02 — 分类管理, 03 — 章节与书录入, 05 — 内容审核与留痕.

**Status:** ready-for-agent

- [ ] 在 `src/shared/i18n/en.ts` 与 `zh-CN.ts` 新增 novel-cms 后台所需命名空间/key（分类、卷章、审核、审计、举报等），`zh-CN.ts` 用 `TranslationKey` 类型由 en 推导保证形状一致。
- [ ] 在 02/03/05 新增的后台组件中以 `useTranslation()`（函数组件）或 `i18n.t.bind(i18n)`（class 组件）接入 `t()`，移除硬编码英文 UI 串。
- [ ] 全量 `tsc --noEmit` 0 错误；对新增后台目录复扫残留英文 UI 串为零（i18n key 字符串与映射源除外）。
- [ ] 注：纯展示性扩展，不改任何数据模型或公开 API 契约。
