# ADR-0061: 独立「本草」模块 `zhong_yao`（参考 ctwh ZhongYao 实体）

- 状态：Accepted（2026-11-05 实施完成，工单 01–09 全部落地）
- 日期：2026-11-04（设计）/ 2026-11-05（实施完成）
- 关联：ADR-0060（独立「名词」模块，本 ADR 的直接范式来源）、ADR-0058/0059（独立模块 + 分组树范式）、`scripts/import-ctwh/build.ts`（真 `tcmId` 算法与既有 items 中药条目 id 生成）、数据源 `ctwh/ZhongYao.sql`
- 用户裁决（2026-11-04）：D1 表名/模块名 = `zhong_yao`（页面路由 `zhongyao`）；D2 = 无分组平铺；D3 = 本期不做 App 端点；D4 = 行尾空格命中 `git diff --check` 则 strip；D5 = id 用真 `tcmId('zhongyao', 源Id)` 预计算

## 背景

后台已有一套「中药」概念，但它**层层叠加进通用条目链路**：中药 = `items` 行（`tcm_kind='yao'`，172 条，id = `tcmId('yao', 源Id)`，见 `scripts/import-ctwh/build.ts:153` 与 `scripts/import-ctwh/import-yao.mjs` 的 id 一致性校验），挂在 `channels`（书/频道）之下；序号/别名等语义藏在 `items.data` JSON（`_microfeed.no`/`yaoNames`/`aliases`）；管理 CRUD 走**通用** `src/server/admin/tcm-entry-handlers.ts`（term/yao 共用）；管理 UI 走**通用** TcmEntryBoardApp（`kind` prop 切换）；App 读取（`src/server/tcm/reads.ts:751` `getAppAllYao`）直接 `SELECT FROM items WHERE tcm_kind='yao' AND status=1`，并与 429 经疏锚点（`JINGSHU_ONLY_YAO_NAMES`）、别名三源合并（`getDerivedYaoAliases`）深度纠缠。改一条药的展示文本要穿过 items/channel/ext_/口袋字段/缓存失效全链。

用户要的是**独立、干净的本草模型**，参考 `ctwh/ZhongYao.sql` 的 `ZhongYao` 实体（`Id`/`YaoNo`/`YaoName`/`YaoBieMing`/`YaoText`/`YaoList`/`SignatureId`/`Signature`/`IsEnable`），在既有中药机制之外**另立一张自持的 `zhong_yao` 表**，不与 items/channels 复用或迁移数据。范式照抄 ADR-0060（独立表 + 后台双栏 UI + 种子迁移 + 复用权限码）。

## 决策

1. **新建独立表 `zhong_yao`**，镜像源实体有效字段（`YaoNo`/`YaoName`/`YaoBieMing`/`YaoText`/`YaoList`/`SignatureId`/`Signature`/`IsEnable`），去框架专属列（`Extend01`–`12`/`OtherMark`/`ParentId`/`ExtJson`/`OrgId` 系，源数据审计 §3 实测全空，无信息损失）。按 microfeed 建表惯例：`VARCHAR(11)` 主键、`created_at`/`updated_at`/`deleted_at`（软删）、预留 `ext1`–`ext10`。**无状态枚举**：源只有 `IsEnable`（172/172 全 1），只留 `is_enable` 布尔，不建 settings 状态清单（与 ADR-0060 决策 1 同一取舍）。**所有列名统一 `zhong_yao_*` 前缀**（`zhong_yao_no`/`zhong_yao_name`/`zhong_yao_bei_ming`/`zhong_yao_text`/`zhong_yao_list`，与表名同源，无例外）。
2. **不与 `items`/`channels` 耦合**：不迁移既有 172 条 `tcm_kind='yao'` items 行、不改其数据、不废弃既有中药链路（App `GetAllZhongYao`、方剂 `fangYaoList.yaoId` 仍指向 items 条目）。两套中药模型**并行共存**：items-中药（既有内容链路 + App 读取 + 方剂引用）与 `zhong_yao`（参考模型镜像，后台自持）各管各的，互不读写。
3. **无分组**（用户裁决 D2）：源实体无分类字段（无 `MingCiType` 对应物），**不伪造推导分组**——不建分组清单（对比 ming-ci 的 `mingci_groups` + settings KV）、无 groups/reassign 端点。**UI 复用 `AdminTreeNavLayout` 两栏容器**（用户指令）：`nav` 槽放平铺列表 + 搜索、`children` 槽放详情/表单——该容器零业务、只有两个 ReactNode 槽（`src/components/admin/shared/AdminTreeNavLayout.tsx` L3–12），左栏放什么由调用方决定，故「复用容器」与「无分组」自洽；**不引 `AdminGroupTree` 树组件**（ming-ci 的 `MingCiApp` 是容器 + 树两个组件都用，本草只复用前者）。
4. **无来源书**：源实体无 `SoureBook` 对应物 → 无 `source_book_id` 列，不读 `book_info`（对比 ming-ci 决策 3）。
5. **别名列保留并播种**：`YaoList` 源非空 52/172 行（逗号切分为别名 token，104 个 token 全 distinct、无空元素、无尾随逗号——审计 §4）；`YaoBieMing` 全 NULL（列位保留，种子空）。`zhong_yao_list` 存 JSON 数组字符串（镜像 App 形状 `string[]`），映射规则：空→`'[]'`，否则 `JSON.stringify(split(',').map(trim))`。
6. **全栈模块 + 命名三形态**：按 `docs/zh/09-new-module.md` §2 落位——迁移 + `src/server/zhong-yao/` + `src/shared/ZhongYao.ts`（Zod）+ `src/components/admin/zhong-yao/` + `src/pages/[adminPath]/zhongyao/` + `src/shared/AdminPageGuards.ts` 登记 + 契约/运行时测试（**只写不跑**）。三形态各自固定、不混用：**`zhong_yao`**（下划线）= DB 表名/列名前缀/`ext_permission_nodes` 节点 id（`page_zhong_yao`）；**`zhong-yao`**（连字符）= 文件系统目录（`src/server/zhong-yao/`、`src/components/admin/zhong-yao/`）；**`zhongyao`**（无分隔，用户裁决 D1）= 路由路径（`[adminPath]/zhongyao`）+ `AdminPageGuards` key + ajax 目录（`ajax/zhongyao/`）。类型与 schema 用大驼峰 `ZhongYao*`（`ZhongYaoEntry`/`ZhongYaoBoard`/`zhongYaoCreateSchema`）。
7. **复用权限码，不加新码**（镜像 ADR-0060 决策 6）：页面守卫复用既有 `PERMISSION_CODES.CONTENT_YAO_READ`/`_MANAGE`（`Constants.ts:309-310` 已存在，既有 `yao` 页同码），在 `AdminPageGuards.ts` 登记 `"zhongyao"` 路由 → `CONTENT_YAO_READ`；侧栏页面节点随迁移播种（`page_zhong_yao`，`entry_code='content:yao:read'`，icon 复用已注册的 `leaf`——`src/shared/MenuIconNames.ts:29` 已含，免 check-i18n 新图标标签）。**权限码三镜像零改动**：`Constants.ts` / `rbac/seed.ts` / 既有权限迁移都不加新码（`content:yao:read`/`_MANAGE` 已存在于三者）；迁移 `0180` 只是**新增文件**、其内插一行页面节点 seed 数据（`ext_permission_nodes`，列序按 0177 新列序含 `path`/`entry_code`，sort=113 排 `ming-ci`=112 之后），不动任何既有权限行。
8. **后台 CRUD 面**：管理员 ajax 端点（`[adminPath]/ajax/zhongyao/`），读走 `loadZhongYaoBoard`（一次性返回 `{entries}`，含已软删行 + `isDeleted` 派生），写走 create（`zhong_yao_no` 事务内 `MAX+1`，UNIQUE 索引兜底 fail-fast）/update（合并式）/delete（软删）/purge（物删，仅已软删行）。**无公共 api/v1、无 App 端点**（用户裁决 D3）——App 中药数据流继续走 items；若日后 App 要读 `zhong_yao`，需另立 `GetAllZhongYaoV2` 类端点 + `app:*:view` 新码，按 OpenAPI 契约另立。
9. **数据导入**：`ctwh/ZhongYao.sql` 172 行经迁移 `0180_seed_zhong_yao.sql` 播种（`INSERT OR IGNORE`，幂等，只播不覆盖）。id = `tcmId('zhongyao', YaoId)` 确定性 11 位，**必须用真 `tcmId`（`scripts/import-ctwh/build.ts:153`）在隔离进程按 `YaoId` 1→172 顺序预计算**（真算法带 `idOwner` 碰撞加盐 salt 0–7，id 依赖调用顺序；2026-11-04 已预计算并核验，见审计 §1）。迁移只读文件于作者时，运行时不读文件。`YaoText` 的 MySQL 转义序列 `\r\n`/`\n` **解析为真实换行**（与 ming-ci 0179 存真实换行一致；后台 textarea / 未来 App 的 `whitespace-pre-wrap` 渲染需真实换行，字面转义序列会原样显示）。**勘误（2026-11-04）**：本条原写「字面 `\r\n` 原样保留」，实施验证为错误口径——原样入库会导致 textarea 里是 `\r\n` 文本而非换行。源反斜杠序列只有 `\r`(x364) `\n`(x384)，无其他，转换无歧义；168 行 CRLF + 4 行 LF 精确对应。行尾空格命中 `git diff --check` 红线则 strip（用户裁决 D4；审计 §7 实测源文本**无**行尾空格，本条仅为防御性规则）。

## 范围之外

- **不改 `items`/`channels`/`ext_*` 任何字段或语义**；不动 `GetAllZhongYao`/`getAppAllYao`/429 锚点/别名三源合并；不动方剂 `fangYaoList.yaoId`（仍指向 items 条目 id）。
- **不迁移既有 items 中药**（`tcm_kind='yao'`）：既有中药继续走 items，App 端点与既有 `yao` 板不动。`zhong_yao` 从种子 172 行开始，供新录入/后续按需回填。
- **不做 App 端点**（裁决 D3）：无 `api/AppBookRequest` 新文件、无 `app:*:view` 新码。
- **不做分组**（裁决 D2）：无分组清单、无 groups/reassign 端点、无 `AdminGroupTree` 树组件；但**仍复用 `AdminTreeNavLayout` 两栏容器**（左栏 `nav` 放平铺列表）。
- `signature_id`/`signature` 仅列位保留（App 签名语义），不做外键、admin 不编辑。
- 不写 `docs/` 散文断言测试；文档校验走 `yarn docs:check`（执行时机归 AGENTS.md「最高指令」）。

## 后果

- 出现**第二套中药模型**：`zhong_yao`（参考镜像，自持）与 items-中药（既有内容链路）并存——与 ADR-0060 的名词双源同一取舍。换来「本草」不再被 items/channels/tcm_kind/通用 tcm-entry 链路层层叠加绑架；代价是概念上「中药」双源，未来若需统一须另行收敛。
- `zhong_yao` 复用 `content:yao:*`：管理既有 `yao` 板的角色同样能管理本草表，不新增授权边界；若日后需单独授角色，按 09 册 §3.3 四步加码。
- 新增 `zhong_yao` 须在 `manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 登记 `durable`，否则快照恢复报「未登记的表」（镜像 ADR-0060 后果 3）。
- 索引走点查/窄范围：`zhong_yao_name` + `zhong_yao_no`（UNIQUE）；172 行全表本身极小，但按 08 册规范不写无 WHERE 全扫路径。
- 迁移 0180 只播不覆盖：重导入新版本数据需另行 upsert 策略（当前无此需求，源数据一次性冻结）。

## 数据审计与异常核验（2026-11-04，全部实测量化）

对 `ctwh/ZhongYao.sql` 172 行 × 33 列做全字段审计（Python 按引号感知切分解析 SQL 元组；真 `tcmId` 用 tsx 隔离进程跑）。**所有结论均为「可以 / 不可以 / 有条件可以」，无模糊档。**

### 1. id 确定性（已预计算，无异常）

- **可以**。真 `tcmId('zhongyao', i)`（i=1→172 隔离进程顺序，BASE62 字母表 = `build.ts:143` 原文「0-9 → a-z → A-Z」小写在前）：172 个全 11 位、`unique 172/172`、格式异常 0；与 `tcmId('yao', 1..172)`（既有 items 中药 172 条 id）**碰撞 0**；与 `book_info` 0175 种子 10 个 + `ming_ci` 0179 种子 17 个已知 id **碰撞 0**。首 5：`nPX0b4roN6I`/`Olp8FryoXAT`/`8K7od2xmgdc`/`K3bgvbUz92K`/`fJ5v15FLIwj`；末 5：`rOrm7DMvX4Q`/`Jh8lfer2BJF`/`qrBUzF02nUj`/`KV0INr10GqQ`/`3GR3FwkZ13B`（全量 172 值已固化于 `.agent-tmp/zhongyao_ids.json`，迁移作者时逐值硬编码）。
- **纠正记录**：本 ADR 初稿曾用错误字母表（大写在前）跑出一套大小写模式不符的 id（首值 `Npx0B4ROn6i`），与真算法不符，**作废**——与 ADR-0060 审计 §1 的「纯 SHA-256 复刻产物作废」同类教训：id 必须逐字符对照 `build.ts` 原文，不得凭记忆复刻。
- **有条件可以**：kind='zhongyao' 与既有 'yao'/'mingci'/'chapter' 哈希输入不同，隔离进程首次调用即稳定；若日后并入 `build.ts` 主流程与其他 kind 同进程，须重核碰撞（与 ADR-0060 审计 §1 同一约束）。

### 2. 主键与序号（无异常）

- **可以**。`Id` 1–172 连续无空洞（`Id == 1..172` 逐项相等）；`YaoNo` 0–171 连续无重复。`zhong_yao_no` = `YaoNo`（唯一索引；create 走 `MAX+1`，next=172）。

### 3. 必填/可空与空列（无异常）

- **可以**。`YaoName`/`YaoText`/`IsEnable`/`SignatureId`/`Signature`/`CreateDate` **172/172 全非空**；`IsEnable` 全 1、`IsDelete` 全 0（软删语义干净）；`SignatureId` 172 非空且 172 唯一（列须可空，新录入行可为空）。
- **可以（空列判定）**：`YaoBieMing`/`OtherMark`/`ParentId`/`ExtJson`/`Extend01`–`12`/`OrgId` **全空**（0/172）——这些列物理删除无信息损失；`ModifyID`/`Modifier` 仅 15/172 有值且为源系统审计信息（`admin`/`1`），不入镜像。

### 4. 别名（zhong_yao_list，规则已定，无异常）

- **可以**。`YaoList` 非空 52/172，样例：半夏→`地文,水玉,守,示姑`、芍药→`白木,余容,犁食,解仓,铤`。逗号切分 + trim 后：104 token 全 distinct（无同名别名指向两药）、空元素 0、尾随逗号 0。映射规则：空→`'[]'`，否则 `JSON.stringify(split(',').map(trim))`（与 ming-ci `MingCiList` 同构）。

### 5. 名称唯一性（无异常）

- **可以**。`YaoName` raw 172/172 唯一，trim 后仍 172/172 唯一，**无需清洗**（对比 ming-ci 的 `畏\n` 脏点，本草源无此问题）。

### 6. YaoText 内容保真（1 条形态说明，无异常）

- **可以**。172/172 非空；`$u{药名}` 172 行全有、`$q{出处}` 168 行有（4 行无出处为纯短文本）；**无单引号转义对（`''` 0 处）、无其他反斜杠转义**（`\r\n` 之外反斜杠 0）——迁移 SQL 内嵌免额外转义。反斜杠序列只有 `\r`(x364) `\n`(x384)，无其他，解析为真实换行无歧义。
- **说明（勘误 2026-11-04）**：源 `\r\n`（反斜杠+r+反斜杠+n 四字符序列）168 行 + 独立 `\n` 4 行，是 MySQL dump 的转义序列。MySQL 导入时解析为真实 CR+LF。**原写「原样入库、不做解析还原」为错误口径**——后台 textarea / 未来 App 用 `whitespace-pre-wrap` 渲染，只有真实换行才显示换行，字面 `\r\n` 会原样显示。迁移须把 `\r\n`/`\n` 解析为真实换行（与 ming-ci 0179 存真实换行一致）。已实施并本地 D1 重放验证：168 行 CRLF + 4 行 LF = 172 行全有真实换行。
- 长度：min 17 / max 620 / 总 30512 字符——迁移单文件体积无风险（172 行 INSERT 约 45–55KB）。

### 7. 行尾空格（实测无，防御性规则）

- **可以**。`YaoText` 及全列**行尾空格 0 处**（对比 ming-ci 源 19 行有）。用户裁决 D4 仍写入迁移头部「数据变换」节作为防御性规则：若作者时实测出现，按 ming-ci 0179 先例 strip 行尾空白、不动可见字符。

### 8. 迁移体积与幂等（无异常）

- **可以**。`ZhongYao.sql` 全文件约 600KB 内（172 行）；0180 硬编码 172 行 INSERT 约 45–55KB，SQLite/D1 迁移单文件无体积风险（ming-ci 0179 17 行约 30KB 先例）。`INSERT OR IGNORE`（id 主键）重放安全，只播不覆盖。

### 9. zhong_yao_no 生成防撞

- 建 UNIQUE 索引 `zhong_yao_no_unique` + create 时事务内 `MAX(zhong_yao_no)+1`（seed max=171，next=172）；并发冲突走 UNIQUE 违反 fail-fast，不做静默合并（镜像 ADR-0060 审计 §10）。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 1. 扩展既有 `items` 补本草字段 | 正是要解的痛点：`items.data` JSON 已叠 `_microfeed.no`/`yaoNames`/`aliases`/`signatureId`，再加只会让「层层叠加」更严重，且改既有内容链路（含 App 读取），风险与收益不成比例 |
| 2. 替代 + 迁移：新建表并把 items-中药迁入、App 端点改读新表、废弃 `tcm_kind='yao'` 链路 | 用户裁决「并行共存、不迁移」；全量迁移涉及 App 端点改造 + 方剂 `fangYaoList.yaoId` 重新指向 + 429/别名逻辑重写，改动面与风险显著高于收益，留待独立重构 |
| 3. 仅代码层解耦（数据仍存 items.data，只抽 server/UI/API） | 不解决「数据模型仍被 items/channels 叠加」这个根因；用户要的是独立模型，不是代码目录重组 |
| 4. 本草建分组清单（镜像 ming-ci `mingci_groups`） | 源实体无分类字段（审计 §3：`ParentId`/`OtherMark`/`ExtJson` 全空），按首出处推导分组属伪造数据语义；用户裁决 D2 明确「无分组平铺、不伪造」 |
| 5. 本草建 App 端点 + `app:*:view` 新码 | 用户裁决 D3「本期不做」；App 中药数据流已由 items 承担，新端点属范围蔓延 |
| 6. 自造本草专用权限码 `content:bencao:*` | `content:yao:read`/`_MANAGE` 语义完全覆盖本草管理，加新码徒增三镜像同步面与授权边界；与 ADR-0060 决策 6「复用不加码」同一取舍 |

## 实施清单（确认后执行）

1. 生成 172 个真 `tcmId('zhongyao', 1..172)` 全量清单（隔离进程脚本，输出存 `.agent-tmp/`，迁移硬编码引用后删除临时脚本）。
2. 写 `migrations/0180_seed_zhong_yao.sql`：建表 + `zhong_yao_name` 索引 + `zhong_yao_no_unique` + 页面节点 `page_zhong_yao`（0177 新列序，`parent_code='group_content'`、`sort=113`、`entry_code='content:yao:read'`、icon `leaf`、`path='zhongyao'`）+ 172 行种子（**YaoText 的 MySQL 转义序列 `\r\n`/`\n` 解析为真实换行**，与 ming-ci 0179 一致；`zhong_yao_list` 按审计 §4 规则；头部写「数据变换」节）。**勘误（2026-11-04）**：原写「字面 `\r\n` 保真」为错误口径，已改。
3. 写 `src/shared/ZhongYao.ts`：`ZhongYaoEntry`/`ZhongYaoBoard` 类型 + `zhongYaoCreateSchema`/`zhongYaoUpdateSchema`（Zod，trim + max 约束；handlers 只 import 不定义）。
4. 写 `src/server/zhong-yao/types.ts`（`ZhongYaoDb`/`ZhongYaoRow`）、`store.ts`（`rowToAdmin`、list/insert/update/softDelete/purge、`MAX+1` 事务）、`handlers.ts`（board/create/update/delete/purge 五 handler，写侧校验走 shared schema）。
5. 写 4 个路由：`src/pages/[adminPath]/zhongyao/index.astro`、`…/ajax/zhongyao/index.ts`（GET 看板 / POST 新建）、`…/ajax/zhongyao/[zhongYaoId].ts`（GET/PUT/DELETE）、`…/ajax/zhongyao/[zhongYaoId]/purge.ts`；权限读 `CONTENT_YAO_READ`、写 `CONTENT_YAO_MANAGE`（形态照抄 ming-ci ajax）。
6. 写 `src/components/admin/zhong-yao/ZhongYaoApp.tsx`：**复用 `AdminTreeNavLayout` 两栏容器**（`nav` 槽放平铺列表 + 搜索「名称/别名」，`children` 槽放详情/表单：名称/别名/内容/启用；软删行灰显 + purge）——镜像 `MingCiApp` 的容器用法但**不引 `AdminGroupTree` 树组件**（无分组）。
7. `src/shared/AdminPageGuards.ts` 登记 `"zhongyao": PERMISSION_CODES.CONTENT_YAO_READ`。
8. i18n：`src/shared/i18n/zh-CN.ts` + `en.ts` 同批补 `zhongYao` 段落（字段标签/按钮/空态/确认语）与 `pageTitle`/`pageDocumentTitle`；不新增 `menu.icon.*` 键（leaf 已注册）。
9. `manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 登记 `zhong_yao`（durable）。
10. 写测试（**只写不跑**）：`tests/unit/zhong-yao-store.test.ts`、`tests/unit/zhong-yao-handlers.test.ts`（镜像 ming-ci 同位测试）。
11. 本 ADR 状态 Proposed → Accepted（实施完成后回填）。
12. 汇报改动文件清单；门禁（`git diff --check`、`yarn check` 等）留用户手动触发，AI 不跑。

## 落地物清单（2026-11-05 实施完成）

- **迁移**：`migrations/0180_seed_zhong_yao.sql`（建表 + `zhong_yao_name`/`zhong_yao_no_unique` 索引 + 页面节点 `page_zhong_yao` + 172 行种子）。
- **shared**：`src/shared/ZhongYao.ts`（`ZhongYaoAdmin`/`ZhongYaoInput`/`ZhongYaoBoard` + `zhongYaoCreateSchema`/`zhongYaoUpdateSchema`）。
- **server**：`src/server/zhong-yao/{types,store,handlers}.ts`（五 handler，单 `db` 通道，无 ming-ci 的 `groupsDb`）。
- **路由**：`src/pages/[adminPath]/zhongyao/index.astro` + `…/ajax/zhongyao/{index,[zhongYaoId],[zhongYaoId]/purge}.ts`（读 `content:yao:read` / 写 `content:yao:manage`，无 groups/reassign）。
- **UI**：`src/components/admin/zhong-yao/ZhongYaoApp.tsx`（复用 `AdminTreeNavLayout`，`nav` 槽平铺列表 + 搜索，无 `AdminGroupTree`）。
- **登记**：`AdminPageGuards.ts`（`zhongyao`）、`Constants.ts`（`ADMIN_MENU_CODES.ZHONG_YAO`）、`check-server-layout.ts` WHITELIST（`zhong-yao`）、`manage-cli/lib/snapshot.ts`（`zhong_yao` durable）、`StringUtils.ts`（`ajaxZhongYao*` 三助手）。
- **i18n**：`zh-CN.ts` / `en.ts` 同批补 `zhongYao` 段（30 键）+ `pageTitle`/`pageDocumentTitle`/`errors.zhongYao`；无新 `menu.icon.*`。
- **测试（只写不跑）**：`tests/unit/zhong-yao-{store,handlers}.test.ts`。
- **实施期修正**：本草 handler 是单 `db` 签名（无分组/来源书），照抄 ming-ci 路由时曾给 list/create/update 多传 `env.FEED_DB`，已逐一删去过参。
