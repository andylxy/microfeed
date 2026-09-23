# Code review — 2026-09-23

**Fixed point**：HEAD `3ac9b4a`（其后无提交，故评审对象是**未提交工作树**：`git diff HEAD`，22 文件，+1442/−597 + 未跟踪文件）

**Standards 源**：`AGENTS.md`、`CONTRIBUTING.md`
**Spec 源**：`.scratch/microfeed-rbac/adr/0001-permission-tree-follows-menu.md`、同目录 `permission-tree-design-questions.md`（Round 1/2/3 结论，M1–M12 为已接受答案）

---

## Standards

### 硬性违规（有据可引）

1. **提交范围混入无关内容** —— AGENTS.md「最高指令」："绝不提交无关变更、临时目录（如 `.zcode/`、`.workbuddy/`）"。工作树改了 `.workbuddy-ai/memory/MEMORY.md`、`.workbuddy/memory/MEMORY.md`，并留下未跟踪的 `.workbuddy*/memory/2026-09-2*.md`、`.scratch/microfeed-rbac/*`、`CONTEXT.md`。→ 这些必须排除在 `git add` 之外。
2. **一个提交承担多个无关结果** —— CONTRIBUTING.md "Keep the pull request to one logical outcome"。除菜单分组与权限树外，同工作树还含并发会话的密码策略与只读角色（`0042`/`0043`/`0046`、`seed.ts`、`UsersApp`）以及 `AGENTS.md` 整篇重排（+319/−194）。
3. **错误文案与行为不符** —— `rbac-handlers.ts:463` 对 `readonly` 也返回 `reservedRole`，而 `en.ts:1963` 文案只讲 "super_admin is reserved…"。改名 `readonly` 会读到关于 `super_admin` 的提示（既有代码，非本次引入）。

### 判断项（可能的气味）

- **Duplicated Code**：`menu.group.` + 去 `group_` 前缀共三份 —— `AdminMenuItemLink.tsx:53-57`、`AdminGroupSidebar.tsx:34`、`RbacApp/index.tsx:27-36`。
- **Primitive Obsession**：`RbacApp/index.tsx:71-74` 写死 `"super_admin"` / `"readonly"`，而 `DEFAULT_USER_ROLE`、`CODE_LOCKED_ROLES` 已定义。
- **Mysterious Name**：`RESERVED_ROLES`（`{super_admin}`）与 `CODE_LOCKED_ROLES`（`{super_admin, readonly}`）并存，含义重叠、成员不同。
- **Divergent Change**：`rbac-handlers.ts` 同时承担角色 CRUD、建号默认角色、带重建的改名逻辑。
- **悬空引用**：`0052_ext_menu_permissions.sql:4` 指向 `.scratch/microfeed-rbac/adr/0001-permission-tree-follows-menu.md`，若 ADR 不随迁移一并提交，注释即指向不存在的文件。

### 已核对、未发现问题

架构边界合规（`RbacApp` 只 import `@/shared` / `@/client`）；新复选框光标由 `src/styles/interactive.css` 全局统一（符合「优先在全局样式表统一约束」）；`manage-cli/lib/snapshot.ts` 已把 `ext_menu_permissions` 列入快照表。

---

## Spec

### (a) 缺失 / 部分实现

**M11 级联交互测试只做了一半。** Spec：「**补**：分组全选 / 页面全选 / 叶子切换 / 半选回填 / 保存只含叶子」。当前只有纯函数级（`tests/unit/shared/rbac-permission-tree.test.ts`）与一个 `AdminGroupSidebar` 渲染例；**无 `RbacApp` 组件/交互测试**，也未断言保存载荷只含叶子码（本仓组件测试是 `renderToStaticMarkup`，无 DOM 交互设施）。

### (b) 未要求的改动（scope creep）

1. 角色 code 改名整条链：`ajax/rbac/role-code.ts`、`renameRbacRoleCode`/`updateAdminRbacRoleCode`、`ajaxRbacRoleCode`、RbacApp 改名输入 + `isCodeLocked` + `rbac.roleCodeLocked`。spec/ADR 通篇未提。
2. `UsersApp` 建号角色勾选（+`rbac.newAccountRoles`、预勾 `DEFAULT_USER_ROLE`）与 `seed.ts` 的 `readonly` 定义 —— 属 migration `0043` 议题。
3. 未跟踪的 `migrations/0042`、`0046`、`.workbuddy*/memory/*` 与本 spec 无关。

### (c) 看似实现、实则有误 —— **真违规**

**super_admin 不是「整树选中」。** Spec「**M6** → A. **整树选中且只读**」（C2 同）。`RbacApp` 只把 `isWildcardRole` 用于 `disabled`；`grantedCodes` 取 `role.permissions`，而 super_admin 的权限是 `[RBAC_WILDCARD]`（`"*"`），树又在 `Rbac.ts` 显式剔除 `*` ⇒ 每个复选框都算未勾选。super_admin 看到的是**空的、禁用的树**：只读达成，「整树选中」未达成。全仓无把通配符映射为「全部已选」的逻辑。

### 核对通过

菜单分组→页面→权限码（`buildPermissionTree`）、多对多表 `0052`（34 码全映射，`*` 除外）、未映射码落入「其他权限」且有测试守住、legacy admin 不在 `ext_roles` 故不入树、readonly 如实勾选、显式叶子不自动授权、分组默认展开、组链接首个子项 + 组内子侧栏（`menu.ts`、`AdminShell.astro`）均已实现。

---

## 已按复核修复

### Spec 轴

1. **（c）super_admin 整树选中** —— `isWildcardRole` 时把 granted 视作树里全部叶子码；整树仍 disabled（只读不变）。`RbacApp/index.tsx`。
2. **（a）M11 补测试** ——
   - 新增 `tests/unit/components/rbac-permission-tree.test.ts`（4 例）：渲染菜单分组/页面/码；
     `*` 不可勾；只勾角色实际持有的码；**super_admin 4 个 checkbox 全勾且 disabled**（顺带钉住上面第 1 条修复）。
   - 共享层新增 1 例：「分支勾选只产生真实权限码，绝不产生分组/页面码或 `*`」（保存只含叶子的语义）。

### Standards 轴

3. **Duplicated Code** —— `menuGroupLabelKey` / `menuItemLabelKey` / `menuEntryLabelKey` 移入 `src/shared/AdminNavigation.ts`，
   `AdminMenuItemLink`、`AdminGroupSidebar`、`RbacApp` 三处共用。

### 未以代码修复（属提交/分支纪律）

- **Standards 1、2 与 Spec (b) 指向同一件事**：工作树里混着并发会话的 `0042/0043/0046`、`seed.ts`、`UsersApp`、
  角色 code 改名链，以及 `AGENTS.md` 重排和记忆目录。**不是缺陷，是提交范围问题** —— 提交时只 stage 本次任务路径
  （菜单分组 + 权限树 + `CONTEXT.md` + ADR + 相关迁移与测试），其余留给各自的提交/分支。
- **Standards 3**（`readonly` 复用 `reservedRole` 文案）为既有代码，未在本 spec 范围内，未改动。
- `0052` 注释引用的 ADR **必须随迁移一起提交**，否则注释悬空。

**修复后门禁**：typecheck 0 errors/677；unit 978 passed（+1 skipped）；worker 276 passed；i18n 2001/2001。
未提交、未部署。
