# 02 — 分类管理

**What to build:** 让管理员能维护小说题材分类（单主分类 + 多标签模型），并把书归到分类下，使公共站点出现分类导航与可按题材筛选的分类页。端到端覆盖：分类表（已由 01 建）→ 后台管理页 → 书表单绑定 → 主题展示。

**Blocked by:** 01 — 数据底座与留痕引擎.

**Status:** ready-for-agent

- [ ] 新增后台路由 `[adminPath]/categories`：分类的增 / 删 / 改、排序（sort）、展示开关（visible）。
- [ ] Channel 设置表单增加「主分类」下拉（来源 `ext_category`）与「多标签」输入（自由标签数组）；保存时把主分类 id 镜像进 `channels.genre` 真实列（在 channel 写入处做轻量镜像，不碰 SSOT）。
- [ ] 主题 `web-feed.mustache` 改为展示「分类导航」（按 `channels.genre` 聚合）；新增分类页路由/模板，按 `channels.genre` 列过滤出该分类下的书。
- [ ] 端到端验证：建一个分类（如「东方玄幻」）→ 给《星河剑歌》绑该主分类 → 首页分类导航出现该分类、点进分类页能看到这本书。
- [ ] `tsc --noEmit` 全量 0 错误；新增后台页按既有 `src/shared/i18n` 接入文案（英文 key 即可，中文由 06 统一处理）。
