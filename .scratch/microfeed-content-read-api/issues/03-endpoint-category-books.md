# 03: 内容 API 端点 2 —— 分类下的书

**What to build:** `GET /api/v1/content/categories/{categoryId}/books/` 返回该分类下**已发布**的书卡列表。
`{categoryId}` 同时接受 id 与 slug（与公开分类页同一套解析）。不存在的分类、或 `visible = 0` 的分类 → **404**。

**Blocked by:** 02

**Status:** ready-for-agent

## 实现要点

- **端点**：`src/pages/api/v1/content/categories/[categoryId]/books/index.ts`，导出 `GET`。
- **登记**：
  - `integrationSuffix()` 的 `!legacy && (...)` 内加
    `/^content\/categories\/[^/]+\/books\/$/u.test(suffix)`。
  - `DOMAIN_RULES` 复用端点 1 已加的 `content/categories` 前缀（**无需新增规则**）。
- **取数（两步，别漏第二步）**：
  1. `getCategoryBySlugOrId(db, categoryId)`（`extCategory.ts:259`）—— 先按 id 再回退 slug；
     返回 null **或** `visible = 0` → 404。
  2. 取它的 **`.id`** 传给 `listChannelsByGenre(db, id)`（`extCategory.ts:376`）——
     `channels.genre` 存的是分类 **id**，不是 slug。返回公开书卡形状。
- **响应白名单**：沿用公开书卡形状（**即为对外契约**）：`id` / `title` / `image` / `link` /
  `author?` / `description?` / `serialStatus?` / `serialStatusLabel?` / `wordCount?`。
  该形状已是为公开页设计的，可直接用；但要在 OpenAPI 里写成契约。
- **OpenAPI**：登记该端点 + 同步翻译表。

## Acceptance criteria

- [ ] `yarn typecheck` + `yarn test` 通过
- [ ] `requiredApiPermission("/api/v1/content/categories/abc/books/", "GET")` === `"content:category:read"`
- [ ] worker 测试：用**分类 id** 请求 → 返回该分类的书
- [ ] worker 测试：用**分类 slug** 请求 → 返回**同一批**书（id/slug 双读等价）
- [ ] worker 测试：不存在的 categoryId → **404**
- [ ] worker 测试：`visible = 0` 的分类 → **404**
- [ ] worker 测试：只返回 `status = PUBLISHED` 的书（构造一个草稿书，断言不出现）
- [ ] `tests/unit/openapi.test.ts` 三条通过
