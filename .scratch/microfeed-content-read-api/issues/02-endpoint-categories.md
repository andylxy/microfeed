# 02: 内容 API 端点 1 —— 分类列表

**What to build:** 持登录凭证的外部调用方可以 `GET /api/v1/content/categories/` 拿到**全部分类**
（每个带已发布书数）。这是四个端点里的第一个，它同时打通**整条新链路**：路径登记 →
凭证鉴权 → RBAC 码判定 → 白名单响应。完成后 `curl -H "Authorization: Bearer mflc_…"` 即可取到数据。

**Blocked by:** 01

**Status:** ready-for-agent

## 实现要点

- **端点**：`src/pages/api/v1/content/categories/index.ts`，导出 `GET`。
- **登记（缺一不可）**：
  - `integrationSuffix()`（`src/server/api/access.ts`）的 **`!legacy && (...)` 守卫内**加
    `suffix === "content/categories/"` —— 未登记则 404；放进守卫内即"拒绝 legacy"。
  - `DOMAIN_RULES`（`src/server/api/api-permissions.ts`）加 `{prefix: "content/categories",
    read: "content:category:read", write: "content:category:read"}` —— 未登记则**对任何已认证凭证开放**。
- **取数**：`listCategoryNav(db)`（`extCategory.ts:361`）—— 已含 `visible = 1` 过滤与已发布 `book_count`。
  **不要**用 `listCategories(db)`（后台用，不过滤 `visible`）。
- **响应白名单**：`{ id, name, slug, bookCount }`。**绝不整对象透传** ——
  `Category` 还带 `parent_id` / `sort` / `visible` / `created_at`，那些不对外。
- **鉴权**：走 `decideLoginCredentialApiRequest`（无需改动，登记后自动生效）。
- **OpenAPI**：`OpenApiDocument.ts` 登记该端点，**同步** `OpenApiTranslations.ts`（键是精确英文原文）。

## Acceptance criteria

- [ ] `yarn typecheck` + `yarn test` 通过
- [ ] `requiredApiPermission("/api/v1/content/categories/", "GET")` === `"content:category:read"`
- [ ] `requiredApiPermission("/api/content/categories/", "GET")` === `null`（legacy 未登记，应 404）
- [ ] worker 测试：持 `content:category:read` 的凭证 → `allow`
- [ ] worker 测试：无该权限的凭证 → `forbidden`（403）
- [ ] worker 测试：响应只含 `id` / `name` / `slug` / `bookCount` 四个键
      （断言 `Object.keys` 排序后相等，锁死"不泄漏内部字段"）
- [ ] worker 测试：`visible = 0` 的分类不出现在结果里
- [ ] `yarn test` 中 `tests/unit/openapi.test.ts` 三条通过（无缺条目 / 无死条目 / 无英文残留）
