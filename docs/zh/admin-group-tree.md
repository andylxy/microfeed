# AdminGroupTree 使用指南：数据源驱动的分层分组导航

> 适用对象：要在管理后台页面左栏放「分组 → 成员」两层导航，或「分组 → 子分组 → 成员」等更深层级导航的新页面。
> 组件位置：`src/components/admin/shared/AdminGroupTree.tsx`（与 `AdminSelect` / `AdminDialog` 同层）。
> 术语依据：`docs/zh/07-frontend-and-styles.md` 附录的「分组树 / AdminGroupTree」条目——总览根行不参与过滤，分组徽章由页面给定；分组怎么划、成员怎么过滤由页面自己决定，控件只统一展开与选中的交互。

组件只有一个消费者时的形态就是本文 §1–§8 所有示例的出处：用户管理页 `src/components/admin/rbac/UsersApp/index.tsx`（注册来源分组 → 账号）。§9 是三层树的实际消费者 `BookChapterApp`（书籍分类 → 书名 → 卷章，ADR-0063）。本文不引入任何假设场景，所有代码均摘自页面的实际提交。

**默认仍是两层**：分组不传 `subgroups` 时行为与扩展前逐字节一致（用户页、书本信息页、名词页、用户管理页均无需改动）。只有显式传 `subgroups` 的分支才下钻一层。

**原两层方案完整保留**：`AdminTreeNavLayout` 的 `nav` / `children` 两槽契约没有改动，`BookInfoApp` / `MingCiApp` / `ZhongYaoApp` / `UsersApp` 仍按 §1–§8 的方式传构造好的 `AdminTreeGroup[]`（不传 `subgroups`）。三层树是**追加的分支**，不是替换既有方案：完整接入示例见本文 §10，布局壳一侧的传法见 `docs/zh/admin-tree-nav-layout.md` §11。

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
 * 分组树分组：`count` 是徽章显示的数，`leaves` 由调用方按自己的
 * 过滤口径给（如搜索命中行）——两者可以不同，组件不做任何过滤。
 */
export interface AdminTreeGroup {
  key: string;
  label: string;
  count: number;
  leaves: AdminTreeLeaf[];
  /** 可选子分组：传了则该节点展开后渲染子分组而非叶子，可继续嵌套。
   *  不传 = 两层（分组 → 叶子）；传了 = 三层或更深。 */
  subgroups?: AdminTreeGroup[];
  /** 该节点展开后没有成员时的提示；不传则回落 props.emptyLeafText。 */
  emptyText?: string;
}

interface AdminGroupTreeProps {
  /** 数据源：分组、计数与成员过滤全部由调用方算好传入。 */
  groups: AdminTreeGroup[];
  /** 展开的分组键集合。手风琴单展开由调用方只传一个键表达；搜索态可传多个。
   *  多层树把各层的键放同一个数组，故整棵树内键必须唯一（调用方加前缀隔离）。 */
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
   * 多层树会递归下钻到子分组再判定，不会因顶层 `leaves` 为空而误判。
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

| Prop / 字段 | 触发条件 | 渲染位置 | 用户页的用途 |
|---|---|---|---|
| `emptyLeafText` | 某个**已展开**分组的 `leaves` 为空，且该节点没有自己的 `emptyText` | 该分组列表内的一行小字 | `rbac.userGroupEmpty`（这个分组还没有账号） |
| `AdminTreeGroup.emptyText` | 同上，但按节点覆盖；多层树各层语义不同时用 | 该节点列表内的一行小字 | 三层树里分类层用「这个分类下还没有书本」 |
| `emptyTreeText` | 该 prop **已传** 且 **整棵树递归后**无任何可见叶子 | 整棵列表被替换成一个提示段 | `rbac.userCategoryNoResults`（搜索无结果） |

`emptyTreeText` 何时传由页面决定——组件不认识「搜索」这个概念。用户页只在 `searchActive` 时传；正常态即使全部分组为空（如零账号的新站）也不传，树照常渲染（收起态看不到任何空态，与迁移前行为一致）。

多层树的空态判定是**递归**的：`hasVisibleLeaves(group)` 遇到 `subgroups` 就下钻到子组，只有走到真正的叶子层才用 `leaves.length` 判定。所以三层树的顶层 `leaves` 可以放心给空数组，不会出现「明明有卷章却显示整树无结果」。

## 7. 新页面接入检查清单

1. **页面持有状态**：`openCategory`（或等价的展开键）与 `selectedId`，用 `useState`（或地址，如卷看板那样的 URL 态）——不要让组件管。
2. **两个成员口径**：有搜索/过滤的页面定义 `xxxUsers`（全量，喂 `count`）与 `xxxVisibleUsers`（可见，喂 `leaves`）；没有过滤就共用一个。
3. **分组清单**：业务分组 + 需要的系统分组（固定追加，如已封禁账号），`key` 在树内唯一。
4. **叶子两栏**：`label` 主行、`description` 可选说明行（小字，超长自动截断；不传或为空则第二行整行留空）；要展示更多内容时先考虑塞进这两栏，不要扩组件契约。
5. **展开规则**：手风琴 = 传单键数组；需要多分组同时展开（如搜索）= 传多键数组；`onToggleGroup` 里自己写「再点已展开 = 全收起」。
6. **点分组是否联动选中**：页面语义（用户页是「换组自动选中该组第一个成员」），写在 `onToggleGroup` 里。
7. **空态文案**：两级空态按 §6 区分，文案走 i18n；多层树给不同层的节点传各自的 `emptyText`。
8. **不往组件里加业务分支**：层级深度靠 `subgroups` 数据表达，不要按页面名做 if。需要别的新形态（第三行叶子、行内按钮、多选……）时，先回到契约层面讨论。

## 8. 文件与提交

- 组件：`src/components/admin/shared/AdminGroupTree.tsx`
- 布局壳（配套，契约未变）：`src/components/admin/shared/AdminTreeNavLayout.tsx`，见 `docs/zh/admin-tree-nav-layout.md`
- 首个消费者（§1–§7 示例出处）：`src/components/admin/rbac/UsersApp/index.tsx`
- 三层树消费者（§9 / §10 示例出处）：`src/components/admin/book-chapter/BookChapterApp.tsx`
- 树原语（未搬动，组件按 import 复用）：`src/components/admin/rbac/PermissionTreeNode.tsx`
- 裁决记录：`docs/novel-cms/adr/0063-book-chapter-three-level-tree.md`
- 引入提交：`848469c refactor(admin): 用户页左栏分组树抽为数据源驱动的 AdminGroupTree`；分层扩展见 `95a7ac9`

## 9. 三层树：书本卷章页（ADR-0063）

`BookChapterApp` 是唯一给分组传 `subgroups` 的消费者。三层数据全部由看板一次返回后在页面侧派生，链路是 `book_chapter.source_book_id → book_info.id → case_division → settings.book_groups.key`：

| 层 | 节点 | 数据来源 | 键 |
|---|---|---|---|
| 总览根行 | `root`「书本卷章」 | `liveChapters.length` | 不参与过滤、不可展开 |
| 第一层 | 书籍分类 | `board.groups`（settings 清单，按 sort） | `cat:<group.key>` |
| 第二层 | 书名 | `board.sourceBooks`，按 `caseDivision` 归入分类 | `book:<book.id>` |
| 第三层 | 卷章叶子 | `board.chapters`，按 `sourceBookId` 归入书 | 卷章 `id`（`selectedLeafId`） |

要点：

- **键前缀隔离**：分类 slug 与 11 位书 id 理论上不撞，但两层键进同一个 `expandedKeys` 数组，仍显式加 `cat:` / `book:` 前缀，避免将来分组键改成数字后撞车。
- **两层手风琴**：页面持有 `expandedCategoryKey` / `expandedBookKey` 两个 state；点分类只切分类并收起上一本书，点书只切书。搜索态不手风琴，直接把所有命中分支的键全传进去。
- **叶子第二行留空**：卷章叶子只给 `label`，构造树时不带序号、不传 `description`。`AdminTreeLeaf.description` 是可选字段，组件按 `!!description` 决定第二行是否渲染；序号与源分节号仍能在右栏详情看到。
- **徽章同口径**：三层徽章都数「该节点下可见卷章数」，与 root 的 445 一致；搜索态跟随命中数。分类节点的 `count` 是它所有 `subgroups.count` 之和。
- **空态分层**：分类节点给 `emptyText`（「这个分类下还没有书本」），书节点不传、回落 `emptyLeafText`（「这本书下还没有卷章」）。非搜索态保留全部分类与全部书——12 本里 2 本没有卷章，展开该节点就能看到空态，而不是整节点消失。
- **搜索覆盖三层**：命中判定看卷章标题 / 序号 / 分节号，也看书名与分类名；命中书名或分类名时该分支的卷章整批可见，`searchPlaceholder` 与口径一致（「搜索分类、书名、卷章…」）。
- **兜底桶分两种**：书没命中任何 settings 分类时保留原名，挂在合成分类「未分类」下；卷章没命中来源书（`sourceBookId` 为空，或指向已软删/不存在的书）时归入「未归属书本」节点。悬空引用必须并入后者，否则该卷章没有书节点可挂、被静默丢弃，root 数就会大于各级徽章之和。生产数据实测 0 条，只为宽松引用留后路。
- **两层页面零改动**：`BookInfoApp` / `MingCiApp` / `UsersApp` 都不传 `subgroups`，走组件的叶子分支，渲染结果与扩展前一致。

## 10. 完整接入示例：构造好的参数 → AdminTreeNavLayout

本节回答一个具体问题：**三层树要传给 `AdminTreeNavLayout` 什么？** 答案是——和两层页完全一样，只传
`nav` / `children` 两个内容槽；递归 `subgroups` 发生在 `AdminGroupTree` 里，布局壳不认识「树」「层」
「分组」任何概念。页面唯一的新增工作是**把 `treeGroups` 构造成带 `subgroups` 的形状**。

> 本节代码块为便于阅读的**节选**，省略处以注释标出并给出源码行号，完整实现见
> `src/components/admin/book-chapter/BookChapterApp.tsx:426-506、509-519、598-605、844-941`。

### 10.1 职责边界（三层时也不变）

| 谁 | 做什么 |
|---|---|
| 页面 | 从看板派生 `AdminTreeGroup[]`（含 `subgroups`）；持有 `expandedKeys` / `selectedLeafId`；组装左栏整块 JSX |
| `AdminGroupTree` | 递归 `subgroups`：遇到该字段就下钻渲染子分组，否则渲染 `leaves`；只渲染传入状态并回调 |
| `AdminTreeNavLayout` | 把 `nav` 摆进左栏 sticky 卡片、把 `children` 摆进右栏；不拦截、不加工、不缓存 |

**「递归」发生在参数被消费的那一层，不在布局壳**。同一个 `nav` 槽既能装两层树也能装三层树，
这正是原两层方案无需改动的原因。

### 10.2 第 1 步：构造带 `subgroups` 的参数

看板一次返回三份只读数据：`board.groups`（`settings.book_groups` 清单）、`board.sourceBooks`
（含 `caseDivision`）、`board.chapters`（含 `sourceBookId`）。派生三步：

```tsx
const treeGroups = useMemo<AdminTreeGroup[]>(() => {
  // ① 卷按来源书分桶：悬空来源并入「未归属书本」，否则树里没有书节点可挂
  const knownBookIds = new Set(sourceBooks.map((book) => book.id));
  const chaptersByBook = new Map<string, BookChapterAdmin[]>();
  for (const chapter of liveChapters) {
    const bookKey =
      chapter.sourceBookId && knownBookIds.has(chapter.sourceBookId)
        ? chapter.sourceBookId
        : NO_BOOK_KEY;
    const bucket = chaptersByBook.get(bookKey);
    if (bucket) bucket.push(chapter);
    else chaptersByBook.set(bookKey, [chapter]);
  }

  // ② 书按 caseDivision 归分类（「未分类」兜底桶的追加见源码 :446-453）
  const knownGroupKeys = new Set(board.groups.map((group) => group.key));
  const booksByCategory = new Map<string, BookChapterSourceBook[]>();
  for (const book of sourceBooks) {
    const categoryKey = knownGroupKeys.has(book.caseDivision)
      ? book.caseDivision
      : UNCATEGORIZED_KEY;
    const bucket = booksByCategory.get(categoryKey);
    if (bucket) bucket.push(book);
    else booksByCategory.set(categoryKey, [book]);
  }

  // ③ 三层：分类（subgroups）→ 书 → 卷（leaves）
  return board.groups.map((category) => {
    const books = booksByCategory.get(category.key) ?? [];
    const subgroups: AdminTreeGroup[] = books.map((book) => {
      const chapters = chaptersByBook.get(book.id) ?? [];
      const visible = searchActive
        ? chapters.filter((chapter) =>
            (chapter.chapterHeader || "").toLowerCase().includes(searchQuery)
            || String(chapter.chapterNo).includes(searchQuery)
            || book.bookName.toLowerCase().includes(searchQuery)
            || category.label.toLowerCase().includes(searchQuery))
        : chapters;
      return {
        count: visible.length,
        key: `${BOOK_KEY_PREFIX}${book.id}`,
        label: book.bookName,
        // 第二行留空：树只导航卷章标题，序号与源分节号在右栏详情看
        leaves: visible.map((chapter) => ({
          id: chapter.id,
          label: chapter.chapterHeader || t("bookChapter.untitled"),
        })),
      };
    }).filter((book) => !searchActive || book.leaves.length > 0);
    return {
      count: subgroups.reduce((total, book) => total + book.count, 0),
      emptyText: t("bookChapter.categoryEmpty"),   // 分类层专属空态
      key: `${CATEGORY_KEY_PREFIX}${category.key}`,
      label: category.label,
      leaves: [],                                   // 有 subgroups 时这一层不读
      subgroups,                                    // ← 递归入口
    };
  }).filter((category) => !searchActive || (category.subgroups ?? []).length > 0);
}, [board.groups, liveChapters, sourceBooks, searchActive, searchQuery, t]);
```

> `leaves: []` **不是**「空分组」：组件见到 `subgroups` 就走子分组分支，`leaves` 该层根本不读；
> 整树空态判定 `hasVisibleLeaves` 也递归下钻，不会因顶层 `leaves` 为空误判（见 §6）。

### 10.3 第 2 步：展开键与分层手风琴

各层键进同一个 `expandedKeys` 数组，靠前缀分流：

```tsx
const expandedKeys = useMemo(
  () => searchActive
    ? treeGroups.flatMap((category) => [
        category.key,
        ...(category.subgroups ?? []).map((book) => book.key),
      ])
    : [expandedCategoryKey, expandedBookKey].filter(
        (key): key is string => key !== null,
      ),
  [searchActive, treeGroups, expandedCategoryKey, expandedBookKey],
);

const toggleGroup = (key: string) => {
  if (key.startsWith(CATEGORY_KEY_PREFIX)) {
    setExpandedCategoryKey((current) => current === key ? null : key);
    setExpandedBookKey(null);        // 换分类时收起上一本书
    return;
  }
  setExpandedBookKey((current) => current === key ? null : key);
};
```

### 10.4 第 3 步：把构造好的参数传进 `AdminTreeNavLayout`

**唯一与布局壳打交道的调用点**，写法与两层页同构（`nav` 槽里除了树还有搜索框、按钮、软删区）。搜索框用共享的 `AdminTreeSearchInput`（自带清空按钮，过滤逻辑仍留在页面），具名导入 `import {AdminTreeSearchInput} from "@/components/admin/shared/AdminTreeSearchInput";`：

```tsx
<AdminTreeNavLayout
  nav={
    <>
      <div className="p-1">
        <AdminTreeSearchInput
          ariaLabel={t("bookChapter.searchAria")}
          onValueChange={setTreeSearch}
          placeholder={t("bookChapter.searchPlaceholder")}
          value={treeSearch}
        />
      </div>
      <div className="flex items-center justify-end gap-2 px-1 pb-2">
        <Button onClick={startCreate} size="sm" type="button">
          {t("bookChapter.createChapter")}
        </Button>
      </div>
      <AdminGroupTree
        emptyLeafText={t("bookChapter.groupEmpty")}
        emptyTreeText={searchActive ? t("bookChapter.searchNoResults") : undefined}
        expandedKeys={expandedKeys}
        groups={treeGroups}          {/* ← 构造好的参数，含 subgroups */}
        onSelectLeaf={selectLeaf}
        onToggleGroup={toggleGroup}
        root={{label: t("bookChapter.treeRoot"), count: liveChapters.length}}
        selectedLeafId={selectedId}
      />
      {/* 软删折叠区等其它左栏内容，见源码 :880-938 */}
    </>
  }
>
  {/* 右栏：详情 / 表单 / 空态，写法与两层页完全一致 */}
</AdminTreeNavLayout>
```

### 10.5 接入检查清单（三层增量）

在 §7 七条之外增量补四条：

1. **只在需要下钻的节点传 `subgroups`**，并同时留 `leaves: []`；不要给同一节点既传 `subgroups`
   又指望渲染 `leaves`。
2. **整树内键唯一**：各层键进同一个数组，用 `cat:` / `book:` 前缀隔离，避免分类 slug 与 11 位书 id
   撞车。
3. **`count` 自下而上求和**：分类节点 `count = Σ subgroups.count`，与 `root.count` 同口径；悬空引用
   必须并入兜底桶，否则徽章之和会小于 root。
4. **各层空态分别给**：分类层用节点 `emptyText`，书层回落 props `emptyLeafText`；不要一个文案套所有层。

> 布局壳侧「原两层方案为何不用改、`nav` 槽如何同时容纳两种树」见
> `docs/zh/admin-tree-nav-layout.md` §11。
