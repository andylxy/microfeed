# 管理后台界面

本册从仓库根 `AGENTS.md` 移出，规则条文与实测记录逐字保留；触发条件见 `AGENTS.md` 的读取约定。

## 管理后台左侧菜单（导航树）

左侧导航是一棵任意深度树，由 `ext_permission_nodes` 权限节点表驱动（ADR-0038 自持树、ADR-0041 菜单并入、ADR-0042 D6 切换），前端在 `AdminSidebar` 里递归渲染 `AdminMenuItemLink`。分组节点可展开/收起；当前页所在的祖先链自动展开；展开态按账号记进 `localStorage`。

### 数据来源与结构

- 侧栏行集 = 桌面端（`audience = 'desktop'`）的 `kind = 'group'` 分组行与 `kind = 'page'` 页面行；码行（`kind = 'code'`）是角色编辑器里的勾选项，不进侧栏；App 端节点没有侧栏。表自引用：`parent_code` 指向同表父行，带 `ix_ext_permission_nodes_parent` / `_audience` / `_kind` / `_sort` 四个索引。
- 页面行携带 `path`（相对 `/admin/` 的入口路径，分组行为 NULL）与 `entry_code`（入口门码），分组行两列均为 NULL；另有 `icon`、`sort`、`is_visible`、`i18n_key`、`source`、`created_at_ms` 与 `name_zh` / `name_en`（均可空，作为可选覆盖）。
- 组装在 `src/shared/AdminSidebarItems.ts` 的 `buildSidebarItems`：按 `(sort, code)` 读序；`entry_code` 为空的页面行只挂码、不进侧栏；门码非空时按账号权限集合判定（持 `*` 通配视为全见）；子项全空的分组剪掉，父分组被滤掉时子分组升为顶层；分组本身不是页面，链接指向第一个子项。查询在 `src/server/admin/menu.ts` 的 `readAdminMenu`，门控走 `rbacAllows`。
- 页面可达性由页面自身的 `requirePagePermission` 决定，判据是该页面节点绑定的同一个门码（一入口一门码，故为相等）。两侧一致由迁移人工比对、`tests/unit/admin-page-guards.test.ts` 静态重放迁移、`tests/worker/admin-menu.test.ts` 的「菜单行 ↔ 页面节点」比对检查共同保证。
- 同一份组装器给 `/admin/rbac/` 的「侧栏预览」复用：预览按所选角色的权限集合拼行集，运营调整门码即可看到侧栏的变化，两处不会漂移。
- `ext_menu` 表只剩迁移种子一个用途：全新安装先走它的种子，0133 再把配对行回填进节点表；0135 已删掉随菜单管理页退役的 `menu_management` 行。

### 三级子项的注入

`SETTINGS`、`API`、`WEBHOOKS` 三个页面节点（`page_settings` / `page_api` / `page_webhooks`）没有第三层子节点，它们的第三级由 `AdminSidebar` 的 `SUB_SECTION_BUILDERS` 在渲染时注入（这些子项属于页面分区或真实子页，数据树里没有它们）：

- `SETTINGS` → `ADMIN_SETTINGS_SECTIONS`（11 个同页锚点，形如 `设置#custom-code`），活动项跟随正文滚动所在分区（`settings-section-state` store 同步）。
- `API` → `ADMIN_API_PAGES`（真实子页）。
- `WEBHOOKS` → `ADMIN_WEBHOOK_PAGES`（真实子页）。

新增一个域（又一个需要三级的二级节点）就在 `SUB_SECTION_BUILDERS` 加一行（键写页面节点码），并把清单写进对应模块（`AdminSettingsNavigation` / `AdminApiNavigation` / `AdminWebhookNavigation`）。每个页面节点保留自己的 `menu.item.*` 文案键——`menuEntryLabelKey` 按 `group_` 前缀判分组、不看有没有子节点，所以带注入子项的页面节点不会变成分组键。

### 名称解析

渲染优先级（见 `src/shared/AdminNavigation.ts` 的 `adminMenuItemLabel`）：`name_zh` / `name_en` 当前语言列优先，该列为空取另一列，两列皆空回退到 `menu.item.*` / `menu.group.*` 的 i18n 文案。

### 菜单管理页已退役

菜单入口已并入权限树（ADR-0041 D5 / ADR-0042 D6）：`/admin/menu/` 整页下线，`page_menu_management` 节点与 `system:menu:manage` 码随迁移 0135 一并删除。菜单的改名 / 排序 / 显隐 / 父级 / 新建分组全部在「角色管理」页的权限树里做。

图标名清单 `src/shared/MenuIconNames.ts` 与 `AdminMenuItemLink.MENU_ICONS` 一一对应，由 `tests/unit/menu-icon-registry.test.ts` 守护。

### 渲染防闪烁

`AdminShell.astro` 给 `AdminSidebar` 岛加了 `transition:persist="admin-menu-sidebar"`，导航时组件实例保留、只换 props，避免每次切换都重建侧栏造成的闪烁。其余四个侧栏岛不加该属性。

## 交互样式

- 每个启用的可点击控件必须使用 pointer 光标，包括链接、按钮、单选按钮、复选框、开关以及带 `role="button"` 或 `role="switch"` 的自定义控件。优先在全局样式表中统一约束共享交互行为，不在每个组件重复光标工具类。
- 禁用的控件必须使用原生 `disabled` 属性或 `aria-disabled="true"`，并显示 `not-allowed` 光标。

## 管理后台国际化

- 后台通过全局实例使用 i18next + react-i18next（后台是 Astro islands，没有共享的 React Provider）。资源在 `src/shared/i18n/en.ts` 与 `zh-CN.ts`；zh-CN 的键形状必须镜像 en（编译期检查）。en.ts 是键形状的唯一事实来源，新增键时在 `tests/unit/i18n.test.ts` 中保持键一致性测试通过，并跑「键存在性 + 中英文一致性」校验（`tsc` 通过 ≠ 键正确）：键存在性扫描的正则必须能覆盖含空格与撇号的英文整句，否则会漏报。
- **语言解析顺序（三处必须一致）**：显式选择的语言 cookie `microfeed-admin-language` → `Accept-Language` / `navigator.language`。服务端用 `adminLanguageFromRequest(request)`；内联脚本 `AdminLanguageScript.astro` 与客户端 `detectBrowserLanguage()`（`src/client/i18n.ts`）用同样的顺序。任一处漏掉 cookie，首屏就会渲染成错的语言（先英文、水合后翻中文的闪烁）。切换语言会 `location.reload()`，使服务端渲染的标题与 `<html lang>` 一致。
- **有文案的岛屿用 `client:only="react"`**：`client:load` 会服务端渲染，而服务端 i18next 单例恒为 en（没有 `window`）→ 首屏出英文。保留 `client:load` 的仅限无文案（`Toaster`）或纯图标触发器（`AdminThemeMenu`、`AdminLanguageMenu`，语言切换器必须立即可用）。
- **公开 API 错误正文按 `Accept-Language` 本地化，不读管理端 cookie**，避免公开规范随管理员的语言选择变化；响应头与状态码一律不变。
- **管理后台日期/时间统一固定数字格式**（站点要求，2026-10-14）：一律用 `src/client/admin-date-format.ts` 的 `formatAdminDateTime`（`2026-10-14 11:29:42`，24 小时制、本地时区）——**所有**日期显示（含条目列表、搜索结果这类列表列）都用它，不再有「仅日期」变体。**禁止** `toLocaleString()` / `Intl.DateTimeFormat` / 各语言不同的写法：它们随语言与系统变，同一个后台在两台机器上会渲染成两种样子，审计/日志这类需要并排比较的时间尤其不能这样。不要在任何服务端渲染路径里用它（workerd 是 UTC）。
- 待办：日期/数字本地化（`humanizeMs` 硬编码 en-US，其输出是公开 feed 的一部分，需要单独谨慎修改）。
- 更改 UI 文案（i18n）时，既有测试可能断言旧英文文案；把这些断言更新为对应的 i18n 键调用或新的渲染文本，运行时机归「门禁仅在手动触发时运行」。
