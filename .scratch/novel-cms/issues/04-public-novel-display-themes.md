# 04 — 公共小说展示（主题）

**What to build:** 把 microfeed 公共站点改造成小说站样子——首页书卡+分类导航、书详情按卷分组的章节列表、带翻阅与目录的阅读页、可搜章节正文的搜索。全部走 `themes/feed-zh/*.mustache`，与核心零冲突。端到端覆盖：主题模板改造 → 用 seeded 模拟数据可见效果。

**Blocked by:** 01 — 数据底座与留痕引擎.

**Status:** ready-for-agent

- [ ] `web-feed.mustache`：渲染书卡（封面/书名/作者/标签/连载态）+ 分类导航（读取 `channels` 与 `genre` 列）。
- [ ] Channel 详情页模板：封面/简介/作者/标签/连载状态头图 + 章节按 `_microfeed.volume` 分组展示。
- [ ] `web-item.mustache`：章节正文 + 上一章/下一章导航 + 目录抽屉（按卷分组）+ 阅读设置（字号/背景/进度）。
- [ ] `web-search.mustache`：检索范围纳入章节正文（复用 `content_text` 列），可搜到书名/作者/章节内容。
- [ ] 端到端验证：灌入 `docs/novel-cms-design.md` §12 模拟数据（一本书+2 卷 3 章）后，首页出现书卡与分类导航、书详情按卷分组、阅读页可翻阅、搜索能命中章节正文。
- [ ] 主题改动不引入核心代码变更；`tsc --noEmit` 不适用主题，但需确认无 JS 逻辑错误。
