# 04: 内容 API 端点 3 —— 书的卷 → 章目录

**What to build:** `GET /api/v1/content/books/{bookId}/chapters/` 一次返回整本书的**卷 → 章两级目录**
（只含已发布章节）。书不存在或未发布 → **404**。超过 5000 章时截断并置 `truncated: true`。

**Blocked by:** 01（`book_id` 双读）、03（登记模式已建立）

**Status:** ready-for-agent

## 实现要点

- **端点**：`src/pages/api/v1/content/books/[bookId]/chapters/index.ts`，导出 `GET`。
- **登记**：
  - `integrationSuffix()` 的 `!legacy && (...)` 内加
    `/^content\/books\/[^/]+\/chapters\/$/u.test(suffix)`。
  - `DOMAIN_RULES` 加 `{prefix: "content/books", read: "content:book:read", write: "content:book:read"}`。
- **取数（组合，不另写分组逻辑）**：
  1. `getBookById(db, bookId)`（`extCategory.ts:449`）—— **已发布才返回**；null → 404。顺带拿 `book.title`。
  2. `getBookChapters(db, bookId, baseUrl)`（`extCategory.ts:509`）—— 已发布章节，已按
     `pub_date` → `chapterNo` 排好序。
  3. **截断**：把扁平列表截到**前 5000 条**（**分组前**截断 —— 语义可预测："阅读顺序前 5000 章"），
     记 `truncated = 总数 > 5000`。
  4. **分组**：套用 `listVolumeBoard`（`extVolume.ts:98`）的**分组规则** —— 桶按 `volume` 名；
     组序 `volumeOrder` ?? 首章 `chapterNo` → 首章 `pub_date` → id；未分卷桶（空名）**恒排最后**。
     ⚠️ **不要**直接调 `listVolumeBoard`（它查 `status != DELETED` **含草稿**，且在 JS 里过滤 `bookId`）。
- **响应白名单**：`{ book: { id, title }, truncated, volumes: [{ name, chapters: [{ id, title,
  chapterNo, pubDate? }] }] }`。章节项**只这四个字段**，别把 `getBookChapters` 的结果整条透传
  （它还带 `status` / `date_published` / `_microfeed`（含 `wordCount`/`web_url`）以及 `...data` 的全部字段）。
- **OpenAPI**：登记该端点 + 同步翻译表。

## Acceptance criteria

- [ ] `yarn typecheck` + `yarn test` 通过
- [ ] `requiredApiPermission("/api/v1/content/books/abc/chapters/", "GET")` === `"content:book:read"`
- [ ] worker 测试：返回的卷顺序符合规则（显式 `volumeOrder` 优先；无则按首章 `chapterNo`；
      再按首章 `pubDate`），**未分卷桶排最后**
- [ ] worker 测试：只含已发布章节（构造一个草稿章节，断言不出现）
- [ ] worker 测试：不存在的 bookId → **404**；未发布的 bookId → **404**
- [ ] worker 测试：章节项只含 `id` / `title` / `chapterNo` / `pubDate` 四个键
- [ ] worker 测试：**5000 章上限** —— 构造 5001 章时返回 5000 条且 `truncated === true`；
      不足 5000 时 `truncated === false`
- [ ] `tests/unit/openapi.test.ts` 三条通过
