# CONTEXT — 小说站 CMS 领域模型（microfeed 改造）

> 本文件是术语表（ubiquitous language），只记录"概念与叫法"，不含实现细节。
> 随讨论推进就地更新。隔离在 `docs/novel-cms/`，避免污染 microfeed 上游根目录（升级安全）。

## 核心映射（microfeed 原生概念 → 小说领域概念）

| 小说领域 | microfeed 实体 | 存储落点 | 说明 |
|---|---|---|---|
| **Book（书）** | Channel | `channels.data` JSON | `title`/`description`/`icon`/`authors`/`language` + `_microfeed` |
| **Chapter（章）** | Item | `items.data` JSON | `title`/`content_html`/`date_published`/`status` + `_microfeed` |
| **Volume（卷）** | Item 上的标签 | `_microfeed.volume`（字符串） | 无独立实体，靠聚合 UI 管理 |
| **Shelf / 书主页** | Channel 列表 | 首页 feed | 主题模板渲染 |
| **Reading Page（阅读页）** | Item 页 | `web-item.mustache` | 主题模板渲染 |
| **Category（分类/题材）** | 新建表 | `ext_category` | 命名空间隔离 |
| **Audit Record（留痕）** | 新建表 | `ext_content_audit` | 存修改前后 `data` JSON 快照 |
| **Report（举报）** | 新建表 | `ext_content_report` | 读者举报落库 |
| **Tag / 标签** | **同 Category** | `ext_category` | 只是 Category 的**对外叫法**（如 内经类 / 本草 / 伤寒 / 东方玄幻），**不是独立实体**，勿新建 tags 表 |

## 扩展口袋

- **`_microfeed`**：`apiItemInputSchema` / `apiChannelInputSchema` 均为 `.loose()` 且带 `_microfeed: z.record(z.string(), z.unknown())`。可放任意扩展字段，**不校验、不报错、不动 ApiSchemas**。

## 关键约束（已核实，2026-09-16）

1. **持久化 = D1 数据库，不是文件。**
   - `items.data` / `channels.data` 都是 `TEXT`（JSON 序列化）。
   - `FeedDb._putItemToContentStatement` / `_putChannelToContentStatement` 把整篇 `JSON.stringify(data)` 写入。
   - microfeed = Cloudflare Worker + D1（Serverless，无持久文件系统），内容客观上只能落 D1。
   - 扩展表 `ext_*` 也全是 D1 表。→ **满足"内容必须进 DB"的硬性要求。**

2. **`_microfeed` 字段存在于 `data` JSON 内部，不是独立列。**
   - 查询时不能直接 `WHERE _microfeed.reviewStatus='submitted'`（无效 SQL）。
   - 需用 `json_extract(data, '$._microfeed.reviewStatus')`，或把高频查询字段（如 `review_status`、`genre`）落成独立列 + 索引。
   - 设计文档 §7.4 的"查询 items WHERE _microfeed.reviewStatus=..." 写法需修正（见 ADR/改进项）。

3. **API Key 是全局的，不能绑定到某一本书。**
   - `ApiKeyRecord.scopes` 仅 `["content:read","content:write"]`，无 channel 字段。
   - 拿 `content:write` 即可写任意 book/chapter。
   - → 决策点 3「每作者一把 key 限自己书」**当前代码下不可行**，需重新决策（见首轮 grilling Q1）。

4. **章节正文在 DB 里存 `items.data.description`（HTML 原样）。**
   - `content_html` 只是**对外渲染时的别名**：`item-handlers.ts` 做 `content_html: String(item.description ?? "")`。
   - 主题 `web-item.mustache` 优先读 `content_html`，回退 `content_text`。
   - → API 返回正文时取 `data.description` **原样**，不做 markdown 转换、不重新渲染。

5. **账户模型是单管理员。**
   - `auth_account` 为单条管理员登录（密码/Cloudflare Access）。
   - 无原生"多作者 / 多角色"概念。
   - → "作者隔离"不是 microfeed 免费给的，要么接受单管理员，要么自建角色层。
