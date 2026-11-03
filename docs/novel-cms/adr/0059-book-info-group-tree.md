# ADR-0059: 「书本信息」分组树（settings 独立分组 + AdminGroupTree 左栏）

- 状态：Proposed（2026-11-03 会话设计，待实施；实施后改 Accepted 并括注）
- 日期：2026-11-03
- 关联：ADR-0058（独立「书本信息」模块）、ADR-0057（后台页面守卫登记表）、`docs/zh/admin-group-tree.md`（AdminGroupTree 组件指南）、`CONTEXT.md`「分组树」词条

## 背景

ADR-0058 实现了独立 `book_info` 模块，但 `BookInfoApp` 是**单栏平铺列表**，书多后缺导航。用户要左栏加 `AdminGroupTree` 分组树。核心张力：`AdminGroupTree` 约定是**严格两层**（分组→叶子），而 `book_info.parent_id` 是自引用层级——形状不匹配。

同时 `book_info` 的归属需要一个分组维度。行内候选（`case_division`/`case_tag`/`is_enable`）都是参考实体自带的分类，但用户要的是**可独立增删改名的分组清单**，且**不依赖任何一方**（既不依赖 channels/items，也不依赖 `ext_category`）。

## 决策

1. **分组清单存 `settings` KV，独立管理**。用现成 `settings` 表（`category` 主键 + `data` JSON）新增一个 `category='book_groups'`，存整个分组清单 JSON（整表覆盖写，与 UsersApp 的 `signup_sources` 同构）。**不新增表、不依赖 `ext_category`/channels/items**。JSON 形状：`{groups:[{key,label,sort}]}`，`key`=稳定 slug（书表 `case_division` 存它）、`label`=显示名、`sort`=树内顺序。
2. **书的归属 = 自己的 `case_division` 值**，按 settings 分组 `key`。不新增列、不新增 ALTER 迁移（`case_division` 本就 `NOT NULL` + 必填）。改名只动 settings 一处（书表存稳定 `key`），无级联。
3. **默认分组 = 老项目 `ext_category` 的一次性冻结快照**。迁移 `0172` 把当下 `ext_category` 三行（伤寒金匮/本草/内经）写成 settings `book_groups` 种子。**运行时不依赖 `ext_category`**——迁移跑完两者各自独立演化，是「解耦后的一次性数据搬迁」，不破 ADR-0058「不依赖 ext_category」红线（对照被否决的「运行时读 ext_category」）。
4. **左栏 `AdminGroupTree`**：顶层总览根行「书籍分类」（= 字段名，badge = 全部存活书数，不参与过滤）；分组=settings 清单（徽章显示该组书数），叶子=该组书（`book_no` 序）；不设「未分组」兜底——`case_division` 必填且须命中 settings 清单，无游离值。手风琴单展开、`onSelectLeaf` 切右栏编辑目标——全部页面侧状态，组件零业务分支（`docs/zh/admin-group-tree.md` §7）。
5. **删分组先改派书**（`case_division` NOT NULL ⇒ 不能悬空）：删有书的分组时弹层选「改派到」目标组（列出除被删组外的其余组），保存=批量 `UPDATE book_info SET case_division=目标 WHERE case_division=被删组` + 整表覆盖写 settings。**无书直接删**。**最后一个分组禁止删除**（无改派目标，报错「至少保留一个分组」）——fail-closed，避免造出无组可归的书。
6. **权限全复用 `content:book:*`，不加新码**（ADR-0058 决策 4 延续）。分组读写走同一 `book_info` 端点面（见后果）。

## 范围之外

- **不改 `channels`/`items`/`ext_book_stats`/`ext_book_status`**。分组是 `book_info` + settings 两方的私事。
- **不把分组做成强外键**：分组是导航/分类语义，删组靠「改派」而非级联或硬外键。
- **不改 `AdminGroupTree` 约定**：两层足够（分组→书）。真需要任意深度父子层级是另一码事，不在本 ADR。
- **`case_division` 校验不强制命中 settings 清单**（宽松，避免空清单时无法建书的引导死锁）；清单只驱动左栏显示与表单下拉建议，游离值按原值回落显示（不落「未分组」）。

## 后果

- 出现「分组清单（settings）+ 书（book_info）」两处数据：分组定义在 settings、书引用其 `key`。SSOT 是 settings（分组名/顺序/增删），书表只存引用键。删除走「改派」而非级联，`case_division` 永不悬空。
- `book_info` 多了一个持久属性语义：`case_division` 从「参考实体自带的分类文本」升级为「指向 settings 分组键的归属标记」。这是**刻意取舍**——换来左栏分组可独立管理且不依赖任何外部表，代价是 `case_division` 的取值域现在由 settings 约束（宽松校验，不强制）。
- 分组读写需要一个 settings 通道：`book_info` 的 GET 看板端点扩展为同时返回 `groups` + `books`（一次取齐，与 ADR-0058 决策 5「一次性返回」口径一致）；分组增删改名改派走同面新增的 groups 子端点，全复用 `content:book:*`。
- 一次性快照意味着**新装的空站点** `ext_category` 为空时，`book_groups` 种子也为空——首组靠「新建分组」弹层创建（宽松校验保证此时仍能建书）。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 左栏按行内字段（`case_division`/`case_tag`/`is_enable`）静态分组 | 用户要的是**可独立增删改名的分组清单**，静态字段分组满足不了「新建分组」诉求 |
| 分组清单存 settings，但运行时读 `ext_category` 当数据源 | 破 ADR-0058「不依赖 ext_category」红线 |
| 加 `group_key` 新列指向 settings 分组 | 多一列 + 多一迁移；`case_division` 本就可当归属键，重复 |
| 组-书映射也存 settings（组→书 id 列表 JSON） | 书表零改动但映射存两处、易与书表漂移，违背 SSOT |
| `parent_id` 自引用层级树 | 与 `AdminGroupTree` 两层约定形状冲突，且需把组件改递归；当前 parent_id 仅手填文本、无真实层级数据 |
