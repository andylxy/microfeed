# ADR-0064: 独立「药材别名」模块 `yao_alia`（参考 ctwh YaoAlia 实体）

- 状态：Accepted（2026-11-05 实施完成，工单 01–06 全部完成；测试只写不跑，门禁由用户手动触发）
- 日期：2026-11-04（决策定稿）／2026-11-05（实施完成）
- 关联：ADR-0058/0059（book-info，独立表 + 分组树范式）、ADR-0060（ming-ci）、ADR-0061（zhong-yao）、ADR-0062（book-chapter，专属权限码先例）、ADR-0063（多层树）；数据源 `ctwh/YaoAlia.sql`；方案 SSOT `.scratch/yao-alia-module/plan.md`；数字证据 `.scratch/yao-alia-module/probe-output.txt`
- 用户裁决：D1 = 两套别名模型并行共存、**本期不替换** `GetAliaZhongYao`；D2 = 新增专属码 `content:yao-alia:read`/`_manage`；D3 = 左栏按正名只读派生分组（book-info 双栏树形态）
- 工单划分：`.scratch/yao-alia-module/issues/01..06`（纵向切片，blockers-first）
- 实施落位：迁移 `0183_seed_yao_alia.sql`、`src/shared/YaoAlia.ts`、`src/server/yao-alia/{types,store,handlers}.ts`、`src/pages/[adminPath]/yao-alia/`、`src/pages/[adminPath]/ajax/yao-alia/`、`src/components/admin/yao-alia/YaoAliaApp.tsx`、`tests/unit/yao-alia-{schema,store,handlers}.test.ts`、`docs/yao-alia/index.md`

## 背景

后台已有一套「药材别名」概念，但它**层层叠加进通用条目与移动端点链路**：

1. `src/server/tcm/reads.ts:822` `getDerivedYaoAliases` 把三处来源合并成一张 `Map<别名, 正名>`——`items` 口袋 `_microfeed.aliases[]`、`Yao.YaoList`（口袋 `yaoNames`，按中英文逗号/分号/空格/句号/顿号切分）、`BookBody.BieMing`（口袋 `bieMing`，切分后 `result[0]` 为正名、其余为别名，走 `0093` 表达式索引）。
2. `:883` `getAppYaoAliases` 在派生结果之上最后合并 `ext_tcm_aliases`（`0075` 建表、`0076` 加 `deleted`）：`deleted=0` 是手工覆盖、`deleted=1` 是隐藏指令；表不存在时静默跳过。
3. `src/pages/api/AppBookRequest/GetAliaZhongYao.ts` 把结果塞进 `cachedAppResponse("yao-aliases")` 的 24 小时共享桶；`src/server/admin/alias-handlers.ts` 每次写都调 `purgeAppYaoAliasesCache()`。
4. `/admin/aliases/` 的 `AliasesApp.tsx` 把 manual/derived/hidden 三种状态混在一张分页表里，提供 override/hide/restore 三种语义不同的动作。

改一条别名要穿过 `items.data` JSON、三源优先级、覆盖/隐藏指令、缓存失效与 App 契约五层；而上游 `vol.api.sqlsugar` 里其实有一张干净的 `YaoAlia` 实体表（`ctwh/YaoAlia.sql`，47 行「别名 → 正名」），它是这一域的原始主数据，却在现有链路里没有任何对应物。

用户要的是**独立、干净的药材别名模型**：参考 `ctwh/YaoAlia.sql` 另立一张自持表，在既有派生/覆盖/缓存链路之外并行共存，参照 `/admin/book-info/` 的独立模块形态，不再让新数据叠进旧层。范式照抄 ADR-0060/0061/0062。

## 决策

1. **新建独立表 `yao_alia`**，镜像源实体有效字段（`yaoAliasNo`/`YaoBieMing`/`YaoName`/`IsEnable`），去框架专属列（`Extend01`–`12`/`OtherMark`/`ParentId`/`ExtJson`/`OrgId` 系，审计实测 20 列恒空，无信息损失）。按 microfeed 建表惯例：`VARCHAR(11)` 主键、`created_at`/`updated_at`/`deleted_at`（软删）、预留 `ext1`–`ext10`。**无状态枚举**：源只有 `IsEnable`（47/47 全 1），只留 `is_enable` 布尔，不建 settings 状态清单。**所有业务列名统一 `yao_alia_` 前缀**（与表名同源）。`signature_id`/`signature` 列位保留、种子为 NULL、admin 不编辑（与 ADR-0060/0061 同款）。
2. **不与任何既有链路耦合**：不迁移 `ext_tcm_aliases` 的行、不改 `items`/`channels`/`settings`、不改 `getDerivedYaoAliases`/`getAppYaoAliases`/`GetAliaZhongYao`/`alias-handlers.ts`/`AliasesApp.tsx`、不清任何公共缓存桶。两套别名模型**并行共存**：既有链路继续服务 App 与 `/admin/aliases/`，`yao_alia` 服务新的后台维护面；同名别名在两处可指向不同正名，属预期双源，不做合并、不做互相校验、不建外键。
3. **数据源与保真**：47 行 `INSERT OR IGNORE` 一次播种（`0183`）。4 个业务字段全为单行短文本，无行尾空格、无单引号、字段内无 CR/LF；源文件物理换行为 CRLF 47 处，属**行分隔符**而非字段内容，迁移用 LF 书写不构成内容损失。全部内联进迁移 SQL，不触发 `git diff --check`，**不需要**参数化导入脚本（对比 ADR-0062 决策 10 的 8066 行正文导入）。`yao_alia_no` 原样 1–47 作排序键，UNIQUE 索引兜底，新建走 `MAX+1`（next=48）fail-fast。
4. **种子 id 不依赖 tcm 导入管线**：用确定性可读 `ya00000001`…`ya00000047`（前缀 `ya` + 源 `Id` 8 位零填充），**不调用** `scripts/import-ctwh/build.ts` 的 `tcmId`（该算法带 `idOwner` 碰撞加盐且顺序依赖，ADR-0060/0061 已因此踩过复刻作废的坑）。定稿前只读探针核对与四张独立表种子 id 碰撞 = 0。
5. **两步删除、独立 URL**：软删只写 `deleted_at`，物删只对已软删行开放（409 `purgeNeedsDelete`），独立 `/purge` 端点。软删行仍占 `yao_alia_bie_ming` 唯一键，复用同名别名须先物删；不做静默改名、不做自动恢复。
6. **全栈模块 + 命名三形态**：迁移 + `src/server/yao-alia/` + `src/shared/YaoAlia.ts`（Zod 真源，UI 与 server 共用）+ `src/components/admin/yao-alia/` + `src/pages/[adminPath]/yao-alia/` + `ajax/yao-alia/`。**`yao_alia`**（下划线）= 表名/列名前缀/`page_yao_alia` 节点 id/`ADMIN_MENU_CODES.YAO_ALIA`；**`yao-alia`**（连字符）= 文件目录、路由、`AdminPageGuards` key、权限码段；**大驼峰 `YaoAlia*`** = 类型/schema/i18n 键段/组件名。
7. **新增专属权限码 `content:yao-alia:read`/`_manage`**（D2）：不复用 `content:alias:*`（绑定 `/admin/aliases/` 的三源派生 + 覆盖/隐藏语义），不复用 `content:yao:*`（旧中药 / `zhongyao` 页）、`content:book:*`（book-info）。三镜像 `src/shared/Constants.ts` + `src/server/rbac/seed.ts` + 迁移 `ext_permissions` 逐字节一致；`EDITOR_PERMISSIONS` 授两码；页面节点 `pn_page_yao_alia`（`parent_code='group_content'`、sort=115、`path='yao-alia'`、`entry_code='content:yao-alia:read'`、icon 复用 `tags`）+ 两片 `kind='code'` 叶子挂其下（ADR-0038）。按 `0181` 先例手工同步，**不跑 `yarn rbac:gen`**（生成器会另建权限迁移文件、与 `0183` 争编号）。
8. **左栏分组只读派生（D3）**：按 30 个 `YaoName` 分组、47 条 `YaoBieMing` 为叶，`AdminTreeNavLayout` + `AdminGroupTree` + `AdminTreeSearchInput` 三个既有共享组件组装，分组/计数/过滤全由调用方算好传入。**零 settings 清单、零 groups/reassign 端点、零改派、零末组禁删、零新表**；编辑正名后左栏即时重算，不写任何他表。这是与 ADR-0059（settings 分组）刻意不同的取舍：分组只是视图，不是数据。
9. **后台 CRUD 面**：ajax 端点读走 `content:yao-alia:read`、写走 `content:yao-alia:manage`；看板一次性返回 `{entries}`（含已软删行 + `isDeleted` 派生）。**无公共 `api/v1`、无 `AppBookRequest` 端点、无 OpenAPI 变更**；`check-endpoint-registration.ts` 只扫 `src/pages/api/`，ajax 端点无需登记。若日后 App 要读 `yao_alia`，需另立端点 + `app:*:view` 新码 + 契约测试（D1 范围之外）。
10. **横切清单同步**：`src/shared/AdminPageGuards.ts` 登记 `yao-alia` → `CONTENT_YAO_ALIA_READ`；`src/shared/RbacPermissionDocs.ts` 补两码长说明；`src/shared/StringUtils.ts` 的 `ADMIN_URLS` 补 3 个 ajax URL；`scripts/check-server-layout.ts` 的 `WHITELIST` 加 `yao-alia`；`manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES.durable` 加 `yao_alia`。`pc-interfaces.ts` 不改（四个既有独立模块均未登记，其测试只单向核对已列行）。

## 范围之外

- **不改 `items`/`channels`/`ext_*` 任何字段或语义**；不迁移 `ext_tcm_aliases` 行；不动三源派生、`GetAliaZhongYao` 的 24h 缓存桶、`/admin/aliases/` 三态看板与其 `content:alias:*` 门码。
- **本期不做 App 端点**（D1）：无 `api/AppBookRequest` 新文件、无 `app:*:view` 新码、无缓存 purge 调用。
- **不建分组清单、不建到 `zhong_yao`/`book_chapter_body` 的关联**：正名是自由文本，不校验是否命中他表，避免把解耦后的模块重新挂回旧链路。
- `signature_id`/`signature` 仅列位保留，不做外键、不作 ETag、admin 不编辑。
- 不改 `OpenApiDocument.ts`/`ApiSchemas.ts` 及任何生成物；不改 `pc-interfaces.ts`、`AGENTS.md`、`CONTEXT.md`、`docs/zh/` 分册；不改既有测试文件。
- 不写断言 `docs/` 散文/标题/链接的单元测试；文档校验走 `yarn docs:check`（执行时机归 AGENTS.md「最高指令」）。

## 后果

- 出现**第二套别名模型**：`yao_alia`（源实体镜像，自持）与派生三源 + `ext_tcm_aliases` 覆盖层（既有 App 链路）并存——与 ADR-0060/0061/0062 的双源同一取舍。换来「药材别名」不再被 `items.data` 口袋、三源优先级、隐藏指令与缓存失效层层叠加绑架；代价是概念上别名双源，未来若需统一须另行收敛（即 D1 的二期议题）。
- 新增 `content:yao-alia:*` 两码：与 `content:alias:*` 授权边界独立，给角色授旧页权限不会顺带打开新页，反之亦然；需同步 `RbacPermissionDocs.ts` 长说明，否则 `rbac-permission-docs.test.ts` 红。
- 新增 `yao_alia` 须登记 `SNAPSHOT_TABLES.durable`，否则快照创建/恢复报「未登记的表」（镜像 ADR-0061 后果 3）；新增 `src/server/yao-alia/` 须登记 `check-server-layout.ts` 白名单（镜像 ADR-0062）。
- 迁移 `0183` 只播不覆盖：重导入新版本源数据需另立 upsert 策略（当前源数据一次性冻结）。
- 索引走点查/窄范围：UNIQUE `yao_alia_no`、UNIQUE `yao_alia_bie_ming`、`yao_alia_name`；47 行全表本身极小，整表看板按 `yao_alia_no` 索引全序扫，按 `check-d1-scan.ts` 顾问模式加 `// d1scan:ignore` 并写入实测值。
- `page_yao_alia` 的 `audience='desktop'`：不新增 App 能力码，`DOMAIN_RULES` 零改动。

## 数据审计与异常核验（2026-11-04，全部实测量化）

> 审计方式：Python 只读探针（bytes 级 + 文本级双口径）解析 `ctwh/YaoAlia.sql`，stdout 冻结在 `.scratch/yao-alia-module/probe-output.txt`。编号探针读 `migrations/`、`docs/novel-cms/adr/` 与全部迁移里的页面节点 `sort`。零 D1 连接、零写入。**所有结论均为「可以 / 不可以 / 有条件可以」，无模糊档。**

### 1. 数据源（无异常）

- **可以**。`47` 物理行 × `32` 列，每行解析出 32 值；`30 030` 字节；`Id` 与 `yaoAliasNo` 均为 `1..47` 连续且各 47 distinct。
- **可以（格式）**。`physical_crlf=47`、`bare_lf=0`、`line_trailing_space=0`：源文件物理换行为 CRLF 47 处，行尾空格 0。4 个文本字段内 `content_cr_or_lf=0`、单引号 0、别名内空格 0；别名最长 4 字、正名最长 3 字。故内联进迁移 SQL 免转义、不触发 `git diff --check`，也无需参数化导入脚本。
- **可以（空列判定）**。`20` 列恒 NULL；有值仅 12 列：`Id`/`yaoAliasNo`/`YaoBieMing`/`YaoName`/`IsEnable`(全 1)/`IsDelete`(全 0)/`CreateID`(全 1)/`Creator`(全「超级管理员」)/`CreateDate`(47 distinct)/`ModifyID`/`Modifier`/`ModifyDate`(各 3 行)。删恒空列无信息损失；审计列不入库。

### 2. 别名与正名（无异常）

- **可以**。`YaoBieMing` 47/47 distinct → `yao_alia_bie_ming` 可建 UNIQUE。`YaoName` 只有 30 distinct → `yao_alia_name` **不可**建 UNIQUE，只能建普通索引。
- **可以（分组）**。按正名分 30 组：地黄 6，白术/大枣/小麦 各 3，桂枝/生姜/蜜/酒/代赭石/大麦 各 2，其余 20 个各 1；合计 47 行。分组完全由数据派生，不落库、不写 settings。

### 3. 编号与排序（无异常）

- **可以**。探针 [B]：迁移最大 `0182_seed_book_chapter_rows.sql` → 本模块取 `0183`；ADR 最大 `0063-book-chapter-three-level-tree.md` → 取 `0064`；页面节点 sort 最大 `114`（`0181_seed_book_chapter.sql`）→ 取 `115`。编号空间无冲突。

### 4. 实施期核对（2026-11-05 已实测，两项均通过）

- **可以**：47 个种子 id 前缀 `ya` + 8 位零填充，与 `book_info`/`ming_ci`/`zhong_yao`/`book_chapter` 四表种子 id（形如 `KXky0UUeJqt` 的 11 位混合串）碰撞数 = **0**——`migrations/*.sql` 全库仅 `0183` 出现 `ya0000…` 形态，共 47 条。
- **可以**：`0183_seed_yao_alia.sql` 全文 **9 430 字节**，单条种子 INSERT 远低于 100 000 字节上限，47 行一次写完。
- **可以（查询计划）**：在内存副本（镜像 `0183` 的 DDL + 47 行种子）执行 `EXPLAIN QUERY PLAN SELECT * FROM yao_alia ORDER BY yao_alia_no ASC, id ASC` → `SCAN yao_alia USING INDEX yao_alia_no_unique`，无表扫、无临时 B 树；300 次取中位 **0.10ms**。计划与毫秒数均已写入 `src/server/yao-alia/store.ts` 的 `// d1scan:ignore` 注释。
- **可以（数据落库一致性）**：同一内存副本读出 `COUNT(*)=47`、`COUNT(DISTINCT yao_alia_bie_ming)=47`、`COUNT(DISTINCT yao_alia_name)=30`、`MAX(yao_alia_no)=47`，与源文件只读探针四项逐一相等。

## 工单划分

`.scratch/yao-alia-module/issues/01..06`，按 `~/.agents/skills/to-tickets/SKILL.md` 的纵向切片规则切分（一个行为一票、层不是切分轴；ADR 文件、i18n 键与横切登记随引用它的行为同票）。编号即依赖序，`01` 无阻塞边；`06` 为 docs-only 收尾票。
