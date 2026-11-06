# ADR-0060: 独立「名词」模块 `ming_ci`（参考 vol.api.sqlsugar BeiMingCi）

- 状态：Accepted（2026-11-04 设计并于同日会话实施完成；迁移 0177/0178/0179、`src/server/ming-ci/`、`src/shared/MingCi.ts`、`src/components/admin/ming-ci/`、`docs/ming-ci/` 均已落地；**2026-11-06 勘误**：决策 8 的 `ming_ci_list` 存储形态由 JSON 数组改为纯逗号文本、`MingCiName` 改为保留源尾随换行，见下）
- 日期：2026-11-04（设计/实施）/ 2026-11-06（勘误）
- 关联：ADR-0058（独立「书本信息」模块，本 ADR 的范式来源）、ADR-0059（书本信息分组树）、`docs/zh/admin-tree-nav-layout.md`（AdminTreeNavLayout 两栏布局）、`CONTEXT.md`（分组树词条）、参考项目 `D:\git\web\Vue.NetCore\vol.api.sqlsugar` 的 `SimpleEasy.Entity/DomainModels/ZhongYi/BeiMingCi.cs`、数据源 `ctwh/BeiMingCi.sql`

## 背景

后台已有一套「名词」概念，但它是**层层叠加进其他模块**的：名词 = `items` 行（`tcm_kind='term'`），叠加在通用条目表上；名词的来源书经 `items.book_id` 挂 `channels` 行；名词内容与别名/序号藏在 `items.data` JSON（`_microfeed.no`/`mingCiList`/`sourceImagePath`）；管理 CRUD 走**通用** `src/server/admin/tcm-entry-handlers.ts`（term/yao 共用，按 `action` 字段分发）；管理 UI 走**通用** `TcmEntryBoardApp`（term/yao 共用，`kind` prop）；App 读取（`src/server/tcm/reads.ts` `getAppAllTerms`）直接 `SELECT FROM items WHERE tcm_kind='term'`。

用户要的是**独立、干净的名词模型**，参考 vol.api.sqlsugar 的 `BeiMingCi` 实体（`MingCiNo`/`MingCiName`/`MingCiBeiMing`/`MingCiText`/`MingCiList`/`SoureBook`/`MingCiType`/`ShowImage`/`Remark`/`IsEnable`/`SignatureId`/`Signature`），**不考虑项目现有的 `items`/`channels` 纠缠**——即在既有名词机制之外，另立一张自持的 `ming_ci` 表，作为参考模型的名词镜像，不与 items/channels 复用或迁移数据。范式照抄 ADR-0058/0059（独立表 + settings 分组清单 + 后台双栏 UI + 种子迁移）。

## 决策

1. **新建独立表 `ming_ci`**，完整镜像参考 `BeiMingCi` 领域字段（去框架专属 `OrgId`/`ParentId`/`Extend*`/`ExtJson` 等，保留列位 `signature_id`/`signature`——App 签名链路保真，admin 不编辑）。按 microfeed 建表惯例：`VARCHAR(11)` 主键、`created_at`/`updated_at`、预留 `ext1`~`ext10`、软删除 `deleted_at`。**无状态枚举**——参考实体只有 `IsEnable`，故只留 `is_enable` 布尔，**不建 settings 状态清单**（对比 ADR-0058 的 `hot_book` + `book_info_statuses`，这是刻意取舍，非省略）。
2. **不与 `items`/`channels` 耦合**：不迁移既有数据、不改 `items.tcm_kind='term'` 行、不废弃既有名词链路。两套名词模型**并行共存**：`items`-名词（既有内容链路 + App 读取）与 `ming_ci`（参考模型镜像）各管各的，互不读写。
3. **来源书引用 `book_info.id`**（`source_book_id`，逻辑引用无硬外键）：`book_info` 自身已解耦（ADR-0058），故名词不触 `channels`/`items`。来源书下拉由 handler 从 `book_info` 加载（`SELECT id, book_name, book_no FROM book_info`）。
4. **分组清单存 `settings` KV**（`category='mingci_groups'`，`{groups:[{key,label,sort}]}`，整表覆盖写），与 ADR-0059 `book_groups` 同构。名词归属 = 自身 `ming_ci_type`（= 分组 `key`，NOT NULL + 必填）。**默认分组 = `ctwh/BeiMingCi.sql` 的 `MingCiType` 一次性冻结快照**（医理/药理/易理/通用，迁移 0178 播种），运行时不依赖任何源表。**校验为严格模式**（镜像 ADR-0059 `case_division`）：写侧 `ming_ci_type` 必填且取值须命中 `mingci_groups` 的 `key`，命中失败 = 400 fail-closed；**拒绝「游离值按原值回落」**（宽松是「游离分组」异常源，见数据审计 §5）。
5. **全栈模块**：按 `docs/zh/09-new-module.md` §2 十步落位——迁移 + `src/server/ming-ci/` + `src/shared/MingCi.ts`（Zod）+ `src/components/admin/ming-ci/` + `src/pages/[adminPath]/ming-ci/` + `src/shared/AdminPageGuards.ts` 登记 + `docs/ming-ci/` + 契约/运行时测试（**只写不跑**）。
6. **复用权限码，不加新码**：页面守卫复用既有 `PERMISSION_CODES.CONTENT_TERM_READ`/`_MANAGE`（`term` 页同码），在 `AdminPageGuards.ts` 登记 `"ming-ci"` 路由 → 该码；侧栏节点行（`ext_permission_nodes` `kind='page'`）随迁移 0177 播种（`page_ming_ci`，`entry_code='content:term:read'`，icon 复用 `tags` 免 `check-i18n.ts` 新图标双语标签）。
7. **后台 CRUD 面**：管理员 ajax 端点（`[adminPath]/ajax/ming-ci/`），读走 `loadMingCiBoard`（一次性返回 `{groups, sourceBooks, nouns}`，含已软删行 + `isDeleted` 派生），写走 create/update（合并式）/delete（软删）/purge（物删，仅已软删行）/groups（整表覆盖写）/reassign（删组前改派）。**无公共 api/v1**——名词是后台管理 + App 既有链路的数据，App 读暂走 items（决策 2 并行共存）；若日后 App 改读 `ming_ci`，按 OpenAPI 契约另立。
8. **数据导入**：`ctwh/BeiMingCi.sql` 17 行经迁移 `0179_seed_ming_ci_rows.sql` 播种（`INSERT OR IGNORE`，幂等）。id = `tcmId('mingci', MingCiNo)` 确定性 11 位（作者时预计算硬编码）；`SoureBook`→`book_info.id` 映射（9040000→`XNK0VFX39Xv`、400100→`OsOP62cyp3j`、1001000→`5IGM9t76quT`、20300000→`ghBqURJwurj`）；`MingCiType`→分组 `key`（医理→yili、药理→yaoli、易理→zhouyi、通用→tongyong）；**`MingCiList` 存纯逗号文本**（对齐 netcore `BeiMingCi.MingCiList` 原列，读取时按英文逗号切回 `string[]`）；**`MingCiName` 保留源原样（含「畏\n」的尾随换行）**，不做 trim。迁移 0179 只读文件于作者时，运行时不读文件。**id 必须用真 `tcmId`（`scripts/import-ctwh/build.ts:153`）在隔离进程按 `MingCiNo` 0→16 顺序预计算**；此前一次「纯 SHA-256 无碰撞加盐」的复刻产物（首值 `u7UiA44Otad`、末值 `z5GAvKzDZ52`）**与真算法不符，作废**。17 个真值（2026-11-04 实测，全 11 位 base62、互异、与 `book_info` 种子 10 个 id 无跨表碰撞）：`KXky0UUeJqt`/`vawJmMy1R6i`/`cyDmUmuDwd6`/`Z94SNqBdY3v`/`64OxeWGpLyA`/`eFJUTqNLZ9I`/`SB8YK29l3lb`/`q2PBuGxblo4`/`wcj0IVVNNmY`/`hew93S5np05`/`B7xDfBL5qeU`/`mOeRPbMyovF`/`fWye5mGxShN`/`NgyWBPZuFIj`/`wTgDQzVfGlL`/`42ZqG4162Cw`/`PV60LaP3pVS`（`MingCiNo` 0→16）。**勘误（2026-11-06）**：本条原写「`MingCiList` 逗号切 JSON 数组」「`MingCiName` 清尾随换行（源行「畏\n」）」——两处均偏离 netcore 源，已改：JSON 化会把残留单引号写成脏 token，trim 掉的是源数据本身。迁移 `0187` 把已部署库收回纯文本 / LF / 保留尾随换行（幂等，带前置条件）。

## 范围之外

- **不改 `items`/`channels`/`ext_*` 任何字段或语义**。`ming_ci` 是完全独立的新表，不动既有内容链路。
- **不迁移既有 `items` 名词**（`tcm_kind='term'`）：既有名词继续走 items，App 端点（`GetAllMingCi`/`getAppAllTerms`/`mingci-permission`）不动。`ming_ci` 从种子 17 行开始，供新录入/后续按需回填。
- **不实现 `BookChapter`/`BookChapterBody` 等章节/正文**：名词模块只管名词解释实体，不挂章节。
- **不建组织模块**：`signature_id`/`signature` 仅作列位保留（App 签名语义），不做外键。
- **不写 `docs/` 散文断言测试**；文档校验走 `yarn docs:check`（执行时机归 AGENTS.md「最高指令」）。

## 后果

- 出现**第二套名词模型**：`ming_ci`（参考镜像，自持）与 `items`-名词（既有内容链路）并存。这是**刻意取舍**——换来「名词」不再被 `items`/`channels`/`tcm_kind`/通用 tcm-entry 链路层层叠加绑架，代价是两处需要各自维护、概念上「名词」出现双源，未来若需统一须另行收敛（见被否决方案 1/3）。
- `ming_ci` 复用 `content:term:*`，意味着**管理名词的角色也能管理独立名词表**，但不新增授权边界；若日后需要「独立名词单独授角色」，再按 09 §3.3 四步加码。
- 新增 `ming_ci` 属 `SNAPSHOT_TABLES` 可登记范畴，须在 `manage-cli/lib/snapshot.ts` 登记 `durable`，否则快照恢复报「未登记的表」。
- 索引走点查/窄范围：`ming_ci_name`/`ming_ci_type`/`source_book_id` 建索引；避免全表扫描（09 §2 步 4 必查，量化见实施清单）。
- 来源书引用 `book_info.id` 为**逻辑引用**（无硬外键），删 `book_info` 行不级联——名词的 `source_book_id` 可能悬空，UI 下拉按「无来源书」回落显示（宽松校验）。

## 数据审计与异常核验（2026-11-04，全部实测量化）

对 `ctwh/BeiMingCi.sql` 17 行 × 37 列做全字段完整性 + 文本异常扫描（`ast.literal_eval` 解析 SQL 元组；真 `tcmId` 用 tsx 跑 `build.ts`），逐方向结论如下。**所有结论均为「可以 / 不可以 / 有条件可以」，无模糊档。**

### 1. id 确定性（致命异常，已修正）

- **结论：不可以沿用此前预计算值**。此前「纯 SHA-256 无碰撞加盐」复刻产物（首 `u7UiA44Otad`、末 `z5GAvKzDZ52`）与真算法不符：真 `tcmId("mingci", 0)` = `KXky0UUeJqt`（非 `u7UiA44Otad`）、`tcmId("mingci", 16)` = `PV60LaP3pVS`（非 `z5GAvKzDZ52`）。
- **可以（条件）**：必须用真 `tcmId` 在隔离进程按 `MingCiNo` 0→16 顺序预计算（决策 8 已列 17 真值）。真算法带 `idOwner` 碰撞加盐（salt 0–7），**id 依赖调用顺序**——只有「隔离进程、首次调用 `mingci:0..16`」才稳定成立；若日后并入 `build.ts` 主流程（与其他 kind 同进程），须重核。实测：17 个真 id 全 11 位 base62、`unique 17/17`、与 `book_info` 0175 种子 10 个 id **跨表碰撞 0**。

### 2. source_book_id 映射（无异常）

- **结论：可以**。`SoureBook` 只出现 4 值：`9040000`×8（伤寒论・人纪）、`400100`×7（神农本草经疏）、`1001000`×1（桂林古本）、`20300000`×1（灵枢）。4 个目标 id（`XNK0VFX39Xv`/`OsOP62cyp3j`/`5IGM9t76quT`/`ghBqURJwurj`）**全部命中** `book_info` 0175 种子（10 行内），无悬空、无缺失、无错配。**有条件可以**：`book_info` 行可软删（逻辑引用无外键），删书后名词 `source_book_id` 可能悬空——UI 按「未知来源」回落（ADR 已声明宽松校验，属设计取舍）。

### 3. ming_ci_type 分组（无异常，但校验须严格）

- **结论：可以**。`MingCiType` 只出现 4 值：医理 8 / 药理 7 / 易理 1 / 通用 1，**全部命中** 4-key 集合，无未知类型。迁移 0178 分组 key（yili/yaoli/zhouyi/tongyong）互异、无同名。
- **有条件可以**：写侧校验须**严格**（`ming_ci_type` 命中 `mingci_groups.key`，否则 400）。宽松「游离值回落」会产生不属于任何分组的游离类——**被否决**（与 ADR-0059 `case_division` 一致）。

### 4. ming_ci_list（无异常，规则已定）

- **结论：可以**。非空 5 行（`MingCiNo` 0/1/5/7/16），其余 12 行 NULL。仅 `MingCiNo` 16 为多元素（`肾阳虚,肾阴虚`→2 元素）；**无空元素、无尾随逗号**。映射规则：空/NULL→`''`，否则 `split(',').map(trim).join(',')`（存纯逗号文本；**勘误见决策 8**——原 JSON 数组写法会把残留单引号写成脏 token）。经 `.map(trim)` 后 17 行无一产生空串元素。

### 5. 必填/可空字段（无异常）

- **结论：可以**。`MingCiName`/`MingCiText`/`SoureBook`/`MingCiType`/`IsEnable` **17 行全非空**；`MingCiBeiMing`/`Remark` 全 NULL（可空）；`ShowImage` 15 NULL + 2 有值（可空）；`IsEnable` 全 1、`IsDelete` 全 0（软删语义干净）。`SignatureId` 17 非空且 17 唯一、`Signature` 17 非空（seed 全有；列须可空，新录入行可为空）。

### 6. MingCiName 清洗（1 处脏点，须处理）

- **结论：有条件可以**。`MingCiNo` 12 的 `MingCiName` = `畏\n`（`'畏\n'`，尾随换行），**须 `trim()`**。trim 后 17 名全唯一、无重复（raw 17 唯一、trim 17 唯一）。

### 7. MingCiText 内容保真（无异常，2 条规则）

- **结论：可以**。无空行（17/17 非空）；高亮标记 `$a{`×1 / `$m{`×20 / `$n{`×8 / `$x{`×1（共 30 处）**原样存储不解析**；**单引号 0 / 反斜杠 0 / CRLF 0**——迁移 SQL 内嵌**免转义**。
- **有条件可以（行尾空格）**：源 19 行含行尾空格（max 2 个，句号后「1–2 空格 + 换行」作换行标记）。这些空格虽属**数据内容**，但会物理命中 `git diff --check` 尾随空白红线，故迁移 0179 **按门禁要求 strip 行尾空格**（仅删物理行尾空白，不动句号等可见字符）；取舍与还原说明见 0179 头部「数据变换」节。若日后需逐行 `<p>` 还原换行，应改用显式标记而非行尾空格。
- 长度：min 4（`MingCiNo` 5 `乳房硬块`，与名称同文，源数据特征非异常）、max 1754（`MingCiNo` 16 肾虚）；总 4104 字符 / 10730 字节。

### 8. 迁移体积与幂等（无异常）

- **结论：可以**。`BeiMingCi.sql` 24468 字节（约 24KB），其中文本 10730 字节；0179 硬编码 17 行 INSERT 约 25–30KB，SQLite/D1 迁移单文件无体积风险。`INSERT OR IGNORE`（id 主键）重放安全，**只播不覆盖**（已存在行保留旧值，符合 book_info 0175）。

### 9. show_image 悬空（2/17，须降级）

- **结论：有条件可以**。2 行（`MingCiNo` 0 png、5 jpg）路径为参考项目 `Upload/Images/2024-11-*`，**实测不存在于 microfeed `public/`**。**保留原值**（源保真）+ UI 渲染须对不可达路径降级（alt 占位 / 隐藏），**不得**当作 microfeed 资产路径直链。

### 10. 分组空清单 / 删组 / ming_ci_no 生成（3 条新增约束）

- **分组空清单 fail-closed**：`mingci_groups` 为空时，**拒新增 + 拒改**（0 容错，与 book_info 状态清单一致），防「无分组可归属」的游离态。
- **删组前计数校验**：删除分组前 `COUNT(ming_ci WHERE ming_ci_type=key AND deleted_at IS NULL)`；**>0 拒删**或强制走 `reassign` 批量改派（当前 seed 计数：医理 8 / 药理 7 / 易理 1 / 通用 1）。
- **`ming_ci_no` 生成防撞**：建 UNIQUE 索引 + create 时事务内 `MAX(ming_ci_no)+1`（当前 max=16，next=17）；并发冲突走 UNIQUE 违反 fail-fast，不做静默合并。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 1. 扩展既有 `items` 补 BeiMingCi 字段 | 正是要解的痛点：`items.data` JSON 已叠 `_microfeed.no`/`mingCiList`/`sourceImagePath`，再加字段只会让「层层叠加」更严重，且改动既有内容链路（含 App 读取），风险与收益不成比例 |
| 2. 替代 + 迁移：新建表并把 items-名词迁入、App 端点改读新表、废弃 `tcm_kind='term'` 链路 | 用户本轮明确「不考虑项目 items/channels 等」；全量迁移涉及 App 端点改造与 `tcm_kind` 链路废弃，改动面与风险显著高于收益，留待独立重构 |
| 3. 仅代码层解耦（数据仍存 items.data，只抽 server/UI/API） | 不解决「数据模型仍被 items/channels 叠加」这个根因；用户要的是独立模型，不是代码目录重组 |
| 4. 名词建状态清单（镜像 book_info `hot_book`） | 参考 `BeiMingCi` 只有 `IsEnable`、无状态枚举；加状态清单是自行发明语义，违背「严格遵从参考」 |
| 5. 来源书存 `book_no`（文本） | `book_no` 可编辑、非稳定键；`book_info.id`（PK）才是稳定关系，且与 ADR-0058「来源书引用解耦模型」一致 |
