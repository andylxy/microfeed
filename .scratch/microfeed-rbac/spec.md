# 后台菜单加载 · 适配设计（定稿）

参照实现：XiHan BasicApp（`SysMenu` + `MenuRouteQueryService` + `PageRegistry`/`MenuSeeder`）
配套：`ADR-002-admin-menu-as-data.md`、`GLOSSARY.md`（simple-rbac-design 目录）
取代：`admin-menu-rbac-plan.md`（已标注作废，仅 §0/§2/§5 三节仍被引用）

---

## 0. 决策记录（2026-09-22 访谈定稿）

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | 6 个新权限点本期建不建 | **建**。原本建议延后，但那会让菜单可见性与页面守卫互相打架（见下条），故本期一并建并把菜单全绑上 |
| 2 | 菜单可见性与页面守卫冲突 | **两者必须一致**：菜单绑了哪个码，页面守卫就用哪个码；editor 看不到也进不去 |
| 3 | editor 拿到哪些新码 | **只拿内容域**：`content:article:read/create/update` + `content:page:manage` + `content:site_file:manage`。审核、审计、频道、API 四项留给 super_admin |
| 4 | `content:article:delete` 给不给 editor | **不给** |
| 5 | 二级菜单（`parent_code`） | **暂不启用**，只预留字段 |
| 6 | 按钮级权限 | **暂不做** |
| 7 | 菜单数据放哪 | **表是唯一真相**：删掉 `NAVIGATION_PATHS`，`NAV_ITEMS` 降级为菜单码常量 |
| 8 | 四个区的子侧栏 | **维持现状**（各自的 `ADMIN_*_PAGES` 常量），不并入 `ext_menu` |
| 9 | 命名 | **全部统一为 `menu`**（表 / 类型 / 常量 / i18n 键） |
| 10 | 菜单管理界面 | **本期不做**，改菜单走迁移 |

**决策 2 的由来（关键）**：若按最初建议让 6 个菜单的 `permission_code` 留 NULL（公共可见），而 §7 又给这些页面补 `content:page:manage` 之类的守卫，editor 就会**在侧栏看得见、点进去 403**。菜单可见性与页面可进性必须同一把尺子。

---

## 1. 模型：菜单是数据，不是代码

- 一个菜单项 = `ext_menu` 表的一行。
- 菜单与权限的**唯一**关联是行上一个**可空**的 `permission_code`：**为空 = 公共菜单，对任何登录账号可见**（首页就是这种）。
- **一个菜单只绑一个权限点**（BasicApp 的硬约束）。需要多个权限才显示时，建一个**组合权限点**绑上去，而不是让菜单持有多值。
- **菜单 ≠ 权限**：菜单只描述 UI 层级；鉴权永远基于权限点、不依赖菜单是否存在。菜单隐藏**不构成**访问控制。

---

## 2. 加载管线（照 BasicApp）

`readAdminMenu(db, locals, adminPath, activeCode)`：

1. 取 `is_visible = 1` 的行；
2. 逐条判定：`permission_code` 为空 ⇒ 可见；否则 权限集含 `*`、或是 legacy admin（`auth_user.role === "admin"`）、或命中该码 ⇒ 可见；
3. 按 `sort, code` 排序，按 `parent_code` 建树（本期扁平）；
4. 剪掉无可见子项的父节点；
5. **兜底**：一条不剩则返回首页那一项 —— 侧栏永不为空。

判定必须与 `guard.ts:110-117` **同源**（抽公共纯函数），否则会出现"菜单看不见、直接访问 URL 却放行"。

---

## 3. 数据模型与迁移

```sql
CREATE TABLE IF NOT EXISTS ext_menu (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,   -- all_items / books / ...
  parent_code     TEXT,                   -- 预留，本期不用
  path            TEXT NOT NULL,          -- 后台相对路径片段，如 "items/list"
  i18n_key        TEXT NOT NULL,          -- menu.item.all_items
  icon            TEXT,                   -- 图标名，前端映射到 lucide 组件
  permission_code TEXT,                   -- NULL = 公共菜单
  sort            INTEGER NOT NULL DEFAULT 0,
  is_visible      INTEGER NOT NULL DEFAULT 1,
  created_at_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ext_menu_parent ON ext_menu(parent_code);
CREATE INDEX IF NOT EXISTS ix_ext_menu_permission ON ext_menu(permission_code);
```

**用 `permission_code` 而不是权限 id**：`locals.rbacPermissions` 本身就是权限码集合（`resolve.ts:14-34`），用码省掉一层反查。

**迁移**（两张，分开更清晰）：
- `0040_ext_menu_permissions.sql`：新增 6 个权限码 + 给 editor 补 5 条授权（`INSERT OR IGNORE`，与 0031/0035 写法一致）；
- `0041_ext_menu.sql`：建表 + 播种 16 行。

**必须同步的三处**（否则门禁红）：
1. `src/server/rbac/seed.ts` 的 `RBAC_PERMISSIONS`（29 → **35**）与 `RBAC_ROLES.editor`（11 → **16**）；
2. 迁移 SQL；
3. `tests/worker/rbac.test.ts` 的两条断言（目录行数一致、editor 授权条数 11 → 16）。

另：`ext_menu` 须登记进 `manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES`（durable），否则 `snapshot.test.ts` 会红。

---

## 4. 接线

| 文件 | 改动 |
| --- | --- |
| `src/layouts/AdminShell.astro:133` | `getAdminNavigationItems(...)` → `await readAdminMenu(env.FEED_DB, Astro.locals, adminPath, activeNavItem)` |
| `src/components/admin/AdminSidebar.tsx` | 图标改为**按数据里的图标名查表**（`MENU_ICONS: Record<string, LucideIcon>` + 兜底图标）；硬编码的 `navigationIcons` 退役 |
| `src/components/admin/AdminMobileNavigation.tsx` | 同上（消费同一份 `sidebar.items`） |
| `src/shared/admin-shell-types.ts` | `AdminNavigationItem` → `AdminMenuItem`，补可选 `icon` |
| `src/shared/AdminNavigation.ts` | 删除 `NAVIGATION_PATHS`；`NAV_ITEMS` → `ADMIN_MENU_CODES`（只作菜单码常量） |

**onboarding 的置灰行为保留**：`disabled = code !== home && !onboardingResult.requiredOk`，与现在一致。

---

## 5. 16 项种子（最终）

| code | path | i18n_key | icon | permission_code |
| --- | --- | --- | --- | --- |
| `admin_home` | `""` | `menu.item.admin_home` | `home` | **NULL**（公共） |
| `edit_channel` | `channels/primary` | `menu.item.edit_channel` | `pencil` | `content:channel:manage` ⚠ |
| `all_items` | `items/list` | `menu.item.all_items` | `list` | `content:article:read` |
| `import_chapters` | `items/import` | `menu.item.import_chapters` | `upload` | `content:article:create` |
| `review` | `review` | `menu.item.review` | `shield-check` | `content:review:manage` ⚠ |
| `audit` | `audit` | `menu.item.audit` | `history` | `content:audit:read` ⚠ |
| `pages` | `pages` | `menu.item.pages` | `file-text` | `content:page:manage` ⚠ |
| `categories` | `categories` | `menu.item.categories` | `tags` | `content:category:read` |
| `books` | `books` | `menu.item.books` | `book` | `content:book:read` |
| `volumes` | `volumes` | `menu.item.volumes` | `layers` | `content:volume:read` |
| `site_files` | `site-files` | `menu.item.site_files` | `file-code-2` | `content:site_file:manage` ⚠ |
| `api` | `api` | `menu.item.api` | `code-2` | `system:api:manage` ⚠ |
| `webhooks` | `webhooks` | `menu.item.webhooks` | `webhook` | `system:webhook:manage` |
| `rbac` | `rbac` | `menu.item.rbac` | `shield-check` | `system:role:manage` |
| `users` | `users` | `menu.item.users` | `users` | `system:user:manage` |
| `settings` | `settings` | `menu.item.settings` | `settings` | `content:settings:manage` |

⚠ = 本期新建的 6 个码。`system:api:manage` 与既有 8 个 `api:*`（签名调用语义）互不替代：后者管"签名 API 能读什么资源"，前者管"谁能进后台 API 管理页"。

---

## 6. 权限与 editor 授权（最终）

**新建 6 个码**：`content:channel:manage`、`content:review:manage`、`content:audit:read`、`content:page:manage`、`content:site_file:manage`、`system:api:manage`。目录 29 → 35。

**editor 授权 11 → 16**：

| 新增 | 理由 |
| --- | --- |
| `content:article:read` | 否则看不到内容列表 |
| `content:article:create` | 否则看不到导入章节 |
| `content:article:update` | 修复既有缺陷：`ajax/feed.ts:148-153` 要求此码，editor 当前**无法编辑或新建章节** |
| `content:page:manage` | 页面属内容域 |
| `content:site_file:manage` | 站点文件属内容域 |

**不给**：`content:article:delete`（决策 4）、`content:review:manage`、`content:audit:read`、`content:channel:manage`、`system:api:manage`（治理域，留给 super_admin）。

**editor 最终可见 8 项**：首页、内容列表、导入章节、书、分类、卷、页面、站点文件。
**editor 不可见 8 项**：频道、审核、审计、API、Webhook、角色权限、用户、设置。

---

## 7. 页面与端点守卫（一致性红线）

沿用 `admin-menu-rbac-plan.md` §5 的 14 页清单（items / pages / site-files / review / audit / channels / settings / api / books / categories / volumes / webhooks）。

**一条硬约束**：页面守卫用的权限码，必须与 `ext_menu` 行绑定的 `permission_code` **同一个**。否则又回到"菜单看得见、点进去 403"。

**有意不加码**：`account/**`（自助区，用 `requireAuthenticatedRbac`）、`login*` 与 `ajax/auth/credential-login`（未登录也要可达）、`ajax/search`。

另建议把 `users/index.astro:21`、`rbac/index.astro:22` 的**裸文本 403** 换成带外壳的"无权限"页（含返回后台的入口），否则从书签直达的用户只看到一屏白底文字。

---

## 8. 命名统一与改名影响面

| 现名 | 新名 | 影响面 |
| --- | --- | --- |
| 表（新增） | `ext_menu` | — |
| `AdminNavigationItem` | `AdminMenuItem` | 类型定义与 3 处引用 |
| `NAV_ITEMS` | `ADMIN_MENU_CODES` | 约 40 个 `.astro` 页面的 `activeNavItem={NAV_ITEMS.X}`、`AdminSidebar.tsx`、`scripts/check-i18n.ts:21`、`tests/unit/shared/admin-navigation.test.ts`、`tests/unit/source-architecture.test.ts:365` |
| `nav.item.*` | `menu.item.*` | 16 键 × 2 语言 + `check-i18n.ts:94` 的 nav 标签校验 |
| `getAdminNavigationItems` | `readAdminMenu` | `AdminShell.astro` 与单测 |

**注意**：只搬 `nav.item.*` 这 16 个键。侧栏外壳自己的键（`nav.adminNavigation`、`nav.openPublicAccess`、`nav.addNewItem` 等）**不动**——它们不是菜单项。

---

## 9. 执行顺序

| # | 内容 |
| --- | --- |
| T1 | 迁移 0040：6 个新权限码 + editor 补 5 条授权；同步 seed.ts 与 worker 断言（29→35、11→16） |
| T2 | 迁移 0041：建 `ext_menu` + 播种 16 行；登记 `SNAPSHOT_TABLES` |
| T3 | `readAdminMenu()`：过滤 / 排序 / 建树 / 剪枝 / 兜底 + 与 guard 同源的判定函数 |
| T4 | 接线：`AdminShell.astro` + `AdminSidebar` / `AdminMobileNavigation` 图标按数据查表 |
| T5 | 命名统一：`ADMIN_MENU_CODES` / `AdminMenuItem` / `menu.item.*` / `check-i18n.ts` |
| T6 | 测试：每个菜单码在表里都有行；无权限只见首页（兜底非空）；editor 可见 8 项；`*` 与 legacy admin 全可见；公共项对所有人可见 |
| T7 | 页面与端点守卫补齐（14 页）+ 无权限页改造 |
| T8 | 门禁（typecheck / i18n / lint / unit / worker / build）与部署 |

---

## 10. 本期不做与已知取舍

- **菜单管理界面**：不做。改菜单 = 写迁移。所以"加页面不改代码"这个收益本期只兑现一半（不用再碰渲染组件与常量，但仍要动仓库）。
- **二级菜单**、**按钮级权限**：只预留 `parent_code`，不做按钮级。
- **子侧栏**（API / Webhook / 设置 / 账户）：仍是代码常量，模型未统一 —— 是有意保留的不一致，等主菜单跑顺了再说。
- **缓存**：不做（BasicApp 有，microfeed 不需要）。每请求查 16 行，代价可忽略；且权限本来就要逐请求解析。
- **editor 现在才补 article 授权**：意味着在此之前 editor 实际无法编辑章节，这是既有缺陷而非本次引入。
