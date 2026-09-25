# 01: 登记路由与授权 + 端点 1（分类列表）

**What to build:** 让 `/api/v1/content/*` 走通鉴权，并交付第一个可用端点——
持有 `content:category:read` 的登录凭证能取到可见分类清单（含每个分类的已发布书数）；
无凭证被拒、legacy API key 走不通。

**Blocked by:** None（可立即开始）

**Status:** done (2026-09-24)

- [ ] `integrationSuffix()`（`src/server/api/access.ts`）在 **`!legacy && (...)` 守卫内**登记四条：
      `suffix === "content/categories/"`、
      `/^content\/categories\/[^/]+\/books\/$/u`、
      `/^content\/books\/[^/]+\/chapters\/$/u`、
      `/^content\/chapters\/[^/]+\/$/u`
- [ ] `DOMAIN_RULES`（`src/server/api/api-permissions.ts`）加三个前缀：
      `content/categories` → `content:category:read`、
      `content/books` → `content:book:read`、
      `content/chapters` → `content:article:read`
      （漏登即"对任何已认证凭证开放"，必须与上一条**同时**完成）
- [ ] 新建端点 `GET /api/v1/content/categories/`，复用 `listCategoryNav(db)`（已含 `visible = 1`
      与已发布 `book_count`）
- [ ] 响应**白名单**挑字段，每项 `{ id, name, slug, bookCount }`——**绝不整对象透传**
      （`Category` 带 `parent_id`/`sort`/`visible`/`created_at` 等内部字段）
- [ ] 测试：有 `content:category:read` 的凭证 → 200 且形状为白名单四项
- [ ] 测试：无凭证 → 401
- [ ] 测试：legacy `Bearer <非 mflc>` → 404（走不通，因登记在 `!legacy` 内）
- [ ] 测试：凭证无 `content:category:read` → 403
- [ ] `yarn typecheck` + `yarn test` 通过
