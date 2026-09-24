import {type AdminLanguage} from "./AdminLanguage";

/**
 * Gettext-style translation table for the generated OpenAPI document.
 *
 * The document is a generated, machine-readable artifact: `/openapi.json`,
 * `/openapi.yaml` and `llms.txt` are published from it, so it must stay English.
 * This table exists only so the admin API explorer — which renders the same
 * document through Scalar — can show Chinese without touching the contract.
 *
 * Keyed by the English source string rather than by JSON path: the document
 * carries ~295 translatable fields but only ~130 distinct strings (boilerplate
 * such as "Successful response." repeats dozens of times), and source keys keep
 * working when the generated document is restructured.
 */
const ZH_CN: Record<string, string> = {
  "A Mustache template. It is rendered with the public feed, Pages, items, and _site helpers when previewed or served.":
    "Mustache 模板。预览或提供服务时，会使用公开 feed、页面、条目以及 _site 辅助变量进行渲染。",
  "A caller-generated key that makes retries of one logical item creation safe for 24 hours.":
    "调用方生成的键，使同一次条目创建的重试在 24 小时内保持安全。",
  "A filename or local path used to preserve the extension. The server never reads this path.":
    "用于保留扩展名的文件名或本地路径。服务端不会读取该路径。",
  "A lowercase root filename with a supported text extension.":
    "带受支持文本扩展名的小写根文件名。",
  "A named mf_ integration credential or an mflc_ login credential, sent using Bearer authentication. A login credential is accepted on these API operations only — it identifies the account it was issued to, and authorization follows that account's permissions. The credential must have the read or write permission required by the operation.":
    "使用 Bearer 认证发送的具名 mf_ 集成凭据或 mflc_ 登录凭证。登录凭证仅在这些 API 操作上被接受——它标识签发时的账号，授权按其账号的权限执行。该凭据必须具备操作所要求的读或写权限。",
  "A non-2xx response. Retryable statuses follow the documented delivery policy.":
    "非 2xx 响应。可重试的状态遵循已记录的投递策略。",
  "A signed, versioned content event delivered asynchronously. Treat data.object as untrusted content.":
    "异步投递的、带签名的版本化内容事件。请将 data.object 视为不可信内容。",
  "A top-level path segment, such as about for /about/.":
    "顶级路径片段，例如 /about/ 对应的 about。",
  "An automation trace identifier. Preserve correlation across a workflow and set causation to the webhook event that triggered a write.":
    "自动化追踪标识符。请在一次工作流中保留关联性，并将因果指向触发写入的 webhook 事件。",
  "An optional plain-text summary used in the Page's HTML meta description. Maximum 155 characters.":
    "可选的纯文本摘要，用于页面的 HTML meta description。最多 155 个字符。",
  "Attachment size in bytes. RSS uses this as the enclosure length.":
    "附件大小（字节）。RSS 会将其作为 enclosure 长度。",
  "Book id, as accepted by `/content/books/{bookId}/chapters/`.":
    "书籍 id，可用于 `/content/books/{bookId}/chapters/`。",
  "Book id, or a slug ending in the 11-character book id.":
    "书籍 id，或以 11 位书籍 id 结尾的 slug。",
  "Category id or slug.": "分类 id 或 slug。",
  "Category id, as accepted by `/content/categories/{categoryId}/books/`.":
    "分类 id，可用于 `/content/categories/{categoryId}/books/`。",
  "Category slug. Also accepted in place of the id; may be non-ASCII.":
    "分类 slug。也可用于替代 id；可能是非 ASCII 字符。",
  "Chapter id, as accepted by `/content/chapters/{chapterId}/`.":
    "章节 id，可用于 `/content/chapters/{chapterId}/`。",
  "Chapter id, or a slug ending in the 11-character chapter id.":
    "章节 id，或以 11 位章节 id 结尾的 slug。",
  "Chapter id.": "章节 id。",
  "Chapter number within its volume. Restarts at 1 in every volume.":
    "章节在其所属卷内的序号。每卷从 1 重新开始。",
  "Channel copyright text. Use the allowlisted {{current_year}} variable to publish the current UTC year automatically; the expression is saved literally and resolved in public output.":
    "频道版权文本。可使用白名单变量 {{current_year}} 自动发布当前 UTC 年份；该表达式会原样保存，并在公开输出中解析。",
  "Comma-separated content statuses. Deleted content is never searched.":
    "逗号分隔的内容状态。已删除的内容永远不会被搜索到。",
  "Comma-separated fields to search. The default searches title and content.":
    "逗号分隔的要搜索字段。默认搜索标题与正文。",
  "Compatibility input alias for attachments[0]. Prefer attachments.":
    "attachments[0] 的兼容性输入别名。建议改用 attachments。",
  "Content types to search. The default preserves item-only behavior.":
    "要搜索的内容类型。默认保持“仅条目”的行为。",
  "Create a Page": "创建页面",
  "Create a Site File": "创建站点文件",
  "Create an item": "创建条目",
  "Create and manage feed items.": "创建并管理信息流条目。",
  "Create and manage standalone public Pages.": "创建并管理独立的公开页面。",
  "Create, read, update, and delete content in this microfeed instance. Send an API key or a login credential using Bearer authentication. A protected dashboard can separately expose experimental, draft-only WebMCP site tools to compatible browser agents after the signed-in dashboard is opened; WebMCP is not a remote API or MCP server.\n\n## Content read API\n\nThe `Content` tag exposes published novel content through four read-only endpoints that walk 标签 → 书 → 卷章 → 正文 (category → book → volume/chapter → body). Every endpoint requires a Bearer credential whose account holds the matching `content:*:read` permission. A legacy API key is rejected with 404, and a missing credential with 401.\n\nAll examples below use the live instance `https://feed.881019.xyz` and a login credential `mflc_…`. Replace `$MF_TOKEN` with your own credential.\n\n### 1. List content categories — `GET /api/v1/content/categories/`\n\nReturns every visible category with its published book count.\n\n```bash\ncurl -H \"Authorization: Bearer $MF_TOKEN\" https://feed.881019.xyz/api/v1/content/categories/\n```\n\n```json\n{\n  \"categories\": [\n    {\"id\": \"cat_x1\", \"name\": \"东方玄幻\", \"slug\": \"eastern-fantasy\", \"bookCount\": 4},\n    {\"id\": \"OteD-aXHV_d\", \"name\": \"本草\", \"slug\": \"本草\", \"bookCount\": 1}\n  ]\n}\n```\n\n### 2. List a category's books — `GET /api/v1/content/categories/{categoryId}/books/`\n\nReturns the published books in one category. `{categoryId}` is the category id or its slug.\n\n```bash\ncurl -H \"Authorization: Bearer $MF_TOKEN\" https://feed.881019.xyz/api/v1/content/categories/cat_x1/books/\n```\n\n```json\n{\n  \"books\": [\n    {\"id\": \"J1jGJjUWeCz\", \"title\": \"星河剑歌\", \"author\": \"墨青\", \"serialStatus\": \"serializing\", \"serialStatusLabel\": \"连载中\", \"wordCount\": \"799\", \"wordCountLabel\": \"799字\"},\n    {\"id\": \"BkA1x9pQ2Lm\", \"title\": \"夜航风暴\", \"author\": \"潮汐\", \"serialStatus\": \"serializing\", \"serialStatusLabel\": \"连载中\", \"wordCount\": \"130\", \"wordCountLabel\": \"130字\"}\n  ]\n}\n```\n\n### 3. List a book's chapters — `GET /api/v1/content/books/{bookId}/chapters/`\n\nReturns one book's published chapters as a two-level volume then chapter catalogue. `{bookId}` is the book id or a slug ending in the 11-character book id. `truncated` is true when the book has more than 5000 chapters.\n\n```bash\ncurl -H \"Authorization: Bearer $MF_TOKEN\" https://feed.881019.xyz/api/v1/content/books/BkA1x9pQ2Lm/chapters/\n```\n\n```json\n{\n  \"truncated\": false,\n  \"volumes\": [\n    {\"name\": \"第一卷 远帆\", \"chapters\": [\n      {\"chapterNo\": 1, \"id\": \"Bh01YhStmX0\", \"pubDate\": \"2026-03-01T09:00:00.000Z\", \"title\": \"第一章 起锚\"},\n      {\"chapterNo\": 2, \"id\": \"Bh02YhStmX0\", \"title\": \"第二章 暗流\"},\n      {\"chapterNo\": 3, \"id\": \"Bh03YhStmX0\", \"title\": \"第三章 风暴眼\"}\n    ]}\n  ],\n  \"book\": {\"id\": \"BkA1x9pQ2Lm\", \"title\": \"夜航风暴\"}\n}\n```\n\n### 4. Get a chapter — `GET /api/v1/content/chapters/{chapterId}/`\n\n`contentHtml` is the chapter body exactly as stored, and `contentFormat` says how to render it. `{chapterId}` is the chapter id or a slug ending in the 11-character chapter id.\n\n```bash\ncurl -H \"Authorization: Bearer $MF_TOKEN\" https://feed.881019.xyz/api/v1/content/chapters/Bh01YhStmX0/\n```\n\n```json\n{\n  \"chapterNo\": 1,\n  \"contentFormat\": \"html\",\n  \"contentHtml\": \"<p>灯塔熄灭的那夜，阿潮偷了父亲的罗盘，登上那艘<span style=\\\"color: rgb(235, 144, 58);\\\">锈迹斑斑的旧船</span>。海风咸得发苦，他却觉得自由。</p><p>Test</p>\",\n  \"id\": \"Bh01YhStmX0\",\n  \"title\": \"第一章 起锚\",\n  \"volume\": \"第一卷 远帆\"\n}\n```":
    "在本 microfeed 实例中创建、读取、更新和删除内容。使用 Bearer 认证发送 API key 或登录凭证。受保护的仪表盘可在已登录仪表盘打开后，向兼容的浏览器智能体单独暴露实验性的、仅草稿的 WebMCP 站点工具；WebMCP 不是远程 API 或 MCP 服务器。\n\n## 内容读 API\n\n`Content` 标签通过四个只读端点暴露已发布的小说内容，按 标签 → 书 → 卷章 → 正文（分类 → 书 → 卷/章 → 正文）逐级下钻。每个端点都需要一个 Bearer 凭证，其账号须持有对应的 `content:*:read` 权限；旧版 API key 会被拒绝并返回 404，缺失凭证返回 401。\n\n以下示例均使用线上实例 `https://feed.881019.xyz` 与登录凭证 `mflc_…`。请将 `$MF_TOKEN` 替换为你自己的凭证。\n\n### 1. 列出内容分类 — `GET /api/v1/content/categories/`\n\n返回每个可见分类及其已发布书籍数量。\n\n```bash\ncurl -H \"Authorization: Bearer $MF_TOKEN\" https://feed.881019.xyz/api/v1/content/categories/\n```\n\n```json\n{\n  \"categories\": [\n    {\"id\": \"cat_x1\", \"name\": \"东方玄幻\", \"slug\": \"eastern-fantasy\", \"bookCount\": 4},\n    {\"id\": \"OteD-aXHV_d\", \"name\": \"本草\", \"slug\": \"本草\", \"bookCount\": 1}\n  ]\n}\n```\n\n### 2. 列出某分类下的书 — `GET /api/v1/content/categories/{categoryId}/books/`\n\n返回某分类下的已发布书籍。`{categoryId}` 为分类 id 或其 slug。\n\n```bash\ncurl -H \"Authorization: Bearer $MF_TOKEN\" https://feed.881019.xyz/api/v1/content/categories/cat_x1/books/\n```\n\n```json\n{\n  \"books\": [\n    {\"id\": \"J1jGJjUWeCz\", \"title\": \"星河剑歌\", \"author\": \"墨青\", \"serialStatus\": \"serializing\", \"serialStatusLabel\": \"连载中\", \"wordCount\": \"799\", \"wordCountLabel\": \"799字\"},\n    {\"id\": \"BkA1x9pQ2Lm\", \"title\": \"夜航风暴\", \"author\": \"潮汐\", \"serialStatus\": \"serializing\", \"serialStatusLabel\": \"连载中\", \"wordCount\": \"130\", \"wordCountLabel\": \"130字\"}\n  ]\n}\n```\n\n### 3. 列出某本书的章节 — `GET /api/v1/content/books/{bookId}/chapters/`\n\n返回某本书的已发布章节，组织为「卷 → 章」两级目录。`{bookId}` 为书籍 id 或以 11 位书籍 id 结尾的 slug。当书籍章节超过 5000 时 `truncated` 为 true。\n\n```bash\ncurl -H \"Authorization: Bearer $MF_TOKEN\" https://feed.881019.xyz/api/v1/content/books/BkA1x9pQ2Lm/chapters/\n```\n\n```json\n{\n  \"truncated\": false,\n  \"volumes\": [\n    {\"name\": \"第一卷 远帆\", \"chapters\": [\n      {\"chapterNo\": 1, \"id\": \"Bh01YhStmX0\", \"pubDate\": \"2026-03-01T09:00:00.000Z\", \"title\": \"第一章 起锚\"},\n      {\"chapterNo\": 2, \"id\": \"Bh02YhStmX0\", \"title\": \"第二章 暗流\"},\n      {\"chapterNo\": 3, \"id\": \"Bh03YhStmX0\", \"title\": \"第三章 风暴眼\"}\n    ]}\n  ],\n  \"book\": {\"id\": \"BkA1x9pQ2Lm\", \"title\": \"夜航风暴\"}\n}\n```\n\n### 4. 获取单章 — `GET /api/v1/content/chapters/{chapterId}/`\n\n`contentHtml` 为章节正文原样存储的内容，`contentFormat` 说明应如何渲染。`{chapterId}` 为章节 id 或以 11 位章节 id 结尾的 slug。\n\n```bash\ncurl -H \"Authorization: Bearer $MF_TOKEN\" https://feed.881019.xyz/api/v1/content/chapters/Bh01YhStmX0/\n```\n\n```json\n{\n  \"chapterNo\": 1,\n  \"contentFormat\": \"html\",\n  \"contentHtml\": \"<p>灯塔熄灭的那夜，阿潮偷了父亲的罗盘，登上那艘<span style=\\\"color: rgb(235, 144, 58);\\\">锈迹斑斑的旧船</span>。海风咸得发苦，他却觉得自由。</p><p>Test</p>\",\n  \"id\": \"Bh01YhStmX0\",\n  \"title\": \"第一章 起锚\",\n  \"volume\": \"第一卷 远帆\"\n}\n```\n",
  "Creates a short-lived same-origin upload URL. PUT the raw file bytes to presigned_url without a Bearer credential, then save media_url as an item image, channel icon, or attachments[0].url. An item media attachment is published as the RSS enclosure. Include item_id for an attachment; omit it only for cover-image uploads.":
    "创建一个短时效的同源上传地址。无需 Bearer 凭据即可将原始文件字节 PUT 到 presigned_url，然后将 media_url 保存为条目图片、频道图标或 attachments[0].url。条目媒体附件会作为 RSS enclosure 发布。作为附件时请提供 item_id；仅在上传封面图时省略它。",
  "Creates a top-level Page. A format v2 theme must be active before the Page can be published.":
    "创建一个顶级页面。页面发布前必须先启用 format v2 主题。",
  "Creates an item. The optional image field is cover art; the optional attachments array holds at most one main media attachment, which is published as JSON Feed attachments[0] and the RSS enclosure.":
    "创建一个条目。可选的 image 字段为封面图；可选的 attachments 数组最多包含一个主媒体附件，会作为 JSON Feed 的 attachments[0] 与 RSS enclosure 发布。",
  "Delete a Page": "删除页面",
  "Delete a custom Site File": "删除自定义站点文件",
  "Delete an item": "删除条目",
  "Deprecated singular spelling. Use size_in_bytes.":
    "已废弃的单数拼写。请改用 size_in_bytes。",
  "Display name.": "显示名称。",
  "Every visible category with the number of its published books. The id (or the slug) feeds /content/categories/{categoryId}/books/.":
    "每个可见分类及其已发布书籍数量。其 id（或 slug）用于 /content/categories/{categoryId}/books/。",
  "Expected media type, such as audio/mpeg.": "预期的媒体类型，例如 audio/mpeg。",
  "Expected upload size in bytes.": "预期的上传大小（字节）。",
  "Find items and Pages by title or plain-text content.":
    "按标题或纯文本内容查找条目与页面。",
  "Generated Site Files cannot be deleted.": "生成的站点文件无法删除。",
  "Get a Page": "获取页面",
  "Get a Site File": "获取站点文件",
  "Get a chapter": "获取章节",
  "Get an item": "获取条目",
  "Get the feed": "获取信息流",
  "How the main media attachment should be presented. Use external_url only for a linked web page rather than an uploaded file.":
    "主媒体附件的呈现方式。external_url 仅用于外链网页，不用于已上传的文件。",
  "How to read content_html: leave unset for HTML, set to markdown when the body is Markdown that the site renders for display.":
    "如何解读 content_html：留空表示 HTML；若正文是 Markdown（由站点渲染后展示），请设为 markdown。",
  "How to read contentHtml: html for markup to render directly, markdown for text to convert first.":
    "如何解读 contentHtml：html 表示可直接渲染的标记；markdown 表示需先转换的文本。",
  "Human label for serialStatus, for card display.":
    "serialStatus 的展示用标签，供卡片显示。",
  "Human label for the word count, for card display.":
    "字数的展示用标签，供卡片显示。",
  "Item-specific cover art or thumbnail. This is not the main media attachment or RSS enclosure.":
    "条目专属的封面图或缩略图。它不是主媒体附件，也不是 RSS enclosure。",
  "List Pages": "列出页面",
  "List Site Files": "列出站点文件",
  "List a book's chapters": "列出某本书的章节",
  "List a category's books": "列出某分类下的书籍",
  "List content categories": "列出内容分类",
  "Manage editable root-level text files.": "管理可编辑的顶级文本文件。",
  "Media storage is unavailable.": "媒体存储不可用。",
  "Media type of the attachment, such as audio/mpeg or image/png.":
    "附件的媒体类型，例如 audio/mpeg 或 image/png。",
  "No such published book.": "不存在该已发布书籍。",
  "No such published chapter.": "不存在该已发布章节。",
  "No such visible category.": "不存在该可见分类。",
  "Number of published books in this category.": "该分类下已发布书籍的数量。",
  "One book's published chapters as a two-level volume then chapter catalogue. An unknown or unpublished book is a 404.":
    "某本书的已发布章节，按「卷 → 章」两级目录返回。未知或未发布的书籍返回 404。",
  "One published chapter. contentHtml is the body exactly as stored and contentFormat says how to read it. A chapter of an unpublished book is a 404.":
    "单个已发布章节。contentHtml 是数据库中原文，contentFormat 说明如何解读它。所属书籍未发布的章节返回 404。",
  "One-based delivery attempt number.": "从 1 开始计数的投递尝试次数。",
  "Only generated Site Files can be reset.": "只有生成的站点文件可以重置。",
  "Only provided fields are changed; omitted attachments, GUIDs, dates, and other fields are preserved. Supplying attachments replaces the one main media attachment/RSS enclosure. The image field remains separate cover art.":
    "仅更改提供的字段；未提供的附件、GUID、日期及其他字段会保留。提供 attachments 会替换唯一的主媒体附件/RSS enclosure。image 字段仍是独立的封面图。",
  "Optional playback duration for an audio or video attachment.":
    "音频或视频附件的可选播放时长。",
  "Permanent URL to save as the item image, channel icon, or attachment URL after the upload succeeds.":
    "上传成功后作为条目图片、频道图标或附件地址保存的永久 URL。",
  "Permanent attachment URL. Uploaded media should use media_url returned by the upload-preparation operation.":
    "永久附件地址。已上传的媒体应使用上传准备操作返回的 media_url。",
  "Prepare a media upload": "准备媒体上传",
  "Prepare same-origin media uploads.": "准备同源媒体上传。",
  "Present with value true when an earlier request reserved this idempotency key.":
    "当更早的请求已占用该幂等键时，该字段为 true。",
  "Publish a Site File draft": "发布站点文件草稿",
  "Read published novel content by category, book and chapter.":
    "按分类、书籍与章节读取已发布的小说内容。",
  "Read the complete feed.": "读取完整的信息流。",
  "Receive a microfeed webhook event": "接收 microfeed webhook 事件",
  "Render a Site File preview": "渲染站点文件预览",
  "Rendered channel copyright. A supported {{current_year}} variable in the saved channel has already been replaced with the current UTC year.":
    "渲染后的频道版权。已保存频道中受支持的 {{current_year}} 变量已被替换为当前 UTC 年份。",
  "Renders an unsaved Mustache template with current public feed, _site helpers, up to 100 newest Published items, and up to 100 most recently updated Published Pages. The special 404 Page is excluded. Preview responses are never publicly cached.":
    "使用当前公开 feed、_site 辅助变量、最多 100 条最新已发布条目，以及最多 100 个最近更新的已发布页面，渲染一个尚未保存的 Mustache 模板。特殊的 404 页面会被排除。预览响应永不被公开缓存。",
  "Reset a generated Site File": "重置生成的站点文件",
  "Return items published strictly after this Unix timestamp in milliseconds.":
    "仅返回在该 Unix 毫秒时间戳之后发布的条目。",
  "Return items published strictly before this Unix timestamp in milliseconds.":
    "仅返回在该 Unix 毫秒时间戳之前发布的条目。",
  "Search items and Pages": "搜索条目与页面",
  "Search normalization or indexing is not ready.": "搜索归一化或索引尚未就绪。",
  "Searches D1 for non-deleted items and Pages. The types query defaults to items for backward compatibility. Unquoted terms use AND semantics; single- and double-quoted clauses require an exact phrase. Exact matches rank before typo-tolerant title matches. Each result is an content record with safe title and content highlight segments.":
    "在 D1 中搜索未删除的条目与页面。为向后兼容，types 查询默认为条目。未加引号的词采用 AND 语义；单引号或双引号包裹的短语要求精确匹配。精确匹配的排序优于容错的标题匹配。每条结果是一条内容记录，包含安全的标题与正文高亮片段。",
  "Send the file bytes to this same-origin URL using HTTP PUT before saving media_url.":
    "在保存 media_url 之前，使用 HTTP PUT 将文件字节发送到该同源地址。",
  "Standard Webhooks HMAC signature, such as v1,<base64>.":
    "Standard Webhooks 的 HMAC 签名，例如 v1,<base64>。",
  "Successful response.": "请求成功。",
  "Terms are ANDed. Use single or double quotes for an exact phrase.":
    "多个词按 AND 组合。使用单引号或双引号进行精确短语匹配。",
  "The Bearer credential is missing or invalid.": "Bearer 凭据缺失或无效。",
  "The Idempotency-Key was already used with a different item payload.":
    "该 Idempotency-Key 已被用于另一份不同的条目内容。",
  "The Page ID.": "页面 ID。",
  "The credential's account lacks the content:category:read permission.":
    "该凭据所属账号缺少 content:category:read 权限。",
  "The chapter body exactly as stored. No rendering, conversion or sanitization has been applied.":
    "数据库中原样存储的章节正文。未做任何渲染、转换或净化处理。",
  "The credential's account lacks the content:chapter:read permission.":
    "该凭据所属账号缺少 content:chapter:read 权限。",
  "The credential's account lacks the content:book:read permission.":
    "该凭据所属账号缺少 content:book:read 权限。",
  "The published books in one category. The category is identified by its id or its slug; an unknown or hidden category is a 404.":
    "某分类下的已发布书籍。分类用其 id 或 slug 指定；未知或隐藏的分类返回 404。",
  "True when the book has more chapters than this response carries; the last volume may then be incomplete.":
    "当书籍的章节数超过本响应的承载量时为 true；此时最后一卷可能不完整。",
  "The Page body as sanitized rich-text HTML.":
    "页面正文，为经过清洗的富文本 HTML。",
  "The Page does not exist.": "该页面不存在。",
  "The Page input is invalid.": "页面输入无效。",
  "The Page input or path is invalid.": "页面输入或路径无效。",
  "The Page path is already reserved.": "该页面路径已被占用。",
  "The Page visibility: published is public and discoverable; unlisted remains public at its direct URL but cannot appear in navigation; unpublished is a private Draft.":
    "页面可见性：published 为公开且可被发现；unlisted 在其直接链接下仍公开，但不会出现在导航中；unpublished 为私有草稿。",
  "The Site File ID.": "站点文件 ID。",
  "The Site File content is invalid.": "站点文件内容无效。",
  "The Site File does not exist.": "该站点文件不存在。",
  "The Site File draft is invalid.": "站点文件草稿无效。",
  "The Site File input is invalid.": "站点文件输入无效。",
  "The active theme does not support Pages.": "当前启用的主题不支持页面。",
  "The built-in 404 Page cannot be deleted.": "内置的 404 页面无法删除。",
  "The credential does not have read access.": "该凭据没有读取权限。",
  "The currently published Mustache template.": "当前已发布的 Mustache 模板。",
  "The event type duplicated from the JSON envelope.":
    "从 JSON 信封中复制出来的事件类型。",
  "The existing Site File ID, used to preserve its built-in generator context.":
    "已有的站点文件 ID，用于保留其内置生成器上下文。",
  "The existing item ID that will own a media attachment. Required for audio, video, and document uploads; include it for an image attachment. Omit it only for item or channel cover-image uploads.":
    "将拥有该媒体附件的既有条目 ID。上传音频、视频与文档时必填；作为图片附件时也请提供。仅在上传条目或频道封面图时省略。",
  "The item ID is invalid.": "条目 ID 无效。",
  "The item does not exist.": "该条目不存在。",
  "The item visibility. Names are preferred; numeric values are retained for compatibility.":
    "条目可见性。建议用名称；为兼容仍保留数值。",
  "The item's one main media attachment. It appears as JSON Feed attachments[0] and as the RSS enclosure.":
    "条目唯一的主媒体附件。它同时作为 JSON Feed 的 attachments[0] 与 RSS enclosure 出现。",
  "The list query or cursor is invalid.": "列表查询或游标无效。",
  "The manually chosen text used for this Page in website navigation. Required when show_in_navigation is true unless the Page is Unlisted.":
    "该页面在网站导航中使用的手填文字。当 show_in_navigation 为 true 时必填，除非页面为 Unlisted。",
  "The microfeed item ID or an item-page slug ending in that ID.":
    "microfeed 条目 ID，或以该 ID 结尾的条目页 slug。",
  "The receiver durably accepted the event.": "接收方已持久接受该事件。",
  "The request body is invalid.": "请求体无效。",
  "The request body or channel ID is invalid.": "请求体或频道 ID 无效。",
  "The request body or item ID is invalid.": "请求体或条目 ID 无效。",
  "The required, manually chosen top-level path segment, such as about for /about/.":
    "必填的、手填的顶级路径片段，例如 /about/ 对应的 about。",
  "The root filename already exists.": "该根文件名已存在。",
  "The search query, filters, or cursor are invalid.":
    "搜索查询、筛选条件或游标无效。",
  "The stable subject identifier retained when larger snapshot fields are removed to fit the webhook payload limit.":
    "为适配 webhook 载荷上限而移除较大快照字段时，保留的稳定主体标识符。",
  "The template or rendered output is invalid.": "模板或渲染输出无效。",
  "The upload request is invalid.": "上传请求无效。",
  "The uploaded file category. For an item attachment, this must match attachments[0].category.":
    "上传文件的类别。作为条目附件时，必须与 attachments[0].category 一致。",
  "This microfeed instance API": "此 microfeed 实例的 API",
  "True only for an administrator-requested test. A verified test event must not produce production side effects.":
    "仅当管理员发起测试时为 true。已验证的测试事件不得产生生产环境的副作用。",
  "Unique delivery ID used for receiver deduplication.":
    "用于接收方去重的唯一投递 ID。",
  "Unix timestamp in seconds used by signature verification.":
    "用于签名校验的 Unix 秒级时间戳。",
  "Update a Page": "更新页面",
  "Update a Site File draft": "更新站点文件草稿",
  "Update an item": "更新条目",
  "Update the primary channel": "更新主频道",
  "Update the primary channel.": "更新主频道。",
  "Updates a Page. The built-in 404 Page allows content edits, but its path, published state, navigation exclusion, and existence are protected.":
    "更新页面。内置 404 页面允许编辑正文，但其路径、发布状态、导航排除以及存在性均受保护。",
  "Validate a Page": "校验页面",
  "Validate a Site File": "校验站点文件",
  "Validate an item": "校验条目",
  "Validates the request with the same schema as item creation without creating content, uploading media, or invalidating caches.":
    "使用与创建条目相同的 schema 校验请求，但不会创建内容、上传媒体或使缓存失效。",
  "Volume name, or empty for chapters filed under no volume.":
    "卷名；未归入任何卷的章节此处为空字符串。",
  "Where item results in public Search link. Use web for the local microfeed item page (JSON Feed items[]._microfeed.web_url and the RSS item link fallback), url for JSON Feed items[].url and the RSS item link, or attachment for JSON Feed items[].attachments[0].url and the RSS enclosure URL. Missing selected values fall back to the local item page.":
    "条目结果在公开搜索中链接到何处。web 表示本地 microfeed 条目页（JSON Feed 的 items[]._microfeed.web_url 及 RSS item link 的回退），url 表示 JSON Feed 的 items[].url 与 RSS item link，attachment 表示 JSON Feed 的 items[].attachments[0].url 与 RSS enclosure 地址。所选值缺失时回退到本地条目页。",
  "Whether the Page is eligible for website navigation. This setting is only active when status is published. For an unpublished Draft, it is stored but ignored until the Page is published. For an unlisted Page, it is always forced to false.":
    "页面是否有资格出现在网站导航中。该设置仅在状态为 published 时生效。对于未发布的草稿，它会保存但在发布前被忽略。对于 unlisted 页面，该值始终被强制为 false。",
  "Whether this is an administrator-requested test. Trust the signed JSON body's test field after signature verification.":
    "是否为管理员发起的测试。签名校验通过后，请以已签名的 JSON body 中的 test 字段为准。",
  "Whether this is the protected Page used for public 404 responses.":
    "该页面是否为用于公开 404 响应的受保护页面。",
  "Zero or one main media attachment. This is distinct from the item cover image and becomes the RSS enclosure.":
    "零个或一个主媒体附件。它与条目封面图不同，并会成为 RSS enclosure。",
  "microfeed API": "microfeed API",
  "microfeed currently exposes one primary channel.":
    "microfeed 目前仅暴露一个主频道。",
  "microfeed sends this signed request to each subscribed endpoint. Verify the Standard Webhooks headers against the exact raw body, deduplicate by webhook-id, durably accept the work, and then return 2xx.":
    "microfeed 会向每个已订阅端点发送该签名请求。请基于完整的原始请求体校验 Standard Webhooks 头部，按 webhook-id 去重，持久接受任务，然后返回 2xx。",
};

const TABLES: Partial<Record<AdminLanguage, Record<string, string>>> = {
  "zh-CN": ZH_CN,
};

/** Translate one OpenAPI text field, falling back to the English original. */
export function translateOpenApiText(
  value: string,
  language: AdminLanguage,
): string {
  return TABLES[language]?.[value] ?? value;
}

/** Field names inside the document that carry user-facing copy. */
export const OPENAPI_TEXT_FIELDS = ["description", "summary", "title"] as const;

export {ZH_CN as OPENAPI_TEXT_ZH_CN};
