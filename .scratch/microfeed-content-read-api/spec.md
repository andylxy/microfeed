# Spec：受保护的内容读 API（标签 → 书 → 卷章 → 正文）

来源：`docs/novel-cms/adr/0006-content-read-api.md`（Accepted，9 项决策）

## Problem Statement

公开站有「按标签 → 书 → 卷章 → 正文」逐级浏览的**页面**，但没有对应的**内容 API**。
外部集成（脚本、小程序、其他端）无法按同样的层级拿到内容；而现有的
`/api/v1/items/{itemId}/` 又是通用 feed 端点 —— **含草稿**、且正文被 `bodyToHtml`
按 `contentFormat` **转换过**，不适合直接当小说正文接口用。

此外，章节与书的关联只存在于 `data._microfeed.bookId`（JSON 内部），
`items` 表没有任何真实列，按书取章节只能全表扫描 —— 这是**静默**的性能隐患，
章节量上来后才会爆。

## Solution

在 `/api/v1/` 下新增四个受保护的只读端点，走 login-credential 鉴权 + 自研 RBAC 码，
只返回已发布内容、正文原样返回；同时把 `bookId` 落成真实列并建索引。

## User Stories

1. 作为集成方，我想列出全部可见标签（含每个标签的书数），以便从标签开始浏览。
2. 作为集成方，我想按标签 id 取该标签下的书摘要，以便逐层下钻。
3. 作为集成方，我想按书 id 一次拿到「卷 → 章」两级目录，以便渲染目录树而不用自己分组。
4. 作为集成方，我想按章节 id 取到正文，且正文是**库里存的原始内容**，不被转换。
5. 作为集成方，我想知道正文到底是 HTML 还是 markdown，以便决定怎么渲染。
6. 作为内容运营，我希望草稿和已删除内容**绝不**出现在任何这些端点里。
7. 作为内容运营，我想把一本书下架后，它的章节也**立刻**从这些端点消失。
8. 作为安全负责人，我想这些端点只接受登录凭证，legacy API key 走不通。
9. 作为安全负责人，我想不同资源用不同权限码（分类/书/章节），以便按最小权限授予。
10. 作为集成方，我想在目录超长时被告知「被截断了」，而不是拿到一份沉默的不完整数据。
11. 作为开发者，我想响应字段是白名单挑过的，不带出 `parent_id` / `visible` / `web_url` 这类内部字段。
12. 作为开发者，我想文件路径参数与公开站一致（分类用 id、`getIdFromSlug` 解析 id），不用记两套约定。
13. 作为运维，我想章节规模增长后按书取章节不会退化成全表扫描。
14. 作为开发者，我想端点在 OpenAPI 文档里有登记，且中英文翻译表同步。
15. 作为调用方，我想找不到资源时拿到明确的 404，而不是 200 配空对象。

## Implementation Decisions

- **四个端点**（`GET` only）：`/api/v1/content/categories/`、
  `/api/v1/content/categories/{categoryId}/books/`、`/api/v1/content/books/{bookId}/chapters/`、
  `/api/v1/content/chapters/{chapterId}/`。
- **路径参数**：`{categoryId}` 用 `getCategoryBySlugOrId`（先 id 后 slug，与公开分类页同一套）；
  `{bookId}` / `{chapterId}` 用 `getIdFromSlug`。
- **响应白名单**（绝不整对象透传）：
  端点1 `{id,name,slug,bookCount}`；端点2 = 公开书卡形状；
  端点3 `{book:{id,title},truncated,volumes:[{name,chapters:[{id,title,chapterNo,pubDate?}]}]}`；
  端点4 `{id,title,chapterNo,volume,contentHtml,contentFormat}`。
- **鉴权**：login-credential（`Bearer mflc_…`）+ 自研码
  `content/categories`→`content:category:read`、`content/books`→`content:book:read`、
  `content/chapters`→`content:article:read`。
- **拒绝 legacy**：四条模式登记进 `integrationSuffix` 的 `!legacy && (...)` 守卫。
- **仅已发布**：`status = 1`；端点 2/3/4 用 `getBookById` 校验书已发布；端点 4 另校验所属书。
- **404 语义**：分类不可见 / 书未发布 / 章节非已发布 / 所属书未发布 → 404。
- **正文原样**：`contentHtml` = `items.data.description` 原始值；另给 `contentFormat` 标识格式。
- **目录上限**：端点 3 硬上限 5000 章，**截断在分组前**，`truncated` 标记末卷可能不完整。
- **`book_id` 真实列**（本次范围）：`ALTER TABLE items ADD COLUMN book_id TEXT` + 索引 +
  SQL 回填；查询**双读**（优先 `book_id`，缺失回退 JSON），`getBookChapters` 为首选改造点。
- **复用既有取数函数**，不另写：`listCategoryNav`、`getCategoryBySlugOrId`、`listChannelsByGenre`、
  `getBookById`、`getBookChapters`、`listVolumeBoard`（仅分组规则）、`FeedDb.getItemById`、`getIdFromSlug`。
- **不重命名权限码**（`content:article:read` 保留），遗留命名不一致记录在案。

## Testing Decisions

- **好的测试**：只断言外部可观察行为（HTTP 状态码 + 响应 JSON 形状），不断言内部函数调用。
- **要测**：① 四个端点的 200 与白名单形状；② 无凭证 401；③ legacy key 走不通；
  ④ 草稿/未发布不出现；⑤ 下架书的章节 404；⑥ 上下限与 `truncated`；⑦ 权限码不足 403。
- **先例**：`tests/worker/login-credential.test.ts`（铸凭证打端点）、
  `tests/worker/api-permissions.test.ts`（映射断言）、`tests/unit/openapi.test.ts`（文档一致性）。
- **门禁**：`yarn typecheck`（含 `astro check`）+ `yarn test` + `yarn i18n:check`。

## Out of Scope

- 写 API（创建/更新/删除章节）。
- 重命名 `content:article:*` 权限码。
- `volume` / `chapter_no` 落列。
- 分页（端点 3 一次给全，只有 5000 上限）。
- 公开站页面的改造。

## Further Notes

- 实施顺序很关键：**先登记路由与授权**（否则 404 / 或更糟：对任何已认证凭证开放），再建端点。
- `integrationSuffix` 漏登 = 404；`DOMAIN_RULES` 漏登 = **对任何已认证凭证开放**。
- 改 `OpenApiDocument.ts` 必须同步 `OpenApiTranslations.ts`，否则 `openapi.test.ts` 红三条。
