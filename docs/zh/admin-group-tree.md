# AdminGroupTree 使用指南：数据源驱动的两层分组导航

> 适用对象：要在管理后台页面左栏放「分组 → 成员」两层导航的新页面。
> 组件位置：`src/components/admin/shared/AdminGroupTree.tsx`（与 `AdminSelect` / `AdminDialog` 同层）。
> 术语依据：CONTEXT.md「**分组树**」——总览根行不参与过滤，分组徽章恒显全量数；分组怎么划、成员怎么过滤由页面自己决定，控件只统一展开与选中的交互。

组件只有一个消费者时的形态就是本文所有示例的出处：用户管理页 `src/components/admin/rbac/UsersApp/index.tsx`（注册来源分组 → 账号）。本文不引入任何假设场景，所有代码均摘自该页面的实际提交（`848469c`）。

---

## 1. 设计原则（接入前必读）

| 原则 | 含义 |
|---|---|
| **数据源驱动** | 组件吃一份算好的 `AdminTreeGroup[]`。分组规则、计数口径、搜索过滤、空态判定全部留在页面，组件不认识任何业务概念 |
| **完全受控** | `expandedKeys` / `selectedLeafId` 由页面持有，组件零内部状态，只渲染传入状态并回调 |
| **不重新设计** | 视觉与交互复用权限树的原语（`TreeBadge` / `TREE_ROW_*` / `PermissionBranchToggle`），与既有左栏像素一致；页面语义（手风琴、搜索展开规则）不进组件 |

## 2. Props 契约

```tsx
// src/components/admin/shared/AdminGroupTree.tsx

/** 分组树叶子：固定两栏——主行加可选的说明行。`description` 不传（或空）则第二行留空。 */
export interface AdminTreeLeaf {
  id: string;
  label: string;
  description?: string;
}

/**
 * 分组树分组：`count` 是徽章显示的全量数，`leaves` 由调用方按自己的
 * 过滤口径给（如搜索命中行）——两者可以不同，组件不做任何过滤。
 */
export interface AdminTreeGroup {
  key: string;
  label: string;
  count: number;
  leaves: AdminTreeLeaf[];
}

interface AdminGroupTreeProps {
  /** 数据源：分组、计数与成员过滤全部由调用方算好传入。 */
  groups: AdminTreeGroup[];
  /** 展开的分组键集合。手风琴单展开由调用方只传一个键表达；搜索态可传多个。 */
  expandedKeys: readonly string[];
  selectedLeafId: string | null;
  onToggleGroup: (key: string) => void;
  onSelectLeaf: (id: string) => void;
  /** 不参与过滤的总览根行（如「全部用户」）；不传则不渲染。 */
  root?: {label: string; count: number; icon?: ReactNode};
  /** 分组展开后没有成员时的提示文案；不传则不渲染提示行。 */
  emptyLeafText?: string;
  /**
   * `emptyTreeText` 已传且所有分组都无可见叶子时，整列表替换成的提示文案
   * （如搜索无结果）。文案由调用方决定何时给——组件不认识「搜索」这个概念。
   */
  emptyTreeText?: string;
}
```

导入方式是**具名导入**：

```tsx
import {AdminGroupTree} from "@/components/admin/shared/AdminGroupTree";
```

## 3. 数据整理：从页面数据到 `AdminTreeGroup[]`

以用户页为例。页面原始数据是账号板 `board.users`（`RbacUser[]`，每个含 `id / name / email / banned / signup_source / roles`）和注册来源配置 `signupSources`（`SignupSourceOption[]`）。整理分三步：

**第 1 步：定分组清单**（`UsersApp/index.tsx:88`）。来源分组按配置顺序，系统分组「已封禁账号」固定追加在末尾——它的成员由 `banned` 实时过滤，不进来源配置：

```tsx
const categoryList = [...sourceValues, BANNED_GROUP_VALUE];
```

**第 2 步：定义两个成员口径**（`UsersApp/index.tsx:101-110`）。这是「徽章全量 vs 列表过滤」分离的关键——**徽章数永远用全量口径，列表行用可见口径**：

```tsx
/** 分组 → 成员。`__banned__` 按 `banned` 过滤，来源分组排除已封禁账号。 */
const categoryUsers = (category: string) =>
  board.users.filter((entry) => matchesSignupCategory(entry, category));

// 搜索优先于手风琴：有查询词时每个分类只保留命中的用户，且只有含命中的
// 分类被强制展开，无命中则整类收起（spec §9）。
const categoryVisibleUsers = (category: string) => {
  const users = categoryUsers(category);
  return searchActive ? users.filter((entry) => userMatchesQuery(entry, query)) : users;
};
```

**第 3 步：映射成 `AdminTreeGroup[]`**（`UsersApp/index.tsx:608-619`，即组件的 `groups` prop）。每个账号按固定两行叶子的形状折叠——第一行 `label`（名字，没有则邮箱），第二行 `description`（邮箱 · 角色数；无名字时只有角色数）：

```tsx
groups={categoryList.map((category) => ({
  count: categoryUsers(category).length,          // 徽章：全量口径
  key: category,
  label: categoryLabel(category),
  leaves: categoryVisibleUsers(category).map((entry) => ({   // 列表：可见口径
    description: entry.name
      ? `${entry.email} · ${entry.roles.length}`
      : String(entry.roles.length),
    id: entry.id,
    label: entry.name || entry.email,
  })),
}))}
```

> 注意 `leaves` 与 `count` 的口径差是**故意的**：搜索时徽章仍显示该分组实际有多少账号，列表只列命中的。新页面若没有搜索过滤，两个口径自然相同，直接用同一个数组即可。

## 4. 状态与回调：展开、选中、页面语义

组件只渲染状态；下面这些规则全部长在页面里（`UsersApp/index.tsx:94-128`）：

```tsx
const [openCategory, setOpenCategory] = useState<string | null>(null);
const [search, setSearch] = useState("");

const searchActive = search.trim().length > 0;
const query = search.trim().toLowerCase();

// 点一个分类：收起态则展开，已是展开态则全部收起（spec §2「再点已展开的
// 组头 = 全折叠」）。
const toggleCategory = (category: string) => {
  const next = openCategory === category ? null : category;
  setOpenCategory(next);
  if (next) {
    const first = categoryUsers(next)[0];
    if (first) setSelectedId(first.id);
  }
};

// 全部收起，只留各分类组头在根节点下。
const collapseAll = () => setOpenCategory(null);
```

传入组件时，`expandedKeys` 的三种形态：

```tsx
expandedKeys={
  searchActive
    ? categoryList.filter((category) => categoryVisibleUsers(category).length > 0)
    : openCategory
      ? [openCategory]     // 手风琴单展开 = 只传一个键
      : []                 // 全部收起
}
```

- **正常态**：数组里只有 `openCategory` 一个键 → 手风琴单展开；
- **搜索态**：所有有命中的分组都强制展开 → 数组里多个键（这就是契约是数组而非单键的原因）；
- **全收起**：空数组。

选中态直接透传页面的 `selectedId`；`onSelectLeaf` 直接给 `setSelectedId`；`onToggleGroup` 直接给 `toggleCategory`。

## 5. 完整调用示例

页面左栏的整体结构（`UsersApp/index.tsx:598-630`，节选）：搜索框、「全部收起 / 新建分组」按钮、组件调用、建号表单，组件只负责中间那棵树：

```tsx
<AdminGroupTree
  emptyLeafText={t("rbac.userGroupEmpty")}
  emptyTreeText={searchActive ? t("rbac.userCategoryNoResults") : undefined}
  expandedKeys={
    searchActive
      ? categoryList.filter((category) => categoryVisibleUsers(category).length > 0)
      : openCategory
        ? [openCategory]
        : []
  }
  groups={categoryList.map((category) => ({
    count: categoryUsers(category).length,
    key: category,
    label: categoryLabel(category),
    leaves: categoryVisibleUsers(category).map((entry) => ({
      description: entry.name
        ? `${entry.email} · ${entry.roles.length}`
        : String(entry.roles.length),
      id: entry.id,
      label: entry.name || entry.email,
    })),
  }))}
  onSelectLeaf={setSelectedId}
  onToggleGroup={toggleCategory}
  root={{
    count: board.users.length,
    icon: (
      <UsersIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    ),
    label: t("rbac.userCategoryAll"),
  }}
  selectedLeafId={selectedId}
/>
```

要点：

- **根行是可选的总览行**，不算分组、不参与过滤、永远可见（包括整树空态时）；图标由页面传（lucide 图标 + 固定类名），不传 `root` 就没有这一行。
- **i18n 留在页面**：组件只收字符串，`emptyLeafText` / `emptyTreeText` / `root.label` / 分组 `label` 全部由页面用 `t(...)` 给。

## 6. 两个空态的区别

| Prop | 触发条件 | 渲染位置 | 用户页的用途 |
|---|---|---|---|
| `emptyLeafText` | 某个**已展开**分组的 `leaves` 为空 | 该分组列表内的一行小字 | `rbac.userGroupEmpty`（这个分组还没有账号） |
| `emptyTreeText` | 该 prop **已传** 且 **所有分组** `leaves` 全空 | 整棵列表被替换成一个提示段 | `rbac.userCategoryNoResults`（搜索无结果） |

`emptyTreeText` 何时传由页面决定——组件不认识「搜索」这个概念。用户页只在 `searchActive` 时传；正常态即使全部分组为空（如零账号的新站）也不传，树照常渲染（收起态看不到任何空态，与迁移前行为一致）。

## 7. 新页面接入检查清单

1. **页面持有状态**：`openCategory`（或等价的展开键）与 `selectedId`，用 `useState`（或地址，如卷看板那样的 URL 态）——不要让组件管。
2. **两个成员口径**：有搜索/过滤的页面定义 `xxxUsers`（全量，喂 `count`）与 `xxxVisibleUsers`（可见，喂 `leaves`）；没有过滤就共用一个。
3. **分组清单**：业务分组 + 需要的系统分组（固定追加，如已封禁账号），`key` 在树内唯一。
4. **叶子两栏**：`label` 主行、`description` 可选说明行（小字，超长自动截断；不传或为空则第二行整行留空）；要展示更多内容时先考虑塞进这两栏，不要扩组件契约。
5. **展开规则**：手风琴 = 传单键数组；需要多分组同时展开（如搜索）= 传多键数组；`onToggleGroup` 里自己写「再点已展开 = 全收起」。
6. **点分组是否联动选中**：页面语义（用户页是「换组自动选中该组第一个成员」），写在 `onToggleGroup` 里。
7. **空态文案**：两级空态按 §6 区分，文案走 i18n。
8. **不往组件里加业务分支**：需要新形态（第三行叶子、行内按钮、多选……）时，先回到契约层面讨论，不按页面名做 if。

## 8. 文件与提交

- 组件：`src/components/admin/shared/AdminGroupTree.tsx`
- 首个消费者（所有示例出处）：`src/components/admin/rbac/UsersApp/index.tsx`
- 树原语（未搬动，组件按 import 复用）：`src/components/admin/rbac/PermissionTreeNode.tsx`
- 引入提交：`848469c refactor(admin): 用户页左栏分组树抽为数据源驱动的 AdminGroupTree`
