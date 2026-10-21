# ADR-0042: 角色管理页实现 ADR-0041 —— 侧栏预览与三期实施

- 状态：Proposed（方案定案，待排期实现）
- 日期：2026-10-21
- 决策人：用户 + 设计评审（grill-with-docs 三轮问答定案）
- 关联设计：ADR-0041（菜单入口并入权限树）、ADR-0038（权限树自持节点表）、ADR-0039（双控制台单页）；`CONTEXT.md` 术语「入口门码」「权限树宿主」「终端归属」
- 本 ADR 来源：用户要求「参考原形，对 `/admin/rbac/` 角色管理进行优化和修正，先完善方案、先不写代码」，并给出元规则「一切功能以现有真实实现为准，原形只作参考」

## 背景

ADR-0041 已定把 `ext_menu` 并入 `ext_permission_nodes`（页面节点补 `path` + `entry_code`，侧栏改读节点，`/admin/menu/` 只读后退役），但代码尚未实现。

现状（以本地代码为准）：

| 事实 | 位置 |
| --- | --- |
| `/admin/rbac/` 是「角色条 + 2 栏（左 nav `lg:w-96` ｜ 右 `PermissionNodeEditor`）+ 角色弹窗」，没有侧栏预览 | `src/components/admin/rbac/RbacApp/index.tsx:929-1197` |
| 节点编辑器只改 中文名 / 英文名 / 图标 / 父级 / 显隐；没有 `path`、没有 `entry_code` | `src/components/admin/rbac/PermissionNodeEditor.tsx` |
| 全仓 `src` 搜 `entry_code` / `entryCode` 零命中 ⇒ ADR-0041 的 D1/D2 未实现 | 全仓扫描 |
| 侧栏仍由 `ext_menu` 驱动；三级子项由 `SUB_SECTION_BUILDERS` 代码注入、不入库 | `src/server/admin/menu.ts`、`src/components/admin/AdminSidebar.tsx:59-81` |
| 迁移最大编号 `0132`，下一个为 `0133` | `migrations/` |
| 展开的分类行文字加重并变深（`open && "font-semibold"` + `text-foreground`）；搜索时自动展开全部分类（`open = searchActive ｜｜ openCategory === audience`） | `RbacApp/index.tsx:1053/1066/1047` |

原型展示了目标形态（3 栏、`path`/`entry_code`、侧栏预览），但原型与真实页在若干行为上相反。用户明确：以现有真实实现为准，原形只作参考。本 ADR 因此记录：如何把该页分三期推向 ADR-0041 的目标，并新增「侧栏预览」这一只读能力。

## 决策

### D1｜以现有实现为准

凡原形与真实页在行为上不一致，一律取真实页：展开的分类行文字加重并变深、搜索时自动展开全部分类。原形仅在真实页尚缺的能力（`path`/`entry_code` 字段、侧栏预览）上提供形态参考，不覆盖既有交互。

### D2｜三期实施

- **阶段1｜数据与编辑器**：`ext_permission_nodes` 增 `path`、`entry_code`；从 `ext_menu` 回填；`PermissionNodeEditor` 给页面行加这两个字段。本阶段不动侧栏。
- **阶段2｜侧栏预览**：新增只读预览，复刻真实侧栏，按所选角色的 `entry_code` 门控。
- **阶段3｜切换与退役**：`menu.ts` / `AdminSidebar` 改读节点（输出逐项不变），`/admin/menu/` 降为只读一版，随后下线并执行 ADR-0041 D5 清理。

### D3｜数据模型与回填

- 两列 `path TEXT NULL`、`entry_code TEXT NULL`，仅 `kind='page'` 行使用；分组行、码行保持 NULL。
- 回填口径以现有 `ext_menu` 为准：`path ← menu.path`，`entry_code ← menu.permission_code`；25 个配对页面节点逐一比对一致。
- `rbac_audit` 新增页面节点：`entry_code = system:role:manage`、`path = rbac/audit`，与 `page_rbac` 共用门码（两个入口、一张权限页）。
- `media`：`path`、`entry_code` 均空，只挂码、不进侧栏。
- 约束：`entry_code` 非空 ⇒ `path` 非空。
- 迁移编号 `0133`；全新安装仍走老 `ext_menu` 种子，再由本迁移回填（不回写历史迁移）。

### D4｜编辑器字段

仅在页面行显示「路径 path」文本框与「入口门码 entry_code」下拉（选项＝本页自有码 + 「（空）只挂码，不进侧栏」）；分组行、码行不显示。版式沿用真实编辑器 `sm:grid-cols-[96px_minmax(0,1fr)]` 标签行。

### D5｜侧栏预览的保真与位置

- 只渲染 PC 端管理侧栏（App 端无侧栏），恒显示、跟随所选角色；与当前展开的是 PC 还是 App 分类无关。
- 复刻真实侧栏：首页固定、按菜单分组、二级页面、三级注入子项（`SUB_SECTION_BUILDERS`：设置 / API / Webhooks）、图标与顺序；可见性按所选角色的 `entry_code`（含通配 `*`）判定；`entry_code` 空的节点不出现。
- 布局：大屏第 3 栏（nav 384 ｜ 详情 1fr ｜ 预览约 288），小屏堆叠到详情下方，并提供「收起预览」开关。
- 每个阶段预览镜像**当时的真实侧栏**（阶段2 时「菜单管理」仍在，预览也显示；阶段3 退役后一起消失）。

### D6｜阶段3 切换与退役

- `menu.ts` / `AdminSidebar` 改读节点：分组节点 + `entry_code` 非空的页面节点 + 原三级注入子项，渲染输出与改造前逐项一致。
- `SUB_SECTION_BUILDERS` 的 key 从「菜单码」迁到「页面节点码」，渲染结果不变。
- `/admin/menu/` 只读一版后下线；随后执行 ADR-0041 D5：删除 `page_menu_management` 节点与 `system:menu:manage` 码，库 / 种子 / 枚举 / 接口清单四处同步。

## 备选

| 类别 | 备选 | 否决理由 |
| --- | --- | --- |
| 范围 | 只做 UI 预览态，不给节点加 `path` / `entry_code` | 预览无真实数据来源，等于假预览，验证不了门控 |
| 预览保真 | 预览只画分组与二级页，省略三级注入子项 | 与真实侧栏不一致，违背「以现有实现为准」 |
| 行为 | 以原形为准（分类不加重、搜索仅过滤） | 与用户元规则冲突，且真实页交互更顺手 |
| 实施 | 一次性切换侧栏与退役菜单页 | 无过渡验证，风险集中；ADR-0041 要求只读一版再下线 |

## 后果

- 新增迁移 `0133`；`PermissionNodeEditor` 增两字段；新增只读「侧栏预览」组件；`menu.ts` 改造；`/admin/menu/` 退役链。
- 维护成本：预览必须持续镜像侧栏渲染；用同一套 builder / 注册表把不一致空间压到最小。
- 术语已同步：`CONTEXT.md` 的「菜单可见性码」改称「入口门码」（锚点页面节点），「权限树宿主」锚点改页面节点。
- 历史迁移不回写；生产实例需一次合并迁移把 `ext_menu` 行并入节点。
- 本 ADR 只定方案，不写业务代码；实现按三期分票，阶段3 单独一票。

## 验证口径

- 阶段1：迁移后 25 个配对页面的 `path` / `entry_code` 与 `ext_menu` 逐项一致；`rbac_audit` 门码与 `page_rbac` 相同；`media` 两列为空；`entry_code` 非空行 `path` 均非空。
- 阶段2：预览行集（含顺序、显隐、计数、三级注入子项）与真实侧栏逐项一致；`entry_code` 为空的不出现；切换所选角色时计数实时更新。
- 阶段3：切换前后两侧栏行集一致；`page_menu_management`、`system:menu:manage` 在库 / 种子 / 枚举 / 接口清单四处同时消失；桌面端树 78 → 76 行。
