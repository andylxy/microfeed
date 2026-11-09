# ADR-0072: 移除 /book-statuses/ 模块与字典表 ext_book_status

ADR-0069 退役 6 个 legacy 内容看板后，`/book-statuses/` 是残存的旧内容管理系统入口之一：它以字典表 `ext_book_status`（迁移 0142 / 0143 建）为唯一数据源，管理页面 `/admin/book-statuses/` + ajax + 组件 + handler + 数据层 `extBookStatus.ts` 构成一条完整但独立的链路。本决策按用户「删除模块及相关的文件、数据表等」要求，移除整条链路、删除 `ext_book_status` 表、回收其权限码与菜单项，并保留 `channels.status` 列（值语义由 `STATUSES` + `MEMBER_BOOK_STATUS` 常量承载）。**不触及** `book-info/statuses.ts`（ADR-0058 的 `settings` 表 `book_info_statuses`，书用 `hot_book`）——两套状态系统完全独立。

- 状态：Accepted（2026-11-09 决策定稿并实施；`tsc --noEmit`、`yarn i18n:check`、定向测试（extCategory / admin-menu / rbac）与 `check-front-site-decoupling` 见「验证」；部署与门禁由用户另行触发）
- 关联：ADR-0058（`book-info/statuses.ts` 独立状态系统，**不删**）、ADR-0069（决策 2「6 个 feed 数据层文件与 5 张字典表保留」——本决策是 `extBookStatus` 与 `ext_book_status` 的退役到极致）、ADR-0068（删表后 `SNAPSHOT_TABLES` / `DEEP_TABLES` 旧表名仍须保留的先例）、迁移 0142 / 0143（建表+种子+菜单/权限，被本决策的 0194 撤销）、迁移 0168（`ext_menu` 表已删，本决策不写 `DELETE FROM ext_menu`）
- 证据范围：本地真库只读探针 2026-11-09（`ext_book_status` 4 行：1/2/3/10，`public_visible={1}`，`form_selectable={1,2,10}`，`admin_list_hidden={3}`，无 FK、无孤儿引用；`ext_role_permissions` 对该码引用 0 行；`ext_user_permissions` 聚合表无 `permission_id` 列）、代码调用链只读调查（`src/server/feed/*`、`src/pages/[adminPath]/book-statuses/`、`src/pages/[adminPath]/ajax/book-statuses/`、`src/components/admin/book-statuses/`、`src/server/admin/book-status-handlers.ts`、`src/shared/ExtBook.ts`）

## 背景与删除边界

`/book-statuses/` 模块以 `ext_book_status` 字典为唯一数据源，`channels.status` 存其 `code`。与 `book-info/statuses.ts`（ADR-0058）完全独立：后者是 `settings` 表 `book_info_statuses`，用于书（`hot_book`），不读 `ext_book_status`。

模块链路（全部移除）：
- 页面：`src/pages/[adminPath]/book-statuses/index.astro`
- AJAX：`src/pages/[adminPath]/ajax/book-statuses/index.ts`、`[code].ts`
- 组件：`src/components/admin/book-statuses/BookStatusesApp.tsx`
- Handler：`src/server/admin/book-status-handlers.ts`
- 数据层：`src/server/feed/extBookStatus.ts`
- 共享：`src/shared/ExtBook.ts`（11 个导出中仅 `MEMBER_BOOK_STATUS` 活跃，见「MEMBER_BOOK_STATUS 迁移」）
- 测试：`tests/unit/server/ext-book-status.test.ts`

**保留**：
- `channels.status` 列（值语义由 `STATUSES` + `MEMBER_BOOK_STATUS` 常量承载，不删列、不迁值）
- 前台可见性判据：`extCategory.ts` 4 处调用的 `listPublicVisibleStatusCodes()` 替换为常量 `[STATUSES.PUBLISHED]`（=1）；删表后行为精确回退 0142 前（生产当前 `public_visible` 集合 `{1}`）
- `book-info/statuses.ts`（ADR-0058，完全独立）

## MEMBER_BOOK_STATUS 常量迁移

`src/shared/ExtBook.ts:19` 的 `MEMBER_BOOK_STATUS = 10` 是 `tcm/reads.ts` 唯一活跃依赖（App 书库会员门，读 `channels.status IN (1,10)`）。随 `ExtBook.ts` 整体删除迁移到 `src/shared/Constants.ts`（`STATUSES` 之后），`tcm/reads.ts` 的 import 同步改为 `@/shared/Constants`。其余 `ExtBook.ts` 导出（`BookStatusRow`/`BookStatusOption`/`BooksBoard`/`BookAdmin`/`BookInput`/`BookCategoryOption`/`BookAuthor`/`BOOK_STATUS_COLOR_PATTERN`/`bookStatusBadgeStyle`/`bookStatusDisplayName`）全部孤儿，随文件删除。

## 决策

1. **删除 `/book-statuses/` 模块链路**（页面 1 + ajax 2 + 组件 1 + handler 1 + 数据层 1 + 共享 1 + 测试 1，共 8 个物理文件），先备份到 `.scratch/backups/book-status-module-20261109/`（8 文件镜像）再删。
2. **删除字典表 `ext_book_status`**（迁移 0194）：`DROP TABLE IF EXISTS ext_book_status`。`channels.status` 列与值**不动**；删表后无 FK 风险（探针确认无外键指向该表、`channels.status` 无孤儿引用）。
3. **删除迁移 0194_data_retire_book_status_module.sql**：`ext_permission_nodes` 按 `code='content:book-status:manage'` 删除、`ext_permissions` 按码名删除、`DROP TABLE ext_book_status`。**不写** `DELETE FROM ext_menu`（`ext_menu` 表已随迁移 0168 删除，写了会报错）。迁移含 `-- rollback:` 块（按 `docs/agents/arch-gates.md`，data 类迁移必须带）。
4. **权限与菜单**：`PERMISSION_CODES.CONTENT_BOOK_STATUS_MANAGE` 从 `Constants.ts` 删除；`ADMIN_MENU_CODES.BOOK_STATUSES` 删除；`AdminPageGuards.ts` 的 `"book-statuses"` 守卫项删除；`RbacPermissionDocs.ts` 的 `content:book-status:manage` 块删除；`seed.ts` 的 `RBAC_PERMISSIONS` 经 `yarn rbac:gen` 重铺（**不手改**，生成器按 `PERMISSION_CODES` 声明顺序 + 迁移重放 name 生成）；`docs/novel-cms/adr/0057-page-guard-registry.md` 的 `book-statuses` 行删除。
5. **共享清理**：`StringUtils.ts` 删 `ajaxBookStatuses` / `ajaxBookStatus`；`Constants.ts` 删 2 项（`ADMIN_MENU_CODES.BOOK_STATUSES`、`PERMISSION_CODES.CONTENT_BOOK_STATUS_MANAGE`）；`AdminPageGuards.ts` 删 1 项；`RbacPermissionDocs.ts` 删 1 块。
6. **i18n**：`en.ts` / `zh-CN.ts` 各删 5 块（`menu.item.book_statuses`、`admin.bookStatuses`、`pageTitle.bookStatuses`、`pageDocumentTitle.bookStatuses`、`errors.bookStatuses`），改后跑 `yarn i18n:check`。
7. **快照分类与同步清单保留旧表名**（ADR-0068 先例）：`manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES.durable` 与 `.scratch/backups/sync-table-classification.mjs` 的 `DEEP_TABLES` 中 `ext_book_status` 条目**保留**，只改注释——移除会令 0194 前的旧快照恢复两处硬失败（`assertClassifiedTables` 只查「库表 ⊆ 清单」，清单多余项无害；`rowCounts` 只遍历 `tables.durable`，保留条目安全）。`reconcile-local-remote.mjs` 对不在本地清单里的 `DEEP_TABLES` 成员打 `[跳过]` 并继续（表退役时不再让本地取数抛 `no such table`）。
8. **测试**：`tests/unit/server/extCategory.test.ts` 删 `ext_book_status` 建表+种子夹具；`tests/worker/admin-menu.test.ts` menuIds 删 `ADMIN_MENU_CODES.BOOK_STATUSES` + 注释更新 + `group_content` 首项 url 改 `/admin/items/list/`（删 `book_statuses` 后首项 = `all_items`，`page_all_items` path=`items/list`）。

## 数据完整性核准

全部数字为 2026-11-09 本地真库只读探针结果（`.scratch/d1-probe/verify-ext-book-status.mjs` 核验输出）。

| # | 方向 | 当前值 | 删除后值 | 异常条件 | 处置 |
|---|---|---|---|---|---|
| 1 | `ext_book_status` 行 | 4 行（code 1/2/3/10） | 0 行（表删） | 有 FK 指向或 `channels.status` 有孤儿则删表不安全 | 探针确认无 FK、无孤儿，可删 |
| 2 | `public_visible` 集合 | `{1}` | `{1}`（常量回退） | 集合非 `{1}` 时删表改变前台可见性 | 生产当前恰为 `{1}`，回退 0142 前行为 |
| 3 | `form_selectable` 集合 | `{1,2,10}` | `{1,2}`（`STATUSES` 常量） | 会员码 10 仅经常量承载 | `MEMBER_BOOK_STATUS=10` 迁 `Constants.ts` |
| 4 | `admin_list_hidden` 集合 | `{3}` | 无（后台已无入口） | — | 模块整体删除，无消费方 |
| 5 | 权限码引用 | `ext_role_permissions` 对该码 0 行 | 0 行 | — | 无需清授权 |
| 6 | 权限聚合 | `ext_user_permissions` 无 `permission_id` 列 | 无角色授权 ⇒ 聚合不含该码 | 无需重算 | 不触发快照重算 |
| 7 | 菜单 | 侧栏「内容」1 项 `book-statuses` | 0 项 | — | `group_content` 首项变为 `all_items` |

## 验证

- `tsc --noEmit` exit 0；`yarn i18n:check` 通过；`grep` 无残留 `book-statuses|extBookStatus|ext_book_status|BookStatusRow|BOOK_STATUS`。
- 定向测试：`extCategory.test.ts` / `admin-menu.test.ts` / `rbac.test.ts`（`seed.ts` 重铺后权限计数同步）。
- `check-front-site-decoupling` 手动执行通过（前台零耦合不变式）。
- 备份（回滚点）：`.scratch/backups/book-status-module-20261109/`（8 文件镜像）；方案存档 `.scratch/remove-book-statuses-plan.md`（12 节）。
- 不跑全量门禁（按 AGENTS.md，门禁仅用户手动触发）；部署与门禁由用户另行触发。

## 考虑过的选项

- **删表后从 `SNAPSHOT_TABLES.durable` / `DEEP_TABLES` 移除 `ext_book_status`**：不选。ADR-0068 先例（`ext_menu`/`ext_menu_permissions`/`ext_tcm_aliases` 均保留）明确「旧表名仍须留在分类清单」，移除会令旧快照恢复硬失败。
- **删 `channels.status` 列**：不选。列是活跃共享结构（`FeedDb` 通用编辑器路径、`reads.ts` tier 门、站点频道），值语义由常量承载即可，删列属破坏性 schema 变更、超出模块边界。
- **只删页面不删表**：不选。用户明确要求「相关的文件、数据表等」一并移除；表是模块唯一数据源，删后无消费方，且探针确认删除安全。
- **保留 `extBookStatus.ts` 数据层**：不选。其唯一消费方是 `/book-statuses/` 模块自身与 `extCategory.ts` 的 4 处 `listPublicVisibleStatusCodes()`；后者已改为常量回退，文件失去全部调用方。

## 后果

- 管理员失去 `/book-statuses/` 入口；`channels.status` 列与值不变，`tcm/reads.ts` 会员门经 `MEMBER_BOOK_STATUS=10` 常量继续工作。
- 前台可见性回退 `{1}`（`STATUSES.PUBLISHED`），与 0142 前行为精确一致（生产当前 `public_visible={1}`）。
- 权限码 `content:book-status:manage` 移除，`seed.ts` 重铺；`ext_book_status` 表随 0194 删除，旧快照恢复仍认该表名（`SNAPSHOT_TABLES`/`DEEP_TABLES` 保留条目）。
- 0194 与代码同一次部署（`manage deploy`，实例 `ctwh-881019-xyz`）；App 8 端点、前台独立内容引擎不受影响。
