# 14 — 后台内容列表按内容类型筛选

**What to build:** 八千多条条文导入后，后台内容列表必须能按类型筛（全部 / 篇章 / 条文 / 方剂 / 中药 / 名词），否则没法在现有博文管理页里编辑管理。这是整个方案**唯一的后台 UI 改动**，不新开页面。

**Blocked by:** 07（本地数据）

**Status:** done（2026-09-28，worker 测试 5 例 + 单测 4 例 + EXPLAIN 实证）

- [x] 列表支持按内容类型筛选（全部 / 篇章 / 条文 / 方剂 / 中药 / 名词），默认「全部」；筛选行仅在库中存在 TCM 条目时渲染（`hasTcmItems` 探针），纯小说站零视觉变化
- [x] 分页在大数量下不卡：游标分页逻辑未动；kind 过滤 `EXPLAIN` 实证命中 `items_tcm_kind_name` 索引最左前缀（`SEARCH items USING INDEX`，无 SCAN）
- [x] 条文编辑保存后类型不丢失：保存路径 `_putItemToContentStatement()` 只写 8 个已知列（工单前置审计），`tcm_kind`/`tcm_parent_id`/`_microfeed` 口袋不受后台保存影响
- [x] 方剂编辑保存后内嵌组成明细不丢失：同上，`fangYaoList[]` 在 `_microfeed` 口袋里，保存是合并语义（线上小说 `bookId`/`chapterNo` 走同一保存路径长期存活的既有证据）
- [x] 现有小说章节的列表与编辑零回归：items-list / items-category-filter 测试全绿；kind 为 NULL 的行只出现在「全部」视图（worker 测试断言）
- 实现位置：`src/shared/ItemList.ts`（`TCM_KIND_FILTERS` + `normalizeTcmKindFilter` + URL 参数）、`src/server/items/admin-list.ts`（过滤子句 + 回显 + `hasTcmItems`）、`AllItemsApp/index.tsx`（`ItemKindFilters` pill 行，筛选随翻页/排序/状态切换保持）、i18n `items.filterKind*` 七键（en + zh-CN，`i18n:check` 通过）
