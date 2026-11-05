# ADR-0063: 「书本卷章」左栏三层分组树（分类 → 书名 → 卷）

- 状态：Accepted（2026-11-04 定稿并实施）
- 日期：2026-11-04
- 关联：ADR-0062（独立「书本卷章」模块）、ADR-0059（「书本信息」分组树，`settings.book_groups` 的 SSOT）、ADR-0058（独立「书本信息」模块）、`docs/zh/admin-group-tree.md`（AdminGroupTree 组件契约）

## 背景

ADR-0062 实施后的 `/admin/book-chapter/` 左栏是**两层树**：`root`「书本卷章」→ 按 `source_book_id` 分组的书名 → 卷章叶子。书多且跨分类时，用户在左栏只看到一串平铺书名，无法按「伤寒金匮 / 内经 / 本草」这类学科分类收拢浏览。

用户要求把左栏改成三层：**第一层分类、第二层书名、第三层卷章**。

数据链路的实测取证（本地 D1 只读探针，2026-11-04）：

| 层 | 数据源 | 量 | 关联完整性 |
| --- | --- | --- | --- |
| 分类 | `settings.book_groups` | 3 组（伤寒金匮 / 内经 / 本草） | — |
| 书名 | `book_info.case_division` → 分组 key | 12 本（5 / 3 / 4） | 全部命中清单 |
| 卷章 | `book_chapter.source_book_id` → `book_info.id` | 445 行，10 本有卷 | **445/445 非空、0 悬空** |

即 `book_chapter.source_book_id → book_info.id → book_info.case_division → book_groups.key` 是一条 100% 贯通的既有链路。三层导航不需要新表、新列、新迁移、新端点，只需把 `board` 载荷补上「分类清单 + 每本书的 `caseDivision`」。

核心张力：`AdminGroupTree` 的既有契约是**严格两层**（分组 → 叶子），且被 4 个页面共用（用户管理 / 书本信息 / 名词 / 书本卷章）。ADR-0059 决策 26 行明确写过「不改 `AdminGroupTree` 约定：两层足够」。

## 决策

1. **分类数据源复用 `settings.book_groups`，不另立一套**。卷章页只读 `settings.book_groups`（经 `@/server/book-info/groups` 的 `loadBookGroups` 入口）与 `book_info.case_division`；分类的增删改名仍归「书本信息」页，卷章页不重复 CRUD、不复制 settings 解析逻辑、不加新权限码。这保住 SSOT：同一批书在两页看到的是同一个分类清单。
2. **`BookChapterBoard` 载荷扩两个只读字段**：`groups: BookInfoGroup[]`（直接 import `@/shared/BookInfo` 的真源类型，不重写接口、不另起名）与 `BookChapterSourceBook.caseDivision: string`。`loadBookChapterSourceBooks` 的 SQL 加查既有列 `case_division`；`listBookChapterBoardHandler` 用 `Promise.all` 并列取「分类 / 来源书 / 卷章目录」三份，端点签名与 URL 不变。
3. **三层树在页面侧派生，不落任何持久状态**。`treeGroups` 按「分类 → 书 → 卷」组装：书按 `caseDivision` 归分类，卷按 `sourceBookId` 归书。徽章统一数「该节点下可见卷章数」（与 `root` 的 445 同口径），分类节点 `count` 是其所有子书 `count` 之和；搜索态跟随命中数。
4. **向后兼容扩展 `AdminGroupTree`**（用户裁决）：`AdminTreeGroup` 增两个可选字段 `subgroups?: AdminTreeGroup[]` 与 `emptyText?: string`。**不传 `subgroups` 的节点走原叶子分支，渲染结果与扩展前逐字节一致**——用户管理 / 书本信息 / 名词三页零改动。传了 `subgroups` 的节点展开后递归渲染子分组，可继续嵌套出任意深度，组件本身不认识「分类」「书」「卷」任何业务概念。
5. **`expandedKeys` 单层数组容纳所有层的键**，靠键前缀隔离：分类 `cat:<key>`、书 `book:<id>`。页面持有 `expandedCategoryKey` / `expandedBookKey` 两个 state 做两级手风琴：点分类只切分类并收起上一本书，点书只切书；搜索态不手风琴，把所有命中分支的键全传入强制展开。
6. **空态分层 + 全显示**（用户裁决）：非搜索态保留全部分类与全部书，包括 12 本里 2 本没有卷章的书、以及理论上可能出现的空分类；展开后分类节点用自己的 `emptyText`（「这个分类下还没有书本」），书节点回落 `emptyLeafText`（「这本书下还没有卷章」）。搜索态丢弃零命中分支并全展开，整树无命中时回落 `emptyTreeText`。
7. **`emptyTreeText` 判定改为递归 `hasVisibleLeaves`**：遇到 `subgroups` 就下钻，只有到真正叶子层才用 `leaves.length` 判定。否则三层树的顶层 `leaves` 恒为空数组，会被误判成「整树无结果」。
8. **兜底桶分两种，落点不同**：书没命中任何 settings 分类时**保留原名**，挂在合成分类「未分类」下——并成一个「未归属书本」节点会让用户看不出原本是哪本书；卷章没命中来源书时（`sourceBookId` 为空，或指向已软删/不存在的书）才归入「未归属书本」书节点。悬空引用必须并入后者：否则该卷章在树上没有书节点可挂，会被静默丢弃，`root` 的 `liveChapters.length` 随之大于各级徽章之和。生产数据实测 0 条，此桶只为 ADR-0062 决策 5「无来源书硬外键」的宽松引用留后路，不新增任何列。
9. **新建卷章的来源书预填改从展开的书节点取**：`startCreate` 用 `expandedBookKey` 去掉 `book:` 前缀预填 `sourceBookId`；未展开书或落在「未归属书本」桶时不预填（「未分类」下的书是真实 `book_info.id`，照常预填）。
10. **搜索口径覆盖三层**：命中判定看卷章标题、序号、分节号，也看书名与分类名；命中书名或分类名时该分支卷章整批可见（用户搜「伤寒」期望看到整个分类，而不是零散几卷）。`searchPlaceholder` 同步写成「搜索分类、书名、卷章…」，提示不能与实际口径不一致。
11. **示例与文档只走追加，不改组件**：`docs/zh/admin-group-tree.md` 新增 §10 作为「构造好的参数 → `AdminGroupTree` → `AdminTreeNavLayout`」的唯一完整可复制示例；`docs/zh/admin-tree-nav-layout.md` 新增 §11 只说明布局壳边界与「原两层方案保留」，并回指 §10；07 册附录指针同步。`subgroups` 语义定义仍只有一处真源，两文不重复。

## 范围之外

- **不改 `settings.book_groups` / `book_info` / `book_chapter` 任何表结构与迁移**；不改 `book_info.case_division` 的写入路径。
- **不在卷章页做分类 CRUD**：分组管理弹层、「末组不可删」、改派书等仍是 ADR-0059 的书本信息页职责。
- **不改端点注册 / 权限码 / 页面守卫**：看板仍是同一个 `ajax/book-chapter` GET，读走 `content:book-chapter:read`。
- **不把 `AdminGroupTree` 改成按页面名分支**，也不引入新的树组件副本。
- 不动 `docs/zh/` 分册正文的既有交互规范，只更新组件指南附录与 07 册指针措辞。

## 后果

- `AdminGroupTree` 从「严格两层」升级为「默认两层、可逐节点下钻」。ADR-0059 决策 26 行「两层足够」的结论**在本 ADR 被推翻**，但推翻方式是向后兼容的可选字段，既有 4 个消费者无需回归改动。
- **ADR-0062 决策 1「与 `book_info` 互不读写」的边界本 ADR 明确收窄为「互不写、互不迁移」**：卷章 handler 本就从 `book_info` 读来源书下拉（ADR-0062 决策 5/9 的 `source_book_id → book_info.id` 逻辑引用），本 ADR 只在同一条既有读取上多取一列 `case_division`，并新增一次 `settings.book_groups` 的只读点查，且直接 import `@/server/book-info/groups` 的 `loadBookGroups` 以复用唯一解析入口（不在卷章模块重写 settings 解析，避免第二个真源）。**仍未写入 `book_info` / `settings` 任何一行**，两表的数据所有权不变。
- 副作用：`loadBookGroups` 的 fail-closed 口径（settings 行形状非法时抛 `invalid_book_groups`）现在也会让卷章看板报错。这是刻意的——与书本信息页对同一份分类配置的好坏判定保持一致，不在卷章侧静默吞成空清单。
- 卷章看板从「读 `book_info` 一列」变成「读 `book_info` 一列 + 读 `settings` 一行 + 读 `book_chapter` 整表」；三者 `Promise.all` 并行，`settings` 是主键点查、`book_info` 是 `deleted_at IS NULL` 小表扫描，均不引入大表全扫。
- 左栏从 10 个书分组变成 3 个分类分组，第一层节点数下降；第二层 12 本书里 2 本无卷章仍占位，展开给空态提示，用户能直接看出哪本书还没录卷章。
- 分类清单若被清空或写入坏 JSON，`loadBookGroups` 的既有 fail-closed 口径不变：缺行回落空清单（所有书归「未分类」），坏形状抛错。卷章页因此与书本信息页对分类配置的好坏判定保持一致。
- 组件契约文档 `docs/zh/admin-group-tree.md` 从「两层指南」扩为「分层指南」，新增 §9 三层实例与 §10 完整接入示例；`docs/zh/admin-tree-nav-layout.md` 新增 §11 只讲布局壳边界并回指 §10。**`subgroups` 的语义定义仍只在前一份文档一处**，两文互为指针、不重复真源。
- **UI 细节不改变本 ADR 的契约结论**：卷章叶子第二行留空（只给 `label`）、正文编辑/新建改走项目现成的 `AdminDialog` 弹层、左栏搜索框抽成独立共享组件 `AdminTreeSearchInput`（带清空）。弹层尺寸经 `AdminDialog` 新增的可选 `contentClassName` 按视口自适应（宽度 `min(90vw,48rem)`、`100dvh` 高度上限），**不传的 12 个既有弹层尺寸逐字不变**；正文与注释文本框复用项目现成的 `AdminTextarea`（`field-sizing: content` + `minRows`/`maxRows`），按 8066 行实测分布给正文 2/12 行、注释 2/18 行档位，替换原来写死的 14/6 行。三者都落在组件指南 `docs/zh/admin-group-tree.md` / `admin-tree-nav-layout.md`，`AdminTreeNavLayout` 与 `AdminGroupTree` 的受控契约未变。
- **`AdminTreeNavLayout` 的 `nav` / `children` 两槽契约与两层页面原方案原封保留**：本 ADR 没有给布局壳加任何 prop，也没有让它参与递归。`BookInfoApp` / `MingCiApp` / `ZhongYaoApp` 仍按两层写法，`UsersApp` 用树但不用布局壳也不受影响。三层页传给布局壳的仍是 `ReactNode`；「构造好的参数」指 `AdminTreeGroup[]` 及配套受控状态，经 `AdminGroupTree` 的 props 消费。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 卷章模块另建一套 `book_chapter_groups` settings 清单 | 同一批书要在两处归组，违背 SSOT；且分类的语义本就是「书籍分类」，与卷章无关 |
| 把分类做成第二套端点 / 权限码 / 管理弹层 | 卷章页只读导航，不需要分类写权限；重复端点面与 `content:book-chapter:*` 的授权边界 |
| 在 `BookChapterApp` 内自建三层树，不动共享组件 | 复制一份树渲染逻辑与视觉原语，将来别的模块要三层还得再复制一遍；用户裁决走兼容扩展 |
| 新建 `AdminNestedGroupTree` 与旧组件并存 | 两套组件分别维护 `TreeBadge` / `TREE_ROW_*` / 空态语义，样式迟早漂开 |
| 把 `case_division` 冗余写进 `book_chapter` 新列 | 链路已 100% 贯通，加列只会制造第二个可漂移的真源 |
| 搜索态也保留空分类 / 空书 | 用户裁决：搜索态丢弃零命中分支、只展开命中路径，避免噪声 |
