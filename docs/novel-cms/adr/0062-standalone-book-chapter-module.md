# ADR-0062: 独立「书本卷章」模块 `book_chapter` / `book_chapter_body`（参考 ctwh BookChapter / BookChapterBody）

- 状态：Accepted（2026-11-04 方案定稿并进入实施。**回写说明**：① 决策 6/10/11、后果、实施清单原「正文 8066 行走导入脚本、不进迁移，远程部署须手动跑 `--apply`」在执行期被用户裁定新增「**0186 部署种子迁移**」（deploy-anywhere 默认数据，`--emit-migration` 生成、确定性 id + 哨兵编码 + `INSERT OR IGNORE` 幂等、<80 KiB 分块）——本文档已按该裁定回写为合规例外；`--apply` 实写本地 D1 的路径不变。② 表结构正文 `id` 由 `randomShortUUID()` 改为**确定性 `'bc'`+9 位补零**（源顺序序号），与 0186 种子幂等。③ 卷章关联改读 0182 冻结映射 `scripts/import-ctwh/book-chapter-ids.json`，生成种子不再依赖本地 D1。④ 后台正文/注释编辑控件由 `AdminTextarea` 改为共享 `AdminMarkdownEditor`，只读详情的正文走 `MarkdownPreview` 渲染（编辑态与只读态同一份 Markdown 源码，存库口径不变）；⑤ 只读详情的注释块由 `SHOW_BODY_NOTE_IN_DETAIL` 开关隐藏（2026-11-06 用户裁定「仅隐藏、不删除」）——渲染代码、`section_note` 数据、编辑态注释编辑器与 i18n 键全部保留，开关置 `true` 即恢复展示；⑥ 只读详情的正文默认改**单行摘要**（首行截断 80 字符 + 行尾字面量 `.....`，2026-11-06 用户裁定「只显示一行，具体内容进入编辑查看」）——`SHOW_FULL_BODY_TEXT_IN_DETAIL` 保留 `MarkdownPreview` 全文渲染代码，置 `true` 即恢复；`sectionText` 数据、编辑态编辑器与存库口径均不变）；⑦ 2026-11-06 用户报「插入 `$a{}/$m{}` 后光标漂到结尾」「勾选预览后编辑器被拉宽」，经取证**两处均为共享控件 `AdminMarkdownEditor` 的缺陷**（工具栏按钮抢焦点 + 选区恢复用单次 `setTimeout(0)` 与第三方编辑器内部二次 state 竞态；根容器/预览容器缺宽度约束被 `pre`/`table` 的 `width:max-content` 撑开），非本模块页面代码、非 `wrapWithMarker`/`applyMarkdownAction` 纯函数。修复落在共享控件（所有 7 处复用方受益）+ 本弹层补 `grid-cols-[minmax(0,1fr)]` 锁死 Grid 隐式列；⑧ 「勾选预览后内容仍往右拉长」的真因是缩进代码块——正文里「空行 + 4 空格缩进」的行被 markdown 解析成不换行的 `<pre><code>`。修复：新增 `remarkNoIndentedCode` 插件把缩进代码块还原成普通段落（仅 `indentAsText` 开启的调用方生效，默认关闭以免污染 feed 等通用 Markdown 场景），book-chapter 编辑与只读 `MarkdownPreview` 均挂载；预览切换由原生 checkbox 改为共享 `AdminSwitch`）
- 日期：2026-11-04
- 关联：ADR-0060（独立「名词」模块，直接范式来源）、ADR-0058/0059（独立模块 + 分组树范式）、ADR-0061（独立「本草」模块 `zhong_yao`，本 ADR 的本草边界对照面）、`scripts/import-ctwh/`（导入惯例）、数据源 `ctwh/BookChapter.sql`（445 行卷章目录，10 本源书）+ `ctwh/BookChapterBody.sql`（8066 行正文）
- 用户裁决（2026-11-04）：D1 = 两表都纳入（卷章目录 + 正文，同批交付）；D2 = id（卷章目录 `randomShortUUID()`，即 0182 写死的随机 11 位；正文执行期改确定性 `'bc'`+9 位以支撑 0186 种子幂等；源 SignatureId/Signature 仅列位保留）；D3 = 新增 `content:book-chapter:read`/`_manage` 专属码；D4 = 来源书 `source_book_id → book_info.id`；D5 = 930 本草条目**保留在卷章模块不剥离**（选项甲）；D6 = **本期只做卷章存档，合并投影留二期**；D7 = **导入全格式保真、`\r\n` 换行/缩进/句号后空格/CR 一个都不丢**

## 背景

后台已有一套「卷章」概念，但它**层层叠加进通用条目链路**：小说/中医卷章 = `items` 行（`tcm_kind='chapter'/'section'`），挂在 `channels` 之下，父子走 `tcm_parent_id`，管理走通用 TcmEntryBoardApp / tcm-entry-handlers。改一处卷章展示要穿过 items/channel/ext_/口袋字段/缓存失效全链。

数据源 `ctwh/BookChapter.sql`（445 卷章目录）+ `ctwh/BookChapterBody.sql`（8066 正文）来自上游 `vol.api.sqlsugar` 的 `BookChapter`/`BookChapterBody` 实体。上游把「神农本草经」「神农本草经疏」等 10 本书存进这两张表，并用三个**挪用的框架字段**在运行时反向抽取本草药材（`IsEnable` override 成 `[Display(Name="本草")]` 判别式、`Extend01` 挪用成本草等级 `YaoEnum`、`BieMing` 挪用成药名+别名），本草模块每次取数现场 `Queryable<BookChapterBody>` 解析——正是用户所说「层层叠加」的教科书案例。

用户要的是**独立、干净的书本卷章模型**，在既有 items/channels 卷章机制之外另立两张自持表，范式照抄 ADR-0060（独立表 + 后台双栏 UI + 种子迁移）。

## 决策

1. **新建两张独立表 `book_chapter`（445 卷章目录）+ `book_chapter_body`（8066 正文）**，与既有 `items`(`tcm_kind='chapter'/'section'`)、`channels`、`book_info`、`ming_ci` **完全并行共存、互不读写、互不迁移**（照 ADR-0060/0061 解耦范式）。列名统一 snake_case + `created_at`/`updated_at`/`deleted_at`（软删）+ 预留 `ext1`–`ext10`。按量化审计砍死列：两表 ParentId 全空（删）、body 13 个全空列（删）、框架列 Extend02-12/ExtJson/CreateOrgId/CreateID/Creator/ModifyID/Modifier/OrgId（删）。
2. **`Extend01` 例外保留为显式列 `bencao_level`**（非一刀切关键）：其语义是本草等级 `YaoEnum`（'0'=正文/上经 545、'1'=别本 385），有真值且有联结价值，删之即把神农本草经的药材分类连根拔掉。同理 `BieMing` 保留语义（首段=药名）并派生 `bencao_yao_name`（药名联结键）。判别「是否本草条目」改用 `bencao_yao_name IS NOT NULL`（显式领域列），`is_enable` 回归「启用」本义。
3. **930 本草条目非一刀切处置（用户四点纠正后定稿）**：神农本草经(545)/经疏(385) 共 930 行 = 各自书的「卷章正文」忠实存档（选项甲），保留可联结列 `bencao_yao_name`/`bie_ming`/`bencao_level`。**不冗余回写 `zhong_yao`**（书里已有的药名/别名不重复存）、**不主动解析当药材喂本草**；药材主数据唯一真源仍是本草模块 `zhong_yao` 表。**合并只发生在二期 APP 返回的读侧投影层，按药名运行时 join，不物化。** 量化依据：930 条目去重药名 704，命中 `zhong_yao` 主数据 132，**书独有 572（81%）**，反向主数据独有 34 —— 两域互不为对方子集，必须「存档 + 运行时合并」，不能一方吞并另一方。
4. **排序键**：源 `ChapterSection` 跨书异构且杂乱（9040000 缺口 894960192、904000203 重复前缀污染），**绝不可作显示/排序键**。显示排序一律 `chapter_no`（create 走 `MAX+1`，UNIQUE 索引兜底 fail-fast）；`chapter_section` 保留仅作源保真可追溯，类型 `VARCHAR(64)`。正文排序走 `receipt_no`（同卷章内稳定有序）。
5. **无来源书硬外键**：`source_book_id → book_info.id` 逻辑引用（无 REFERENCES，下拉选书）；源 `BookName` 153/445 NULL → 另存只读历史列 `source_book_name`（缺失靠 book_info 书名兜底显示）+ `source_book_legacy_id`（源 BookId 可追溯）+ `source_chapter_legacy_id`（源 `BookChapter.Id` 可追溯，**正文导入脚本靠它把源 `BookChapterBody.BookChapterId` 映射到新卷章 id**）。
6. **全格式保真（D7，执行期铁律）**：导入**不 trim、不 strip、不归一换行、不折叠空白**。正文格式远比 ming-ci 丰富（SectionNote 1026 行前导缩进 + 549 行行尾空格 + 1214 行换行；SectionText 451 行行尾空格 + 392 行换行 + 4 行 CR）。依据：① 正文走**参数化导入脚本**逐行绑定 → 值不计入语句文本，不触发 `git diff --check`；② ChapterHeader 无换行、前后空格在物理行中 → 内联进迁移 0182 也不触发（红线只查物理行尾空白）。故两表零格式损失。**不沿用 0179「strip 行尾空格」**（那本身是丢格式微差）。导入脚本须字节级自检（逐行 LENGTH + LF/CR/前后空格/行尾空格计数与源全对齐，任一不符 fail-fast 中止）。**合规例外（执行期用户裁定，本文档回写）**：0186 deploy-anywhere 种子把正文写进 git 跟踪的迁移文件，文本 LF/TAB/CR 编码为 `@@NL@@`/`@@TB@@`/`@@CR@@` 哨兵、每条 VALUES 保持单物理行，运行时由 `replace(..., char(10/9/13))` 还原（见决策 11）——物理行尾不含空白，红线仍不触发；sqlite 重放逐行对账 8066/8066 零差异，LF 1267/16750、CR 19、前导缩进 37/1026、行尾空格 451/549 与源全对齐；格式自检另覆盖 `SectionVideoMemo→ext1`（非空 5 行、LF 3 行 29 字符、缩进 1、行尾空格 1、CR/TAB 0），并以全列 LF 字符总数 **18,046** 兜住新增文本列。
7. **全栈模块 + 命名三形态**（照 ADR-0061 决策 6）：迁移 + `src/server/book-chapter/` + `src/shared/BookChapter.ts`（Zod 真源）+ `src/components/admin/book-chapter/` + `src/pages/[adminPath]/book-chapter/`。**`book_chapter`**（下划线）= DB 表名/列名；**`book-chapter`**（连字符）= 文件系统目录 + `AdminPageGuards` key；**`book_chapter`**（下划线）= `ADMIN_MENU_CODES.BOOK_CHAPTER` + `ext_permission_nodes` 页面节点 id `page_book_chapter`。类型大驼峰 `BookChapter*`。
8. **新增专属权限码 `content:book-chapter:read`/`content:book-chapter:manage`**（执行期修正，三镜像同步：`Constants.ts` + `rbac/seed.ts` + 迁移 `ext_permissions`）。**不沿用方案初稿的 `content:chapter:read/manage`**——`content:chapter:*` 已被既有小说章节机制占用（`Constants.ts:276-279`、`rbac/seed.ts:67-70`、feed/items/search/api-permissions/pc-interfaces 全在用），`content:book:*` 被 book-info 占用；`content:book-chapter:*` 连字符合法（先例 `content:book-status:manage`）且未被占，与路由 `book-chapter` 同源、授权边界独立。页面节点 `pn_page_book_chapter`（`path='book-chapter'`、`entry_code='content:book-chapter:read'`、`parent_code='group_content'`、sort=114、icon 复用 `book`）。两码默认授予 editor。
9. **后台 CRUD 面 + 正文 CRUD**：ajax 端点 `ajax/book-chapter/{index,[chapterId],[chapterId]/purge,bodies}`，读走 `content:book-chapter:read`、写走 `content:book-chapter:manage`，**不进 OpenAPI**、不在 exempt 名单（同 ming-ci）。选中卷章在右栏编辑其正文（`bodies` 正文 CRUD）。删除两步：软删/物删（物删仅已软删行）。
10. **正文导入脚本 `scripts/import-ctwh/import-chapter-body.mjs`**（对齐既有 `import-yao.mjs`/`import-term.mjs`/`import-fangyao.mjs` 惯例）：全量 8066 行（含 930 本草 + 7136 经典，**严禁只导 IsEnable=1**，否则丢 7136 经典正文）。源 Id(1..8066) 不复用，正文新 id = **确定性 `'bc'`+9 位补零**（源顺序序号，11 字符），与 0186 种子逐字节一致、重放幂等；卷章关联读 **0182 冻结映射 `scripts/import-ctwh/book-chapter-ids.json`**（源 Chapter Id → 新 id，445 条），生成种子不依赖本地 D1。派生 `bencao_yao_name`=BieMing 首逗号段、`bencao_level`=Extend01、FangJi 空串→NULL 归一、SectionVideoMemo→ext1。带量化自检（行数=8066 / book_chapter_id 0 悬空 / 标记计数 `$a{`265·`$m{`34·`$n{`36·`$x{`49·`$r{`0 / 本草派生列 930-704-132 / 格式保真 392·1214·4 行 19 字符·1026·37·451·549 / ext1 5 行·LF 3 行 29 字符 / 全列 LF 18,046 / 哨兵 0 冲突 / id 唯一 / 单条 <80 KiB）任一不符 fail-fast。**卷章目录 445 行进迁移 0182 种子，正文 8066 行进迁移 0186 种子**（**合规例外（执行期用户裁定，本文档回写）**：原决策「正文只走导入脚本」被新增 `migrations/0186_seed_book_chapter_body.sql` deploy-anywhere 种子取代——部署到任何位置都自带同一份 8066 行，与源库逐字节一致。该迁移由 `--emit-migration` 生成（非手写），id 写死、`INSERT OR IGNORE` 幂等、按 <80 KiB 分块、文本哨兵编码保持单物理行。**注意**：0186 用 `INSERT OR IGNORE`（幂等种子），与 `--apply` 实写本地 D1 的 `INSERT OR REPLACE` + 先清空重建语义**刻意区分**——两者 id 同构、互不冲突）。
11. **种子迁移分批发语句（D1 单语句上限）**：D1 单条 SQL 语句的字面量上限是 **100,000 字节**（`docs/agents/d1-sync.md`，本地实测 75KB 通过、135KB 报 `SQLITE_TOOBIG`）。0182 的 445 行若拼成一条 INSERT 达 **96,717 字节**（余量 3.3%），故按**每 60 行一条 INSERT** 拆成 8 条语句，单条最大 **13,843 字节**（留 7 倍余量）。生成脚本 `gen-0182.mjs` 带生成期硬断言（单条 >32KB 直接报错），并把 445 个「源 Id → 新 id」冻结到 `scripts/import-ctwh/book-chapter-ids.json`，保证重跑生成结果逐字节一致。0186 正文合计文本 **3,285,170 B（3.13 MB）/ 最长单行 10,673 B**，按累计字节 **<80 KiB 分块**拆成 **64 条 INSERT**（文件 5,113,579 B，单条最大 **81,842 B**、平均 **79,883 B**；口径为每条 `INSERT OR IGNORE …;` 语句本体的 `Buffer.byteLength`，含列名前缀与 VALUES，`split(";")` 那种把分隔换行/头注释混入的切法会得出 76,655 B，勿混用），生成期硬断言单条 >80 KiB 直接报错，并禁止文件含字面 CR 与行尾空白；哨兵让每条 VALUES 保持单物理行。`--apply` 的参数化绑定（`?` 占位与绑定值不计入语句文本长度）不受此限。同批 zhong-yao 0180 亦为 22 条语句（含 19 条 INSERT，单条最大 8,645 字节）。

## 范围之外

- **不改 `items`/`channels`/`ext_*` 任何字段或语义**；不迁移既有 `tcm_kind='chapter'/'section'` 行；`tcm_parent_id`/`book_id` 语义不动。
- **不动 `zhong_yao` 表**（本草 ADR-0061）：不回写、不读、不迁移。卷章 ↔ 本草互不伸手，唯一同时看到两域的是二期合并投影层。
- **本期不建合并投影端点**（用户裁决 D6）：无 APP 药材合并视图、无 `app:*:view` 新码。合并留二期，归属（本草新建 App 端点 vs 改既有 items 中药读取层）二期启动时再裁决。
- `signature_id`/`signature` 仅列位保留（App 签名语义），不做唯一约束、不作 ETag、admin 不编辑。
- 不写 `docs/` 散文断言测试；文档校验走 `yarn docs:check`（执行时机归 AGENTS.md「最高指令」）。

## 后果

- 出现**第二套卷章模型**：`book_chapter`/`book_chapter_body`（自持）与 items-卷章（既有内容链路）并存——与 ADR-0060/0061 的双源同一取舍。换来卷章不再被 items/channels/tcm_kind/通用 tcm-entry 链路层层叠加绑架。
- 新增 `content:book-chapter:*` 两码：与既有小说章节 `content:chapter:*` 授权边界独立，避免「书本卷章」与「小说章节」权限混为一谈。
- 新增 `book_chapter`/`book_chapter_body` 须在 `manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 登记 `durable`，否则快照恢复报「未登记的表」（镜像 ADR-0060/0061 后果）。
- 正文 8066 行进迁移 0186 种子：新部署 `apply` 迁移即自带同一份 8066 行，无需手动跑 `--apply`（`--apply` 仅供本地开发实例重建/逐行对账）。代价是仓库多一个 5.1 MB 的生成文件，且该文件须由生成器产出、勿手改。
- 索引走点查/窄范围：`book_chapter_id`（按卷章取正文防全表扫）、`(book_chapter_id, receipt_no)`、`bencao_yao_name`（二期合并点查，仅 930 行非空）、`chapter_header`/`source_book_id`/UNIQUE `chapter_no`。
- 迁移只播不覆盖：0182 / 0186 均 `INSERT OR IGNORE`，重导入新版本数据需另行 upsert 策略（当前源数据一次性冻结）。

## 数据审计与异常核验（2026-11-04，全部实测量化）

> 审计方式：两 dump 导入本地 SQLite（零误差 445/8066，列头 BookChapter=32 / BookChapterBody=47），逐列核查。脚本 `.scratch/book-chapter-module/{import_to_sqlite,audit1,audit2,audit3,analyze-yao-overlap,analyze-reverse-gap,audit-format-fidelity,audit-newline-cols,audit-strip-impact}.py`。**所有结论均为「可以 / 不可以 / 有条件可以」，无模糊档。**

### 1. 主键/序号/引用（健全）

- **可以**。chapter Id 445 唯一、body Id 8066 唯一；body.BookChapterId 100% 非空、0 悬空；两表 IsDelete 全 0（无软删痕迹）；CreateDate 100% 非空、0 格式不符。
- **SignatureId** chapter 445 全唯一 / body 8066 全唯一 / 跨表交集 0、长度全 15 → 列位保留安全。
- **ReceiptNo** 8066 全唯一、同卷章内 0 重复 → 卷章内稳定排序键。

### 2. 必须处理的异常（逐条定案）

- BookName 153/445 NULL（34.4%）→ 不能依赖源 BookName，走 `source_book_id`，历史列允许 NULL。
- ChapterSection 跨书异构（缺口 894960192、904000203 污染）→ **不可排序**，仅追溯列。
- ParentId 两表全空 → 删 `parent_id`，UI 平铺。
- body 12 领域字段全空 → 删；SectionVideoMemo 5 行 → ext1。
- FangJi 三态（真实 1339/空串 4435/NULL 2292）→ 导入 `''→NULL` 归一，逗号多值（半角 202/全角 6）UI 兼容。
- IsEnable 分布割裂（chapter 343/102、body 930/7136）→ **全量导入含禁用**，严禁只导 IsEnable=1。
- Signature 非唯一（415/445、8037/8066 有重复 + NULL）→ 仅列位保留，不作约束/ETag。
- ChapterHeader 14 行含 `$a{}` 标记 → 原样存储不解析，UI 降级文本。
- body 无正文卷章 16 个（金匮要略宋版后半，16/16 禁用）→ 源刻意预留空壳，原样导入。
- 510 行 body 启用却属禁用卷章 → 按行独立存 `is_enable`，不继承卷章态。

### 3. 格式保真（D7 量化，执行铁律）

- 真实换行 LF：SectionText **392 行**、SectionNote **1214 行**、SectionVideoMemo 3 行、chapter.OtherMark 4 行（OtherMark 已删）。
- 真实 CR：**19 处字面 `\r` 转义解码后全落 SectionText 4 行**（dump 文件本身 8066 行 CRLF 行尾是文件分隔符、非内容，解码须区分）。
- 前导缩进：SectionNote **1026 行**、SectionText 37 行、ChapterHeader 6 行。
- 行尾空格（源把「句号后 1–2 空格 + 换行」当换行标记，故行尾带空格；实测口径 `col != RTRIM(col)`）：SectionText **451 行**、SectionNote **549 行**；ChapterHeader 4 行。
- **全格式保真、不 strip**（推翻 0179 先例），导入脚本字节级自检见决策 6/10。

### 4. 930 本草药名重合度（非一刀切量化支柱）

- 930 条目去重药名（BieMing 首逗号段）= **704**；命中 `zhong_yao` 主数据（173）= **132**；主数据没有、仅书里有 = **572（81%）**；反向主数据 173 里书内找不到 = **34**（去污染后）。
- 结论：两域互不为对方子集 → 必须「存档 + 运行时合并」，不能一方吞并另一方。

## 实施清单（执行中）

1. 迁移 0181 建 `book_chapter`+`book_chapter_body` 两表 + 索引 + 权限码三镜像 + 页面节点（sort=114）。
2. 迁移 0182 播种 BookChapter 445 行全量（含 102 禁用，id 从冻结表读取、`source_chapter_legacy_id` 存源 Id，ChapterHeader 全格式保真不 strip）；**每 60 行一条 INSERT（8 条语句，单条 ≤13.8KB）**，不拼成一条巨型语句。
3. `src/shared/BookChapter.ts` schema 真源（含 body 5 内容字段 + 2 本草可联结列）。
4. `src/server/book-chapter/{types,store,handlers}.ts`（照抄 ming-ci 分层）。
5. ajax 端点（含 bodies 正文 CRUD）+ Constants + rbac/seed + AdminPageGuards + StringUtils + i18n + 页面守卫接线。
6. `BookChapterApp.tsx` UI（AdminTreeNavLayout 双栏）。
7. 正文导入脚本 `import-chapter-body.mjs`（全量 8066、全格式保真、量化自检）+ `--emit-migration` 生成 `migrations/0186_seed_book_chapter_body.sql` 部署种子（哨兵编码 / <80 KiB 分块 / 幂等）。
8. `manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 登记 `book_chapter`/`book_chapter_body`（durable）。
9. 测试对标 `tests/unit/book-chapter-{handlers,store}.test.ts`（**只写不跑**，门禁由用户手动触发）。
