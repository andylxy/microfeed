# 新增后台功能接入「菜单 + 权限」强制清单

> 适用范围：任何需要**后台管理页面 + 左侧菜单入口 + 权限控制**的新功能。
> 本清单来自 2026-09-27 标注标记功能（迁移 0068/0069）的实战教训，为**强制步骤**——漏一步就是一次线上回归。
> 最新完整样板：`annotation-markers`（迁移 0068/0069、`src/server/admin/annotation-marker-handlers.ts`、`src/pages/[adminPath]/annotation-markers/`、`src/pages/[adminPath]/ajax/annotation-markers/`）。

## 1. 权限码（代码层，2 处必须同步）

1. `src/shared/Constants.ts` 的 `PERMISSION_CODES` 加常量（如 `CONTENT_XXX_READ` / `CONTENT_XXX_MANAGE`）。
2. `src/server/rbac/seed.ts` 的 `RBAC_PERMISSIONS` 镜像同款 code+name——
   `tests/unit/admin-endpoint-guards.test.ts` 强制两者一致，不同步直接红。
3. 命名沿用三段式 `<域>:<资源>:<动作>`，查看用 `:read`、管理用 `:manage`。

## 2. 迁移（数据层，4 张表一个都不能少）

新建迁移文件 `migrations/00NN_*.sql`，序号递增：

1. **`ext_permissions`** —— ⚠️ **id 必须用 `permissionId()` 推导规则**：只把 `:` 换成 `_`，
   **其余字符（含连字符）原样保留**。`content:annotation-markers:read` →
   `p_content_annotation-markers_read`（连字符！）。0068 手写下划线 id 的后果：
   `code` 列 UNIQUE 使 `seedRbac` 的同码 `INSERT OR IGNORE` 变 no-op，授权外键找不到行，
   **全新安装的 `bootstrapAdmin` 直接 500**（生产未炸只因 owner 早已存在）。
   拿不准就在 node 里跑 `permissionId('你的code')` 打印确认。
2. **`ext_menu`** —— 菜单行**必须挂 `parent_code`** 到 0050 的分组（如 `group_content`），
   并设置 `sort`。菜单行的 `permission_code` 决定该入口对谁可见（**菜单可见性码**，
   admin-page-guards 测试强制与页面守卫同码）。
   ⚠️ 权限树（角色编辑器里的授权视图）**不再由 `ext_menu` 派生**——它来自
   `ext_permission_nodes`（ADR-0038 自持，`readRbacBoard` + `buildGrantGroupsFromNodes`）：
   组 = `kind='group'` 且 `parent_code IS NULL` 的行，页 = `kind='page'` 挂在组下，
   码 = `kind='code'` 挂在页下。新增权限只需在表内加一行 code 节点，无需改菜单。
3. **`ext_permission_nodes`** —— 权限树的载体（ADR-0038 自持表，替代旧的 `ext_menu_permissions`
   映射模式）。新增后台功能时，其权限码要作为 `kind='code'` 行挂在对应 `kind='page'` 节点下
   （page 挂在 `kind='group'` 组下）。**没有「其他」兜底桶**——码必须显式挂到某个页节点，
   否则角色编辑器看不到、没法勾选；后台「权限树」页可改名/排序/改父级/隐藏/新建分组，
   或导出 SQL 回写迁移。可见性门禁仍走 `ext_menu.permission_code`（页面守卫同码）。
4. **`ext_role_permissions`** —— 明确哪些既有角色默认授予（如 editor/readonly 授 `:read`），
   用 `INSERT OR IGNORE … SELECT … WHERE EXISTS` 守护式插入；**id 同样必须用推导 id**。
   同时在 `seed.ts` 的 `RBAC_ROLES` 对应角色数组里镜像同码（rbac.test.ts 有精确计数断言）。

## 3. 代码接线（页面与端点）

- 页面守卫：`requirePagePermission(locals, PERMISSION_CODES.XXX, lang)`，码与菜单行绑定一致。
- ajax 端点：`requireRbac(locals, code, request, env.FEED_DB)`；列表类用 `:read`，增改删用 `:manage`
  （**`hasPermission` 是精确匹配**，只有 `*` 通配，没有前缀匹配——别指望 `content:*:read` 盖住新码）。
- URL 助手：`src/shared/StringUtils.ts` 的 `ADMIN_URLS` 加 `ajaxXxx*`。
- 菜单显示文案：`i18n_key` 指向的键要在 `src/shared/i18n/en.ts` + `zh-CN.ts` 镜像补齐，`yarn i18n:check` 必须过。

## 4. 测试门禁（按顺序，全绿才算完）

1. `yarn vitest run tests/unit/admin-endpoint-guards.test.ts tests/unit/admin-page-guards.test.ts`
2. **`yarn vitest run --config vitest.worker.config.ts tests/worker/rbac.test.ts`** ——
   ⚠️ 必须全量跑：它包含 bootstrap→登录全链路用例，能抓住「权限 id 手写错 → bootstrap 500」这类
   只跑新功能测试发现不了的问题（0068 当天就漏过了）。
3. 新功能的定向 worker 测试 + `yarn typecheck` + `yarn i18n:check`。
4. 部署后**直查远程 D1** 验证：迁移已记录、行已写入（迁移静默应用 ≠ schema 已就位）。

## 5. 上线后给角色授权

角色编辑器（`/admin/rbac/`）的权限树按「分组 → 页面 → 勾选码」呈现本功能的权限；
未在迁移里默认授予的角色，由管理员在树上勾选保存即可。
