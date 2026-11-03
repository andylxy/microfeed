# ADR-0058: 独立「书本信息」模块 `book_info`（参考 vol.api.sqlsugar BookInfo）

- 状态：Proposed（2026-11-03 会话设计，待实施；实施后改 Accepted 并括注）
- 日期：2026-11-03
- 关联：ADR-0057（后台页面守卫登记表）、`CONTEXT.md`（Book = Channel 词条）、`docs/zh/09-new-module.md`（新建模块 10 步）、参考项目 `D:\git\web\Vue.NetCore\vol.api.sqlsugar` 的 `SimpleEasy.Entity/DomainModels/ZhongYi/BookInfo.cs`

## 背景

后台已有一套「书」概念，但它是**混合进其他模块**的：书 = `channels` 行（`data` JSON 存 `title`/`authors`/`image`/`description`/`_microfeed`，含 `bookId`/`serialStatus`/`signStatus`/`genre`/`bookNo`），章节 = `items` 行（`book_id` 挂书、`tcm_kind`/`tcm_parent_id`/`source_book_id`/`book_kind` 层层叠加），字数/章节数走 `ext_book_stats` 物化，状态走 `ext_book_status` 字典，分类走 `ext_category` + `channels.genre` 镜像列。`listAdminBooks` 直接 `SELECT … FROM channels`，**每个 channel 都被当书**（含站点主 feed `is_primary`），TCM 古籍书也走同一张 `channels`（`data._microfeed.bookNo` 存书本编号）。

用户要的是**独立、干净的书本信息模型**，参考 vol.api.sqlsugar 的 `BookInfo` 实体（`BookName`/`Author`/`Chapter`/`ChengShu`/`Case`/`CaseTag`/`BookNo`/`ImageUrl`/`HotBook`/`ParentId`/`Comment`/`OrgId`/`IsEnable`），**不考虑项目现有的 `channels`/`items` 纠缠**——即在既有书机制之外，另立一张自持的 `book_info` 表，作为参考模型的书本信息镜像，不与 channels/items 复用或迁移数据。

## 决策

1. **新建独立表 `book_info`**，完整镜像参考 `BookInfo` 领域字段（去框架专属 `OrgId` 语义绑定，保留列位；`IsEnable` 保留）。按 microfeed 建表惯例：`VARCHAR(11)` 主键（非参考的 int 自增）、`created_at`/`updated_at`、预留 `ext1`~`ext10`、软删除 `deleted_at`。业务约束走 `CREATE TRIGGER` + `RAISE(ABORT, 'code')`。
2. **不与 `channels`/`items` 耦合**：不迁移既有数据、不改 `items.book_id` 指向、不废弃 `channels` 书机制。两张书模型**并行共存**：`channels`-书（既有内容链路）与 `book_info`（参考模型镜像）各管各的，互不读写。
3. **全栈模块**：按 `docs/zh/09-new-module.md` §2 十步落位——迁移 + `src/server/book-info/` + `src/shared/ApiSchemas.ts`(Zod) + `src/shared/OpenApiDocument.ts`(OpenAPI) + `src/components/admin/book-info/` + `src/pages/[adminPath]/book-info/` + `src/shared/AdminPageGuards.ts` 登记 + `docs/book-info/` + 契约/运行时测试（**只写不跑**）。
4. **复用权限码，不加新码**：页面守卫复用既有 `PERMISSION_CODES.CONTENT_BOOK_READ`（`books` 页同码），在 `AdminPageGuards.ts` 登记 `"book-info"` 路由 → 该码；侧栏节点行（`ext_permission_nodes` `kind='page'`）随迁移播种，`entry_code` 同用 `content:book:read`。
5. **后台 CRUD 面**：管理员 ajax 端点（`[adminPath]/ajax/book-info/`），读走 `loadBookInfoBoard`（一次性返回书列表，含已软删行 + `isDeleted` 派生，供两步删除），写走 create/update/delete（软删）/purge（物删，仅已软删行）。**看板只回书列表，不回状态/分类选项**（→ 此句已被回填：ADR-0059 给分组、迁移 0173/0174 给状态各加了 settings 清单，看板现回 `{groups,statuses,books}`；但二者仍读 `settings` 而非 `ext_category`/`ext_book_status`，本决策「不读 ext_*」的解耦不变式不变）——`book_info` 的启用态（`is_enable`）与划分/标签（`case_division`/`case_tag`）都是行内列，本模块刻意不读 `ext_book_status`/`ext_category`（决策 2 解耦），故无需外部选项清单。不新增公共 `api/v1` CRUD——`book_info` 是后台管理的元数据镜像，无公开读需求；若日后需要公开只读，再按 OpenAPI 契约补。

## 范围之外

- **不改 `channels`/`items`/`ext_book_stats`/`ext_book_status`/`ext_category` 任何字段或语义**。`book_info` 是完全独立的新表，不动既有内容链路。
- **不迁移既有 channels-书数据**：既有书（含 TCM 古籍、主 feed）继续走 `channels`。`book_info` 从空表开始，供新录入/后续按需回填。
- **不实现 `BookChapter`/`BookChapterBody`**：用户仅要求 `BookInfo` 模型；章节/正文仍属 `channels`/`items` 既有链路，不在本模块。
- **不为 `OrgId` 建组织模块**：microfeed 无组织概念，`org_id` 仅作列位保留（可空），不做外键。
- **不写 `docs/` 散文断言测试**；文档校验走 `yarn docs:check`（执行时机归 AGENTS.md「最高指令」）。

## 后果

- 出现**第二套书模型**：`book_info`（参考镜像，自持）与 `channels`-书（既有内容链路）并存。这是**刻意取舍**——换来「书」不再被 `channels`/`items`/`tcm_kind`/`genre_mirror`/`book_stats` 层层叠加绑架，代价是两张表需要各自维护、概念上「书」出现双源，未来若需统一须另行收敛（见被否决方案 1/3）。
- `book_info` 复用 `content:book:read`，意味着**看到书的角色也能看到书本信息**，但不新增授权边界；若日后需要「书本信息单独授角色」，再按 09 §3.3 四步加码。
- 新增 `book_info` 属 `SNAPSHOT_TABLES` 可登记范畴，须在 `manage-cli/lib/snapshot.ts` 登记 `durable`，否则快照恢复报「未登记的表」。
- 索引走点查/窄范围：`book_no`/`parent_id`/`is_enable` 建索引；避免全表扫描（09 §2 步 4 必查，量化见实施清单）。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 1. 扩展既有 `channels` 补 BookInfo 字段 | 正是要解的痛点：`channels.data` JSON 已叠 `bookId`/`serialStatus`/`signStatus`/`genre`/`bookNo`，再加 `chengShu`/`caseTag`/`hotBook` 只会让「层层叠加」更严重，且改动既有内容链路（含 TCM 书），风险与收益不成比例 |
| 2. 替代 + 迁移：新建表并把 channels-书迁入、`items` 改指新表、废弃 channels-书 | 用户本轮明确「不考虑项目 channels/items 等」；全量迁移涉及 TCM 古籍书（`bookNo`/`tcm_kind` 结构）与站点主 feed（`is_primary`），改动面与风险显著高于收益，留待独立重构 |
| 3. 仅代码层解耦（数据仍存 `channels.data`，只抽 server/UI/API） | 不解决「数据模型仍被 channels/items 叠加」这个根因；用户要的是独立模型，不是代码目录重组 |
| 4. `book_info` 并入既有 `ext_*` 槽表 | 语义不符：`ext_book_stats` 是聚合物化、`ext_book_status` 是字典，都不是「书本信息」自持实体；硬塞会污染既有表语义 |
