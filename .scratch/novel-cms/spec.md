# Spec — microfeed 改造为「小说站 CMS」

> Status: ready-for-agent
> Feature slug: `novel-cms`
> Source of truth: `docs/novel-cms-design.md`（评审完成，2026-09-16）、`docs/novel-cms/CONTEXT.md`、`docs/novel-cms/adr/0001–0004`
> Domain glossary: `docs/novel-cms/CONTEXT.md` (Book/Chapter/Volume/Category/Audit Record/Report)

## Problem Statement

用户想把 microfeed（一个 RSS/Atom 发布引擎，数据模型为 Channel→Item）改造成一个**前端展示、后端管理**的小说站 CMS，支持：分类、书、章节管理，以及**带留痕的内容审核**（要能回答"原始内容 / 修改后内容 / 什么时候改的 / 谁改的 / 改了什么"）。

同时有一条硬约束：**不能碰上游核心、不能影响后续版本升级**。即所有扩展必须可以干净地 rebase 到上游新版本上。

已验证的关键事实（非假设）：
- 内容**全部进 D1 数据库**（书/章正文 `JSON.stringify` 进 `data TEXT` 列），无文件存储路径；microfeed 是 Cloudflare Worker + D1，客观上只能用 DB。
- `_microfeed` 是 item/channel `data` JSON 内部的扩展口袋（`.loose()` schema 不校验），但**它内部的字段不是数据库列**，不能直接 `WHERE` 查询。
- microfeed 的 API Key 是全局的（仅 `content:read/write`，无 channel 绑定），账户是单管理员——所以"按书授权作者"不可行。

## Solution

用"**升级零冲突**"的扩展策略，把小说领域概念映射到 microfeed 现有实体，并新增一组命名空间隔离的 `ext_*` 表：

- **Book（书）= Channel**；**Chapter（章）= Item**；**Volume（卷）= Item 上的 `volume` 标签**（靠聚合 UI 管理，不建表）。
- **Category（分类）= 新建 `ext_category` 表**；采用"单主分类 + 多标签"模型。
- **Audit Record（留痕）= 新建 `ext_content_audit` 表**，存储模型为**字段级 diff + 周期性检查点**（满足完整追溯且存储有界）。
- **Report（举报）= 新建 `ext_content_report` 表**。
- 高频查询字段 `review_status`（章审核态）、`genre`（书主分类）**落成 `items`/`channels` 真实列 + 索引**（加性 ALTER，升级安全）。
- 所有**公共展示走 `themes/feed-zh/*.mustache`**（零冲突）；所有**写库留痕 + 列镜像收口到单一接缝**：item PUT/POST 处理器（handler 层），逻辑在独立 `extContentAudit` 模块。
- 角色：v1 **单管理员**，预留 `ext_role` 扩展（非 v1）。

前端路线选 **A（纯主题）**，不做独立前端工程，避开公开 API 契约 SSOT。

## User Stories

1. As a 站点访客, I want 在首页看到精选书单与分类导航, so that 我能快速找到想看的小说。
2. As a 站点访客, I want 进入分类页按题材筛选书, so that 我能按兴趣浏览。
3. As a 站点访客, I want 打开书详情页看到封面/简介/作者/标签/连载状态, 以及按卷分组的章节列表, so that 我能纵览一本书的结构。
4. As a 站点访客, I want 在阅读页看到章节正文, 并能在上一章/下一章之间切换、打开目录抽屉、调整阅读设置, so that 我能连续顺畅地读。
5. As a 站点访客, I want 搜索时能搜到书名、作者以及章节正文, so that 我能直接定位到包含某内容的章节。
6. As a 管理员, I want 在后台管理分类（增删改、排序、展示开关）, so that 我能组织题材导航。
7. As a 管理员, I want 给一本书设置主分类与多个标签、连载状态、签约状态, so that 书能被正确归类与展示。
8. As a 管理员, I want 在章节编辑页填写卷名与章号, so that 章节能被归入正确的卷与顺序。
9. As a 管理员, I want 通过粘贴文本框或上传 txt 文件批量导入章节, so that 我能高效地把整本小说拆章入库。
10. As a 管理员, I want 在后台"卷聚合"视图里看到某书按卷分组的章节, 并能调整章归卷、卷内/卷间排序、给卷改名, so that 我能管理卷章结构而不建独立卷实体。
11. As a 作者, I want 保存章节时内容被记录（原始/修改/时间/谁/改了什么）, so that 任何修改都可追溯。
12. As a 审核员, I want 在审核队列看到所有"待审"章节与"待处理"举报, so that 我能集中处理。
13. As a 审核员, I want 点开某章的审计详情看到字段级 diff 高亮（增/删/改）, so that 我能直观看到改了什么。
14. As a 审核员, I want 通过或驳回某章（驳回需填理由）, so that 内容按状态机流转。
15. As a 审核员, I want 把某章恢复到任意历史版本（从检查点 + diff 重放）, so that 误改可回退。
16. As a 读者, I want 匿名举报某章（选类别+填详情）, so that 我能反馈违规内容。
17. As a 管理员, I want 对违规章节执行下架（并记一条 takedown 审计）, so that 问题内容能被处理。

## Implementation Decisions

- **实体映射**：Book→Channel、Chapter→Item、Volume→Item 的 `volume` 标签、Category→`ext_category`、Audit Record→`ext_content_audit`、Report→`ext_content_report`。
- **扩展口袋**：章/书的扩展字段（`volume`/`chapterNo`/`order`/`wordCount`/`reviewStatus`/`takedown`；`serialStatus`/`signStatus`/`genre`/`tags`）全部走 `_microfeed`，schema 为 `.loose()`，不改动 `ApiSchemas.ts` 顶层结构、不碰 `OpenApiDocument.ts`（SSOT 避开）。
- **查询列（修正 G2）**：`items.review_status`、`channels.genre` 落成真实列 + 索引（加性 `ALTER TABLE` 迁移）。原设计 `WHERE _microfeed.xxx` 是无效 SQL，已弃用。
- **内容持久化**：全部落 D1，`ext_*` 表同为 D1 表（满足"必须进 DB"）。
- **单一写入接缝**：所有写库留痕与列镜像在 handler 层的 item PUT/POST 处拦截，调用独立 `extContentAudit.record(...)`；核心仅此一处改动，rebase 冲突面最小。
- **留痕存储模型（ADR-0003）**：每次修改存 `diff_data`（字段级差异 JSON：标题/正文/卷章号/标签逐字段增删改）；每 K 次编辑的检查点行额外存 `checkpoint_data`（完整 `data` 快照）。恢复 = 定位目标版本之前最近检查点 → 向前重放 diff 序列重建目标版本 `data` → 回填 item。
- **审核状态机（ADR-0003 引用）**：
  `draft → submitted → approved / rejected`；配合 item `status`：`unpublished ↔ published`。通过=`approved`+`published`；驳回=`rejected`+`unpublished`+`reason`；恢复=检查点+diff 重放。
- **角色（ADR-0002）**：v1 单管理员（所有作者/编辑共用同一后台登录或全局 API Key），不做按书隔离；扩展路径为 `ext_role` + handler 层守卫（非 v1）。
- **分类模型（Q6）**：单主分类（`_microfeed.genre` 绑 `ext_category.id`，镜像 `channels.genre` 列）+ 多标签（`_microfeed.tags: string[]`）。
- **批量导入（Q5）**：同时支持粘贴文本框（零依赖）与文件上传（存 R2 后解析，需启用 R2），逐条调 API 建 item。
- **升级四条铁律**：`ext_*` 命名空间 + 高序号加性迁移（从 `0023` 起）；不碰 SSOT；快照/差异存 `data` 相关；展示全走主题模板。
- **不做（Out of Scope）**：机审内容安全筛查、多级角色中间件、阅读计数/排行榜、独立卷详情页——均不建。

## Testing Decisions

- **好测试的定义**：只测外部行为（章节在审核队列出现、审计详情渲染出 diff、恢复后内容等于目标版本），不测实现细节（`extContentAudit` 内部如何算 diff 属实现，可单测但其内部结构不应被 UI 测试断言）。
- **被测模块**：
  - `extContentAudit` 的 diff 计算与检查点触发逻辑（纯函数，单测：给定前后两份 `data`，断言 `diff_data` 正确；断言每 K 次出现检查点）。
  - 恢复重建逻辑（单测：给定检查点 + diff 序列，断言重建出的 `data` 等于历史版本）。
  - 审核队列查询（集成测：写入 `submitted` 章 → `SELECT WHERE review_status='submitted'` 命中）。
  - 主题渲染（手动/可视：灌入模拟数据后看书卡、卷分组、阅读页、审计 diff 高亮）。
- **既有先验（prior art）**：microfeed 现有 `tsc --noEmit` 全量类型校验、公开 API 的 `safeParse` 校验、主题 mustache 渲染——沿用，不做新测试框架。

## Out of Scope

- 机审 / 敏感词内容安全筛查（§7.5，与"修改留痕"是两件事，本次不做）。
- 多级角色（author/reviewer）与按书隔离（v1 单管理员，属 v1 之后扩展）。
- 阅读计数 / 排行榜（`ext_view_count`，不做）。
- 独立卷详情页（`ext_volume`，不做）。
- 重写核心 Worker / 渲染管线；改动公开 API 契约 SSOT。
- 独立前端工程（Vue SPA + JSON Feed API）——前端走纯主题路线 A。

## Further Notes

- 验证入口：先灌入 `docs/novel-cms-design.md` §12 的模拟数据（一本书《星河剑歌》+ 2 卷 3 章 + 1 条留痕 + 1 条举报），即可在主题改造（Phase 1）与审核页（Phase 3）看到效果。
- 升级演练：fork 上 `git fetch` 上游 + `rebase`，确认冲突仅集中在 `EditItemApp` 与 item 模型两处。
- 决策记录（ADR）：0001 内容持久化=D1 / 0002 作者隔离=v1 单管理员 / 0003 留痕=diff+检查点 / 0004 查询列=真实列+索引。
