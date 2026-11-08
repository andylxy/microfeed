# ADR-0068: 退役手工别名维护层，保留 App 派生别名端点

物理删除 `ext_tcm_aliases`（本地真库 2 行、活跃行 0）与 `/admin/aliases/` 手工维护层，保留 `GetAliaZhongYao` 与三源派生，端点过滤空正名后维持 341 条且集合逐条一致；`yao_alia`（47 行）、App `aliases` 缓存桶、`SNAPSHOT_TABLES.durable` 里的 `ext_tcm_aliases` 条目全部保留。

- 状态：Accepted（2026-11-08 决策定稿；代码与迁移已按 8 张工单写入仓库，部署与清桶由用户另行下令）
- 关联：ADR-0049（缓存分桶与写时清理）、ADR-0053（权限快照物化镜像）、ADR-0057（页面守卫与自持权限树）、ADR-0064（独立 `yao_alia` 模块）、ADR-0066（前台独立内容引擎）
- 证据范围：本地真库只读探针，2026-11-08，实例 `ctwh-881019-xyz`（`items=9506`、`d1_migrations=187`、`MAX(name)=0189_data_front_site_settings.sql`）；`.scratch/adb-joint-20261026b/logcat.txt:5934`
- **结论：有条件可以**。5 个条件见「实施前置条件」。远程生产库行数与 App 客户端缓存策略是本仓库取不到的量，见「仓库内无数据」。

## 背景

后台 `/admin/aliases/` 是 `GetAliaZhongYao` 的镜像看板：`getDerivedYaoAliases`（`src/server/tcm/reads.ts:823`）从 `items` 口袋三源（`aliases[]` / `yaoNames` / `bieMing`）派生「别名 → 正名」映射，`ext_tcm_aliases`（0075 建表、0076 加 `deleted`）在最后叠加管理员写入的覆盖与隐藏指令。2026-11-08 本地真库核查：该表 2 行全是 `deleted=1` 隐藏指令，活跃行 0；纯派生 342 条，端点当前下发 341 条，与 2026-10-26 真机 logcat 的 341 条一致。`yao_alia`（0183 / ADR-0064）是自持的 47 行种子，不读写旧链路。

## 决策

1. 新迁移 `0190_data_retire_alias_module.sql`（当前 `MAX(name)` 为 0189）：`DROP TABLE ext_tcm_aliases`，并清 3 个权限节点、2 枚权限码、4 条角色授权，随后全量重算 `ext_user_permissions`。0074 / 0075 / 0076 与 `scripts/frozen-migration-names.txt`（103 行、冻结到 0107）保持原样，0190 不追加进去。代码与迁移必须同一次 `manage deploy` 上线：先单独 apply 会让线上旧代码的 `SELECT ... FROM ext_tcm_aliases` 报错。SQL 全文与 `-- rollback:` 块见「0190 迁移内容」。
2. 整文件删除 4 个：`src/pages/[adminPath]/aliases/index.astro`、`src/components/admin/aliases/AliasesApp.tsx`、`src/pages/[adminPath]/ajax/aliases/index.ts`、`src/server/admin/alias-handlers.ts`，以及 `tests/worker/aliases.test.ts`。行级删除：`Constants.ts` 的 `ADMIN_MENU_CODES.ALIASES` 与两枚 `CONTENT_ALIAS_*`、`StringUtils.ts` 的 `ajaxAliases`、`pc-interfaces.ts:82`、`AdminPageGuards.ts` 的 `aliases` 项、`rbac/seed.ts` 两行与 editor 默认授权、`RbacPermissionDocs.ts` 两条说明、`app-cache.ts:323-326` 的 `purgeAppYaoAliasesCache`（4 个调用点全在 `alias-handlers.ts`）、`reads.ts:112` 的 `AppYaoAlias` 与 `884-913` 的 `getAppYaoAliases`。
3. `GetAliaZhongYao.ts` 改调 `getDerivedYaoAliases`，把 `Map<string,string>` 转成 `{bieming,name}[]` 时**过滤 `name === ""`**。理由与集合比对数字见「饴糖空正名」。`yao-aliases` 24h 缓存桶、`BUCKET_OF_CACHE["yao-aliases"]="aliases"`（`cache-control.ts:61`）、`AppCacheBucket "aliases"`、`purgeAppYaoCache()` 的双桶清理全部保留。
4. `yao_alia`（0183 / ADR-0064）不动。其 D1「本期不替换 `GetAliaZhongYao`」仍成立：本决策保留该端点，只移除它之上的手工覆盖层。47 行种子与派生集合有 47 个同名别名，其中 2 个正名不同（`白蜜`：派生 `石蜜` / `yao_alia` `蜜`；`硝石`：派生 `芒硝` / `yao_alia` `赤消`），属预期双源，不因本决策变化；`饴糖` 在 `yao_alia` 中 0 行。
5. `manage-cli/lib/snapshot.ts:149` 的 `SNAPSHOT_TABLES.durable` **保留** `ext_tcm_aliases` 条目，把 `145-148` 行注释改为 4 行（写明表已于 0190 删除但历史快照仍含该表）；同文件 `85-87` 行的 `yao_alia` 注释同步为三源派生口径。移除会让旧快照恢复在两处硬失败，见「快照分类与恢复」。

## 数据完整性核准

全部数字为 2026-11-08 本地真库只读探针结果，取数命令见「核准命令」。

| # | 方向 | 当前值 | 删除后值 | 异常条件 | 处置 |
|---|---|---|---|---|---|
| 1 | `ext_tcm_aliases` 行 | 2 行，2 行 `deleted=1`，活跃 0 | 0 行（表消失） | 远程若有 `deleted=0` 行则丢失手工覆盖内容 | 删表前导出 2 行到 `.scratch/backups/`；实施前取远程行数 |
| 2 | 侧表引用 | FK 0；`sqlite_master` 中引用该表的对象仅表本身 1 个（无视图/索引/触发器） | 同左 | 无 | `DROP TABLE` 无级联对象 |
| 3 | 权限码 / 授权 | `ext_permissions` 71 行含 2 枚；`ext_role_permissions` 63 行含 4 条（editor×2、readonly×2） | 69 行 / 59 行 | 保留码则后台出现无页面可指的孤儿码 | 0190 内删 2 码 + 4 授权 |
| 4 | 权限快照 | `ext_user_permissions` 9 行、165 个码 token、7 行含旧码共 14 个 token | 9 行、151 个码 token | 不重算则 7 行留幽灵码，与 ADR-0053「唯一物化镜像」不变量冲突 | 0190 内全量重算；重算后 `onlyInSnapshot=[]`、`onlyInRebuilt=[]`、`codeDiff=[]`，即除 14 个旧码外无变化 |
| 5 | 审计记录 | `ext_rbac_audit` 9 行含 `alias`，`detail` 9 / `before_detail` 9，同一批 9 行，`action` 全为 `role.permissions` | 9 行不变 | 删除会抹掉授权变更历史 | 保留；这些是历史文本，不是运行时依赖 |
| 6 | 权限节点 | 116 行含 3 行 alias：`page_aliases`（page, sort=109, `entry_code=content:alias:read`, `path=aliases`）+ 2 个 code 叶子（sort 0/1） | 113 行 | 只删页面行会留 2 个孤立叶子 | 按「先 2 叶、后 1 页」删 3 行；FK 0，2 个触发器 `trg_permission_nodes_entry_needs_path_ins/upd` 均为 BEFORE INSERT/UPDATE 且条件是 `entry_code 非空且 path 空`，DELETE 不触发、3 行也不满足条件 |
| 7 | 节点排序 | `group_content` 下 17 个页面行 sort = 101,102,103,104,105,107,108,109,110,111,111,112,112,113,114,115,116；106 已缺、111 与 112 各重复 2 行 | 16 行，缺号集合 {106,109}，重复仍 2 处 | 断号不新引入异常 | `menu.ts:46`、`rbac-handlers.ts:137`、`permission-tree-handlers.ts:39` 用 `ORDER BY sort, code` 按数值排，断号不改其余 16 行相对顺序；`scripts/` 下 sort 连续/唯一门禁命中 0 |
| 8 | App 结果集 | 341 条 | 341 条 | 不过滤空正名则变 342 条且含 1 条 `name=""` | 端点过滤 `name === ""`；集合比对见下节 |
| 9 | 派生质量 | `add` 调用 540 次、空 token 137 次、同名覆盖 61 次、最终 342 条；空正名 1 条（`饴糖`）、别名 >64 字符 0、>200 字符 0、控制字符 0 | 响应 341 条 | 空正名来自源数据而非手工层 | 过滤在端点响应层，不改 `getDerivedYaoAliases` 语义 |
| 10 | 缓存 | `aliases` 桶下 1 个缓存名 `yao-aliases`；重建行读 aliases 1,104 / zhongyao 1,212 | 桶与键均保留，桶内内容需失效 | 不清桶则 App 最长 86,400 秒仍拿 341 条旧结果 | `POST /admin/ajax/cache/purge {"scope":"aliases"}` 清 1 桶 1 键（1,104 行重建）；`purgeAppYaoCache()` 清 2 键（2,316 行重建），多 1,212 行 |
| 11 | 缓存配置 | 本地 `settings` 13 类、`app_cache_control` 0 行 → 运行时取 `DEFAULT_APP_CACHE_CONTROL`：`enabled=true`、`ttls.content=86_400`、`buckets.aliases=true`；`APP_CACHE_TTL_RANGES.content.max=86_400` | 全部不变 | 本地 miniflare 不支持 `cache.purge`（`purge.ts:14`），本地端点会 502 | 生产走 scope 端点；本地走 `purgeAppYaoCache()` 或停服清盘上 cache。节流 `PURGE_MIN_INTERVAL_MS=10_000`、`PURGE_DAILY_MAX=30`，超限 429 |
| 12 | 快照分类 | `durable` 已登记该表；表存在窗口 0075–0189 共 115 个迁移文件、台账 117 条记录（`substr(name,1,4)>='0075'`） | 条目保留 | 移除条目 → 旧快照恢复两处硬失败 | 见「快照分类与恢复」 |
| 13 | 迁移台账 | 187 条，`MAX=0189`；冻结清单 103 行止于 0107 | 188 条，0190 | `0190` 是 `data` 类，缺 `-- rollback:` 块会被 `scripts/check-migrations.ts` 规则④拒绝 | 按 `docs/agents/arch-gates.md:28-29` 写回滚块；历史迁移与冻结清单不动 |

### 饴糖空正名

`items` 行 `CooZFDY3Gtb`（`status=1`）的 `bieMing` 原文是 `" 饴糖"`（前导空格）。`reads.ts:868-872` 按分隔符切分后 `parts[0]=""`、`parts[1]="饴糖"`，于是派生集合里 `饴糖 → ""`；另一行 `WDwwwEG52Nw` 的 `bieMing="饴糖"` 只有 1 个 token，不进入 `add`。`ext_tcm_aliases` 里那条 `deleted=1` 的 `饴糖` 隐藏指令恰好把这条空正名记录从端点结果里剔除。

集合比对（本地探针）：当前端点有效集 341 条；派生集合过滤空正名后 341 条；`onlyInEffective=[]`、`onlyInFiltered=[]`、`valueMismatch=[]`，即**两边逐条一致**。「测试别名X」不命中派生集合，删掉它不改结果。因此过滤空正名后的结论是 **341 → 341，零行为变化**；不过滤则是 341 → 342，新增 `{bieming:"饴糖", name:""}`。本决策取前者。

### 快照分类与恢复

`snapshot.ts:120-132` 已有同款先例：`ext_menu`（0168 删表）与 `ext_menu_permissions`（0164 删表）的表名都继续留在分类清单里，注释写明原因是分类器会扫迁移 DDL、且中间版本快照里表仍存在。移除 `ext_tcm_aliases` 会触发两处报错：

1. `snapshot.ts:493` 的 `assertClassifiedTables(Object.values(tables).flat(), tables)` 对旧快照 manifest 中未登记的表抛 `Snapshot creation refused unclassified application tables`（`761-782` 行）。
2. `snapshot.ts:498-501` 要求 `expectedRowCountTables = [...tables.durable].sort()` 与 manifest `rowCounts` 的键完全一致；旧快照的 `rowCounts` 含该表，移除后立即抛错。

`buildRestoreSql`（`942-967` 行）还会为 `currentApplicationTables` 与 `snapshotApplicationTables` 的并集逐表生成 `DROP TABLE IF EXISTS`，恢复一个 0075–0189 之间产出的旧快照时会先删该表再导入 schema 与 data，清单保留即可正常完成。

DDL 共 3 类提到该表名：`0075 CREATE TABLE`、`0076 ALTER TABLE ... ADD COLUMN`、`0190 DROP TABLE`。

### 0190 迁移内容

```sql
-- rollback: 由 .scratch/backups/ 的 2 行备份重建 ext_tcm_aliases（含 deleted 列）；
--           恢复 2 枚 content:alias:* 权限码、4 条角色授权、3 行 ext_permission_nodes；
--           最后按 AGGREGATE_SELECT 全量重算 ext_user_permissions（9 行 / 165 码）。
DROP TABLE ext_tcm_aliases;

DELETE FROM ext_permission_nodes
 WHERE code IN ('content:alias:manage', 'content:alias:read', 'page_aliases');

DELETE FROM ext_role_permissions
 WHERE permission_id IN ('p_content_alias_manage', 'p_content_alias_read');

DELETE FROM ext_permissions WHERE code LIKE 'content:alias:%';

DELETE FROM ext_user_permissions;
INSERT INTO ext_user_permissions
       (user_id, codes, is_member, admin_login_allowed, updated_at)
SELECT ur.user_id,
       COALESCE(json_group_array(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '[]'),
       MAX(r.is_member),
       MAX(r.allow_admin_login),
       CURRENT_TIMESTAMP
  FROM ext_user_roles ur
  JOIN ext_roles r ON r.id = ur.role_id
  LEFT JOIN ext_role_permissions rp ON rp.role_id = ur.role_id
  LEFT JOIN ext_permissions p ON p.id = rp.permission_id
 GROUP BY ur.user_id;
```

快照重算必须排在删码之后：`AGGREGATE_SELECT`（`src/server/rbac/snapshot.ts:122-133`）读 `ext_permissions`，顺序决定聚合看到新值还是旧值。`INSERT ... SELECT` 按位置匹配 5 列，与 `refreshUserSnapshotStatements` 同形。

### i18n 与引用计数

- 待删键定义：`aliases` 命名空间 30 键（`zh-CN.ts:1883-1914` / `en.ts:1899-1930`）、`errors.aliases` 3 键（`3260-3264` / `3285`）、`menu.item.aliases` 1、`pageTitle.aliases` 1、`pageDocumentTitle.aliases` 1 = **36 键/语言，2 语言共 72 个定义**。
- 保留：`appCache.bucket.aliases` 1 键/语言 = 2 个定义（`zh-CN.ts:2696` / `en.ts:2719`），桶仍在使用。
- 显式引用待删键的源码：3 文件 41 处 —— `AliasesApp.tsx` 33、`aliases/index.astro` 2、`alias-handlers.ts` 6。`menu.item.aliases` 由 `menuEntryLabelKey(code)` 动态拼键（`AdminNavigation.ts:66`），无字面量引用，随 `ADMIN_MENU_CODES.ALIASES` 与 `page_aliases` 节点删除自动失效。
- `git grep -l "ext_tcm_aliases" -- . ':!.scratch'` = 24 文件 53 处。该口径只覆盖表名字面量，分类：整文件删 4、行级改 2（`reads.ts`、`snapshot.ts` 注释）、实施阶段同步 6、活文档同步 1、历史文件不动 11（3 份 `.workbuddy/memory/*`、1 份 skill、4 份历史 ADR、3 份迁移）。
- `git grep -l "content:alias:" -- . ':!.scratch'` = 20 文件 46 处，是另一口径，与上面 24 文件部分重叠；只引用权限码、URL、函数名的文件不在其中任一口径里。`.scratch` 内 96 文件 296 次，属本机草稿、不入库，不计入实施范围。本 ADR 自身 6 处，文件未跟踪，不计入 `git grep`。
- 实施改动面并集：把 `ext_tcm_aliases` / `content:alias:` / `getAppYaoAliases` / `AppYaoAlias` / `purgeAppYaoAliasesCache` / `ajax/aliases` / `ajaxAliases` / `ADMIN_MENU_CODES.ALIASES` / `CONTENT_ALIAS` / `/admin/aliases` / `pageTitle.aliases` / `pageDocumentTitle.aliases` / `menu.item.aliases` / `errors.aliases` / `"aliases.` / `'aliases.` 这 16 个符号合到一条 `-E` 正则，`git grep -l … -- . ':!.scratch'` = **45 文件 205 处**。该正则不含 i18n 定义（键写成 `aliases: {`），另有 `zh-CN.ts` / `en.ts` 2 个，合计 **47 个已跟踪文件**：
  - 需改 **30** 个（实施期复核为 31，见下文「实施期复核」）= 注释/白名单/活文档同步 9 + 整文件删 4 + 行级改 9（`GetAliaZhongYao.ts`、`pc-interfaces.ts`、`app-cache.ts`、`rbac/seed.ts`、`reads.ts`、`AdminPageGuards.ts`、`Constants.ts`、`RbacPermissionDocs.ts`、`StringUtils.ts`）+ 测试 6 + i18n 定义 2。
  - 不动 **17** 个 = 6 份记忆/skill + 5 份历史 ADR（0024 / 0043 / 0049 / 0057 / 0064）+ 6 份迁移（0074 / 0075 / 0076 / 0122 / 0127 / 0183）。
- 5 份历史 ADR 原文不追溯改写。方案阶段注释/白名单/活文档同步项为 9 个文件：`docs/yao-alia/index.md:10-22`、`manage-cli/lib/snapshot.ts:145-147`、`scripts/check-server-layout.ts`、`scripts/import-ctwh/build.ts:1030`、`src/shared/YaoAlia.ts:6`、`src/components/admin/yao-alia/YaoAliaApp.tsx:119`、`src/pages/[adminPath]/ajax/yao-alia/index.ts:17`、`src/pages/[adminPath]/yao-alia/index.astro`、`src/server/yao-alia/store.ts`。其中 `build.ts:1030` 把 `getAppYaoAliases` 写成现存函数，是并集 grep 才纳入的第 9 个；实施期补入第 10 个 `src/server/yao-alia/handlers.ts:10`，最终同步 10 个文件，见下节。本行行号为方案阶段口径；实施后 `snapshot.ts` 的注释为 `145-148` 共 4 行。
- 测试改动面：6 文件 15 处（`git grep -n -E "ext_tcm_aliases|content:alias:|getAppYaoAliases|AppYaoAlias|purgeAppYaoAliasesCache|ajax/aliases|ADMIN_MENU_CODES\.ALIASES|/admin/aliases" -- tests/`）。`tests/worker/aliases.test.ts` 整文件删（3 处）；余下 5 文件 12 处改局部断言：`admin-menu.test.ts` 1、`app-cache.test.ts` 2、`rbac.test.ts` 4、`tcm-app-reads.test.ts` 2、`tcm-reads-errors.test.ts` 3。`tests/unit/server/pc-interfaces.test.ts` 的 `alias` 命中是模块路径别名解析函数 `resolveAlias`，与旧模块无关，不改。改 i18n 后须跑 `yarn i18n:check`，执行时机由用户手动触发门禁。

### 实施期复核（2026-11-08）

实施由 8 张工单顺序执行（`.scratch/alias-retire/issues/00-overview.md`）。完成后复核，实施相对方案阶段有 3 处数字差异与 3 项新增登记；上文 `git grep` 实测值保留为方案基线，不改写：

- 残留符号 `16 → 17`：补入 `alias-handlers`（`src/server/yao-alia/handlers.ts:10` 原文引用旧 `alias-handlers.ts`）。`verify.mjs` 的 `RESIDUAL_SYMBOLS` 现为 17 项，全仓 1,149 文件扫描 0 处残留。
- 注释 / 白名单 / 活文档同步文件 `9 → 10`：补入 `src/server/yao-alia/handlers.ts:10`，工单 07 标题与正文按 10 个文件回填。
- 已跟踪改动面 `30 → 31`：26 个行级改 + 5 个整文件删。`git diff HEAD --name-status` 为 28 M / 5 D，其中 `CONTEXT.md` 与 `.workbuddy/memory/MEMORY.md` 2 个 M 属上一阶段成果，本轮未动。
- `snapshot.ts` 注释由「`145-147` 共 3 行」改为「`145-148` 共 4 行」，且同文件 `85-87` 行的 `yao_alia` 口径一并同步；决策 5、前置条件 3、工单 04 均已按 4 行回填。
- 按 `AGENTS.md`「不允许使用的字」清理 6 个文件的注释用字：`scripts/import-ctwh/build.ts`（9 处）、`scripts/check-server-layout.ts`、`src/server/tcm/reads.ts`、`src/shared/RbacPermissionDocs.ts`、`docs/yao-alia/index.md`、`tests/worker/tcm-app-reads.test.ts`。规则来自仓库规范，不是新增功能，清单登记在工单 07。
- 上文 `45 文件 205 处`、`47 个已跟踪文件`、`需改 30 个` 是实施前 `git grep` 的方案基线，保留不改；实施后的 `31 / 10 / 17` 以本节为准。

### 核准命令

```bash
# 引用计数（已跟踪文件，排除本机草稿）
git grep -l "ext_tcm_aliases" -- . ':!.scratch' | wc -l
git grep -n "ext_tcm_aliases" -- . ':!.scratch' | wc -l
git grep -l "content:alias:" -- . ':!.scratch' | wc -l

# 16 个旧模块符号并集 → 45 文件 / 205 处
PAT="ext_tcm_aliases|content:alias:|getAppYaoAliases|AppYaoAlias|purgeAppYaoAliasesCache|ajax/aliases|ajaxAliases|ADMIN_MENU_CODES\.ALIASES|CONTENT_ALIAS|/admin/aliases|pageTitle\.aliases|pageDocumentTitle\.aliases|menu\.item\.aliases|errors\.aliases|\"aliases\.|'aliases\."
git grep -l -E "$PAT" -- . ':!.scratch' | wc -l
git grep -n -E "$PAT" -- . ':!.scratch' | wc -l

# 本地真库行数与快照码（只读，node:sqlite）
# 库：.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa883…sqlite
# 表基线：SELECT COUNT(*) FROM ext_tcm_aliases; → 2
# 活跃行：SELECT COUNT(*) FROM ext_tcm_aliases WHERE deleted=0; → 0
# 快照：SELECT SUM(json_array_length(codes)) FROM ext_user_permissions; → 165
# 台账：SELECT COUNT(*), MAX(name) FROM d1_migrations; → 187, 0189_data_front_site_settings.sql

# 派生集合数字（复刻 reads.ts:823-876 的三源合并，只读）
# ① SELECT data FROM items WHERE tcm_kind='yao' AND status=1 ORDER BY id
#    逐行取 _microfeed.aliases[] 与 yaoNames；yaoNames 按 /[,，；; 。.、]+/ 切分，
#    每个 token 映射到该行标题去掉「\d+、」前缀后的药名。
# ② SELECT data FROM items WHERE tcm_kind='section' AND status!=3
#      AND json_extract(data,'$._microfeed.bieMing') > ''
#    按同一分隔符切分，parts.length>1 时 parts[0] 为正名、parts[1..] 为别名。
# ③ 后写覆盖先写 → 342 条；过滤 name='' → 341 条。
# ④ 叠加 ext_tcm_aliases：deleted=1 做 delete、deleted=0 做 set → 当前端点 341 条。
# ⑤ ①③的 341 与 ④ 的 341 做键集合与值比对 → onlyInEffective/onlyInFiltered/valueMismatch 均为 []。
```

## 仓库内无数据

- **远程生产库**：本仓库不含远程 D1 数据，且按 2026-10-12 约定，D1 结论以本地快照实测为准、不主动连远程。实施前取数：

  ```bash
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
  npx wrangler d1 execute FEED_DB --remote \
    --config .microfeed/instances/ctwh-881019-xyz/wrangler.jsonc --json \
    --command "SELECT COUNT(*) AS aliases FROM ext_tcm_aliases; SELECT COUNT(*) AS active FROM ext_tcm_aliases WHERE deleted=0; SELECT COUNT(*) AS snapshots FROM ext_user_permissions; SELECT COUNT(*) AS nodes FROM ext_permission_nodes"
  ```

  若 `aliases ≠ 2` 或 `active > 0`，本决策「活跃行 0、无手工覆盖内容」前提不成立，**不可以**直接实施，须重新评估数据丢失面。其余本地数字（9 行快照、116 行节点、71/63 行权限）同需按此命令在远程复核后再定迁移影响行数。
- **App 客户端本地缓存**：Android App 源码不在本仓库，无线上与本地缓存 TTL、持久化条数的数据。`.scratch/adb-joint-20261026b/logcat.txt:5934` 只证明 2026-10-26 真机请求 `GetAliaZhongYao` 并收到 341 条。若客户端缓存了 341 条响应，服务端清桶后客户端仍可能保留旧副本至自身过期；该窗口长度**仓库内无数据**，实施前需在 App 侧查响应缓存策略。

## 实施前置条件

1. `GetAliaZhongYao.ts` 过滤 `name === ""`，把结果维持在 341 条且与当前集合逐条一致。
2. 0190 内含 `ext_user_permissions` 全量重算，把 9 行 / 165 码改为 9 行 / 151 码，消除 7 行幽灵码。
3. `SNAPSHOT_TABLES.durable` 保留 `ext_tcm_aliases` 条目，把注释改为 4 行（`145-148`）。
4. 代码与迁移同一次 `manage deploy`；部署后 `POST /admin/ajax/cache/purge {"scope":"aliases"}` 清桶（1 桶 1 键、1,104 行重建），否则陈旧窗口最长 86,400 秒。
5. 用「仓库内无数据」的远程命令取得 `aliases=2`、`active=0`；不等则暂停实施。

## 考虑过的选项

- **连 `GetAliaZhongYao` 一起删**：不选。真机 logcat 确认 App 实际调用并收到 341 条；删端点还要动 `items` 口袋、0093 表达式索引与 `scripts/import-ctwh/*` 七个导入文件，收益仅为移除一张活跃行 0 的侧表。
- **连 `yao_alia` 一起删**：不选。47 行种子与独立后台模块于 2026-11-05 完成，删它废除的是仍在使用的真源。
- **保留 `getAppYaoAliases`，靠「表不存在静默跳过」兜住**：不选。`reads.ts:903-910` 的 try/catch 只吞 `no such table`，删表后不会 500，但每次请求先抛一次异常再吞掉，与 fast-fail 相悖；且两个函数语义等价，不该并存。
- **不过滤空正名，接受 342 条**：不选。会新增 1 条 `name=""` 记录，是把一条已由隐藏指令挡住的脏派生数据重新下发；过滤后集合与现状逐条一致。

## 后果

- 管理员失去覆盖与隐藏别名能力，别名随导入内容只读；删表前把 2 行导出到 `.scratch/backups/` 留可恢复副本。
- 侧栏少 1 项、权限码少 2 个、权限节点少 3 个、角色授权少 4 行、快照码少 14 个 token；`rbac.test.ts` 的 editor / readonly 默认权限计数与 `admin-menu.test.ts:297` 的菜单顺序断言同步调整。
- `GetAliaZhongYao` 条数 341 → 341，响应形状、`APP_BOOK_REQUEST_CONTENT_SUFFIXES` 的 8 个内容端点清单、`app:zhongyao:read` 门码均不变。
- `CONTEXT.md` 用「派生别名」与「药材别名」两个词条消歧；退役沿革只记在本 ADR，不写进术语表。

## 范围之外

代码与迁移已按 8 张工单写入仓库；测试只写不跑，门禁只在用户手动触发时运行，不自动提交。部署、清桶、远程前置取数由用户另行下令；执行期新发现的第 10 个注释同步点 `src/server/yao-alia/handlers.ts:10` 已随工单 07 一并改完，`10 文件 / 31 个 / 17 符号` 的复核数字见「实施期复核」。
