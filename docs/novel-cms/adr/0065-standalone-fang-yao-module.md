# ADR-0065: 独立「方剂」模块 `fang_yao` / `fang_yao_body`（参考 ctwh FangYao / FangYaoBody）

- 状态：Accepted（2026-11-05 方案定稿 + P1/P2/P3 已裁定 + 实施完成并过双轴 code-review 与门禁。**回写说明**：① 决策 4/9、后果、D1 附录、实施清单原「方 804 + 组成 2025 均走导入脚本、不进迁移」在执行期被用户裁定新增「**0185 部署种子迁移**」（deploy-anywhere 默认数据，`--emit-migration` 生成、确定性 id + 哨兵编码 + `INSERT OR IGNORE` 幂等、<80KB 分块）——本文档已按该裁定回写为合规例外；`--apply` 实写本地 D1 的路径不变。② 表结构 `id` 列由 `randomShortUUID()` 改为**确定性 `'fy'`/`'fb'`+9 位补零**（源 Id / 源顺序序号），与 0185 种子幂等、导入对账可追溯。③ `show_name` 列由 `VARCHAR(64)` 收紧为 `VARCHAR(64) NOT NULL`（源 2025/2025 非空），Zod 同步收紧 `nonEmptyPreservingText(64)`。④ `yao_count` 读侧 COUNT 只数**未软删**组成（软删不计数，与 `countBodiesByFang` 含软删语义刻意区分））
- 日期：2026-11-05
- 关联：ADR-0062（独立「书本卷章」模块，**本 ADR 的直接范式来源**）、ADR-0060/0061/0064（独立模块解耦系列）、`scripts/import-ctwh/`（导入惯例）、数据源 `ctwh/FangYao.sql`（804 行方剂）+ `ctwh/FangYaoBody.sql`（2025 行组成）、书名映射源 `ctwh-books/books.json`（13 本书清单）
- 用户裁决（2026-11-05）：
  - **F1 = 书源组显示名走"源库反查"**（导入期从 `ctwh-books/books.json` 的 `bookNo → name` 派生 `source_book_name` 只读历史列，不 join `book_info`）
  - **F2 = 新增专属权限码 `content:fang-yao:read` / `content:fang-yao:manage`**（方剂独立授予，不复用 `content:book-chapter:*`）
  - **F3 = 本期只出方案文档，不实施**
  - **F4（2026-11-05 补）= 方案须对每个可能出现数据不完整 / 异常的方向做量化核准，不可模糊处理**

> **执行期待用户拍板的 3 处** —— **已于 2026-11-05 全部裁决定稿**（完整展开见文末「§P1/P2/P3 决策」）：
> - **P1 = 源排序键 `FangNo` 组内重复 → 采甲：`fang_no` 改系统托管组内连续序号，不加源值追溯列**（正确归属到对应书源组即可）。
> - **P2 = 373 个源无组成的方（46.4%）→ 全量导入 804**。
> - **P3 = 源格式瑕疵 → 原样保真，但 `FangText` 花括号 `{}` 不配平的 15 方导入时修正配平，其余一律不改。**

## 背景

后台已有 5 个按 ADR-0058~0064 范式落地的独立中医内容模块（book-info / ming-ci / zhong-yao / book-chapter / yao-alia），各自持独立表、独立 server 目录、独立 ajax 端点、独立后台 App，**与通用 `items`/`channels` 条目链路并行共存、互不迁移**。这是本仓库解决「层层叠加」的既定解耦范式。

方剂（`FangYao` = 方，`FangYaoBody` = 方的药味组成）是同一上游 `vol.api.sqlsugar` 体系里的**又一个内容域**。若沿用旧路，方剂会被塞进 `items`（`tcm_kind`）或挂在 `book_chapter_body`（正文语义）之下，重演"改一处方剂展示要穿过 items/channel/口袋字段全链"的叠加问题。

**方剂与本草卷章的形态差异（决定不能套用 `book_chapter_body` 语义）**：

| | 本草 `book_chapter` → `book_chapter_body` | 方剂 `FangYao` → `FangYaoBody` |
|---|---|---|
| 父子关系 | 卷章 → 正文叙事 | 方 → **结构化药味组成清单** |
| 子行语义 | `SectionText` 长正文 | `ShowName`/`Amount`/`ExtraProcess`/`Weight`（一味药一行） |
| 叙述文本位置 | 子表（正文） | **父表**（`FangText` 方文，含 `$f{}`/`$u{}`/`$w{}` 标记） |

把"药味组成"塞进"正文叙事"表会污染语义并触发 ADR-0062 §0.2 第 3 条「为兼容写 `if(isXxx)` 特例分支 = 扩展失败」。故独立新建两张自持表。

## 决策

1. **新建两张独立表 `fang_yao`（804 方）+ `fang_yao_body`（2025 组成行）**，与 `items`/`channels`/`book_info`/`ming_ci`/`zhong_yao`/`book_chapter`/`yao_alia` **完全并行共存、互不读写、互不迁移、零共享外键**（照 ADR-0062 解耦范式）。列名 snake_case + `created_at`/`updated_at`/`deleted_at`（软删）+ 预留 `ext1`–`ext10`。按量化审计砍死列：源 `FangList`（全空）、`ParentId`（两表全空）、body 的 11 个中药学临床域全空列（`SectionText`/`SectionTerm`/`JingMai`/`TeDian`/`ShiCi`/`ShiYi`/`Notes`/`ZhuZhi`/`ZhenJiu`/`AiJiu`/`PeiWu`，属中药学域不属方剂域）、框架列 `Extend01-12`/`ExtJson`/`CreateOrgId`/`CreateID`/`Creator`/`ModifyID`/`Modifier`/`OrgId`（删，`SignatureId`/`Signature` 例外保留列位）。

2. **排序键 `fang_no`（组内 MAX+1）+ 组成 `position`（方内 MAX+1）**：源 `FangNo` **实测存在组内重复 + 跨书分段重叠，不可直接作唯一排序键**（量化见 §数据审计 B/H/I：1001000 组内重复 1 处 = 源 Id 481「五苓散」与 507「甘草干姜汤」同为 FangNo 397；跨书分段重叠，如 10002=[0,201] 与 9040000=[202,684]、1001000=[342,683] 交错）。故 **采 P1 甲：`fang_no` 改系统托管组内连续序号**（导入按源顺序组内重排 1..N，不含源 FangNo 值、不设源值追溯列），`UNIQUE(source_book_legacy_id, fang_no)` 成立、admin 新建走组内 `MAX+1`。组成行 `position` = 方内 `MAX+1`，`UNIQUE(fang_yao_id, position)` 防导入重放翻倍（源 body Id 唯一 2025/2025，方内无重复药名除 1 处，见 §N1）。

3. **无来源书硬外键、不 join `book_info`（解耦关键，F1）**：方剂 5 个 `FangSourceBookId` 是源系统 int64，**不在 `book_info` 的 11 位 id 体系内**（`book_chapter` 才 join `book_info`）。方剂书源组由 `source_book_legacy_id` 派生，导入期反查 `ctwh-books/books.json` 的 `bookNo → name` 存只读历史列 `source_book_name`。**树第一层不依赖任何既有模块的表**。

4. **全格式保真（照 ADR-0062 决策 6 / D7，执行期铁律）**：`FangText` 经**正确解码 SQL 转义序列**后实测：**790/804 方含真实换行 `\n`**（dump 里的字面 `\n` 转义共 2082 处，全部落在 FangText 列、其它列 0 处；解码后即真实 LF）、401 方含制表符 `\t`、0 方含 `\r`。标记共 **9 种单字母**：`$u{`(4053) `$w{`(3634) `$f{`(332) `$s{`(227) `$m{`(217) `$a{`(68) `$q{`(41) `$n{`(16) `$g{`(3)，**全部为 `$单字母{` 形态、无 `$x{` 等多字母或裸 `${`（潜在解析陷阱 0 方）**，原样存储不解析（同 ming-ci 的 `$m{}`/`$n{}` 处置）。`fang_text` 走**参数化导入脚本、不进迁移 SQL**（**合规例外**：`migrations/0185_seed_fang_yao_data.sql` deploy-anywhere 种子——由 `--emit-migration` 生成，LF/TAB/CR 用 `@@NL@@`/`@@TB@@`/`@@CR@@` 哨兵编码、运行时 `replace(..., char(10/9/13))` 还原，文件保持单物理行，见决策 9）→ 内容不进 git 跟踪文件 → 不触发 `git diff --check`。导入脚本**必须先解码 SQL 字符串转义（`\'`→`'`、`\\`→`\`、`\n`→LF、`\t`→TAB）再逐字节比对**，字节级自检（逐行 LENGTH + LF/TAB/前导缩进/行尾空格计数与解码源全对齐，任一不符 fail-fast）。**注**：初稿曾因解析器未解码转义误判「FangText 含换行 0/804」，已由 §数据审计 Z 系列纠正——这是导入脚本自检必须以解码后字节为准的实证。

5. **`yao_count` 实时派生、不落列**：味数从组成行 `COUNT(fang_yao_body WHERE fang_yao_id=?)` 读侧计算，不物化存储 → 编辑组成后永不陈旧。源 `YaoList`（430/804 非空，逗号串）存 `yao_list` 只读历史列（空串→NULL 归一），不作真源。

6. **全栈模块 + 命名三形态**（照 ADR-0061/0062 决策 7）：迁移 + `src/server/fang-yao/` + `src/shared/FangYao.ts`（Zod 真源）+ `src/components/admin/fang-yao/` + `src/pages/[adminPath]/fang-yao/`。**`fang_yao`**（下划线）= DB 表/列名；**`fang-yao`**（连字符）= 文件系统目录 + `AdminPageGuards` key；**`fang_yao`**（下划线）= `ADMIN_MENU_CODES.FANG_YAO` + `ext_permission_nodes` 页面节点 id `page_fang_yao`。类型大驼峰 `FangYao*`。

7. **新增专属权限码 `content:fang-yao:read` / `content:fang-yao:manage`（F2）**，三镜像同步（`Constants.ts` + `rbac/seed.ts` + 迁移 `ext_permissions`）。`content:fang-yao:*` 连字符合法（先例 `content:book-status:manage`、`content:book-chapter:*`）且未被占，与路由 `fang-yao` 同源、授权边界独立。页面节点 `pn_page_fang_yao`（`path='fang-yao'`、`entry_code='content:fang-yao:read'`、`parent_code='group_content'`、icon 复用 `book`、sort 排在 `book_chapter` 之后）。两码默认授予 editor。加码走 09 册 §3.3 四步（人加 Constants → `yarn rbac:gen` → 人填中文短名「方剂查看」/「方剂维护」再跑一次 → 人补 `RbacPermissionDocs.ts` 长说明）。

8. **后台 CRUD 面 + 组成 CRUD**：ajax 端点 `ajax/fang-yao/{index,[fangId],[fangId]/purge,[fangId]/bodies,body/[bodyId],body/[bodyId]/purge}`（6 个，镜像 book-chapter），读走 `content:fang-yao:read`、写走 `content:fang-yao:manage`，**不进 OpenAPI**、不在 exempt 名单（同 ming-ci/book-chapter）。选中方在右栏编辑其组成清单。删除两步：软删/物删（物删仅已软删行；方下有组成则物删拒绝）。

9. **导入脚本 `scripts/import-ctwh/import-fangyao.mjs`**（对齐 `import-chapter-body.mjs`/`import-yao.mjs` 惯例）：全量 804 方 + 2025 组成行（**严禁只导 `IsEnable=1`**，与本草同理全量导入含禁用）。源 Id 不复用，新 id=`randomShortUUID()`；组成关联靠 `fang_yao.source_fang_legacy_id`（存源 `FangYao.Id`）把源 `FangYaoBody.FangId` 映射到新方 id。派生 `source_book_name`（反查 books.json）、`FangList` 弃、`FangdrinkNum` 空串→NULL、`Amount`/`ExtraProcess`/`Weight` 空串→NULL。带量化自检（行数 804/2025、`fang_yao_id` 0 悬空、标记计数 `$f{`/`$u{`/`$w{`、书源组 5 组、书名 5/5 命中、格式保真计数）任一不符 fail-fast。**方 804 + 组成 2025 均走导入脚本，不进迁移**（`FangText` 最大 3844 字符，且保格式保真）。**合规例外（执行期用户裁定，本文档回写）**：新增 **`migrations/0185_seed_fang_yao_data.sql` deploy-anywhere 种子迁移**——部署到任何位置都自带同一份 804 方 + 2025 组成（与源库逐字节一致）。该迁移由 `import-fangyao.mjs --emit-migration` 生成（非手写），id 写死为确定性 `'fy'`+9 位 / `'fb'`+9 位补零、`INSERT OR IGNORE` 幂等、按 <80KB 分块（D1 100KB 上限）、文本 LF/TAB/CR 用哨兵编码保持单物理行。**注意**：0185 用 `INSERT OR IGNORE`（幂等种子），与 `--apply` 实写本地 D1 的 `INSERT OR REPLACE` + 先清空重建语义**刻意区分**——两者 id 同构、互不冲突。

## 目标表结构

### `fang_yao`（源 → 目标列映射）

| 目标列 | 类型 | 源列 | 说明 |
|---|---|---|---|
| `id` | VARCHAR(11) PK | — | **确定性 id** = `'fy' + 源 Id 9 位补零`（如 `fy000000001`，共 11 字符）；源 Id(1..809 含 5 缺口) 不复用其值、但复用作 id 后缀，保证 0185 种子与 `--apply` 重放**幂等可追溯** |
| `fang_no` | INTEGER NOT NULL | — | **组内连续序号，系统托管**（P1 甲：导入按源顺序组内重排 1..N，不含源 FangNo 值；admin 新建走组内 MAX+1） |
| `fang_name` | VARCHAR(255) NOT NULL | `FangName` | 必填（maxlen 16）；**跨书同名 219 名/588 行，不做唯一约束** |
| `source_book_legacy_id` | VARCHAR(64) | `FangSourceBookId` | 只读追溯（如 10001） |
| `source_book_name` | VARCHAR(255) | — | **导入派生书名**（反查 books.json），只读历史 |
| `source_fang_legacy_id` | VARCHAR(64) | `Id` | 源方 Id（1..809 含 5 缺口），组成导入的映射键 |
| `yao_list` | TEXT | `YaoList` | 药味逗号串（430/804 非空），空串→NULL，**只读历史非真源** |
| `fang_text` | TEXT NOT NULL | `FangText` | 方文，9 种标记/换行(790 方)/制表(401 方)字节级保真不解析 |
| `fang_drink_num` | VARCHAR(64) | `FangdrinkNum` | 服数（803 非空）；**含小数 `1.5` 与 NULL 各 1，故用 VARCHAR 非 INTEGER** |
| `is_enable` | INTEGER NOT NULL DEFAULT 1 | `IsEnable` | 行级展示开关 |
| `signature_id` / `signature` | VARCHAR(64) | 同名 | 列位保留，admin 不编辑，不作 ETag |
| `created_at` / `updated_at` / `deleted_at` | TIMESTAMP | — | `deleted_at` 软删（源 IsDelete 全 0） |
| `ext1`..`ext10` | VARCHAR(255) | — | 建表即预留 |

索引：`fang_yao_no_unique`（UNIQUE `source_book_legacy_id`+`fang_no`，P1 甲下成立）、`fang_yao_name`、`fang_yao_source_book`、`fang_yao_source_legacy`（UNIQUE，导入映射键）。

### `fang_yao_body`（源 → 目标列映射）

| 目标列 | 类型 | 源列 | 说明 |
|---|---|---|---|
| `id` | VARCHAR(11) PK | — | **确定性 id** = `'fb' + 9 位补零序号`（按源文件出现顺序 1..2025，如 `fb000000001`）；源 body Id（含 2 行 snowflake int64 >2^53，JS Number 丢精度）不复用，故按出现顺序编号 |
| `fang_yao_id` | VARCHAR(11) NOT NULL | `FangId` | 逻辑引用 `fang_yao.id`，导入脚本经 `source_fang_legacy_id` 映射 |
| `position` | INTEGER NOT NULL | — | 方内 MAX+1 排序 |
| `show_name` | VARCHAR(64) NOT NULL | `ShowName` | 药名（maxlen 11） |
| `amount` | VARCHAR(255) | `Amount` | 剂量（2018 非空，7 空）；**22 行内嵌 `$x{}` 加减标记，原样保真不解析**，故列宽留 255（实测 maxlen 58） |
| `extra_process` | VARCHAR(64) | `ExtraProcess` | 炮制（1905 非空，120 空），空串→NULL |
| `weight` | VARCHAR(32) | `Weight` | 克重（1468 非空，557 空），空串→NULL |
| `yao_legacy_id` | VARCHAR(64) | `YaoID` | 源中药 id，只读追溯；**含 2 行 -1（木防己），原样存不 join** |
| `is_enable` / `signature_id` / `signature` / 时间戳 / `deleted_at` / `ext1`..`ext10` | 同上 | — | 源 IsDelete 全 0 |

索引：`fang_yao_body_fang`（`fang_yao_id`）、`fang_yao_body_pos`（UNIQUE `fang_yao_id`+`position`）。

### 书源组（树第一层，5 组，导入期派生书名）

| `source_book_legacy_id` | `source_book_name` | 方数 | 校验（books.json fangCount） |
|---|---|---|---|
| 1001000 | 伤寒杂病论・(桂林古本) | 329 | 329 ✅ |
| 10002 | 金匮要略・(宋版) | 202 | 202 ✅ |
| 10001 | 伤寒金匮・(宋版) | 113 | 113 ✅ |
| 9040000 | 伤寒论・(人纪) | 111 | 111 ✅ |
| 9050000 | 金匮要略・(人纪) | 49 | 49 ✅ |

合计 804 = `FangYao` 行数 ✅。**注**：`book_chapter` 用 `BookChapter.BookName` 得「伤寒论・(宋版)」，books.json 用 `name` 得「伤寒金匮・(宋版)」——方剂统一以 books.json `name` 为准（它是拆书清单真源，且 1001000/9040000/9050000 仅 books.json 有）。

## 横切关注点（9 处，缺一即门禁红）

| 文件 | 改动 |
|---|---|
| `src/shared/Constants.ts` | `ADMIN_MENU_CODES.FANG_YAO:'fang_yao'` + `PERMISSION_CODES.CONTENT_FANG_YAO_READ/MANAGE` |
| `src/server/rbac/seed.ts` | 权限目录 2 条 + `EDITOR_PERMISSIONS` 授予（经 `yarn rbac:gen`） |
| `src/shared/RbacPermissionDocs.ts` | 两码长说明 |
| `src/shared/AdminPageGuards.ts` | `"fang-yao": PERMISSION_CODES.CONTENT_FANG_YAO_READ`（必登，测试锁） |
| `src/shared/StringUtils.ts` | `ADMIN_URLS` 6 条 `ajaxFangYao*` |
| `i18n/zh-CN.ts` + `en.ts` | `menu.item.fangYao` / `pageTitle.fangYao` / `pageDocumentTitle.fangYao` / UI 块 `fangYao` / `errors.fangYao`（invalidInput/notFound/purgeNeedsDelete/purgeHasBodies 4 键）——**双语键数必须相等** |
| `scripts/check-server-layout.ts` | WHITELIST 加 `"fang-yao"` |
| `manage-cli/lib/snapshot.ts` | `SNAPSHOT_TABLES` 登记 `fang_yao`/`fang_yao_body`（durable） |
| 侧栏菜单 | 由 `ext_permission_nodes` 节点驱动（迁移已 seed），不改侧栏代码 |

## 范围之外

- **不改 `items`/`channels`/`ext_*` 任何字段或语义**；不迁移既有 `tcm_kind` 行。
- **不动 `zhong_yao`/`book_chapter`/`book_info`/`ming_ci`/`yao_alia` 任何表**：不 join、不回写、不读。方剂 ↔ 各域互不伸手。方剂组成 `yao_legacy_id` 仅存源中药 id 供追溯，**不在本期 join `zhong_yao`**（合并投影属二期，归属二期启动时再裁决，同 ADR-0062 D6 取舍）。
- **本期不进 OpenAPI / ApiSchemas**（走 admin ajax + requireRbac，同 book-chapter）。
- `signature_id`/`signature` 仅列位保留，不做唯一约束、不作 ETag、admin 不编辑。
- 不写 `docs/` 散文断言测试；文档校验走 `yarn docs:check`（执行时机归 AGENTS.md「最高指令」）。

## 后果

- 出现**第 6 套独立中医内容模型**：`fang_yao`/`fang_yao_body` 自持，与 items/本草/卷章并存——换来方剂不再被任何既有链路层层叠加绑架，且与 5 个既有模块零耦合。
- 新增 `content:fang-yao:*` 两码：与 `content:book-chapter:*`/`content:chapter:*` 授权边界独立，避免「方剂」与「卷章/章节」权限混淆。
- 新增两表须在 `manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 登记 `durable`，否则快照恢复报「未登记的表」。
- 方 804 + 组成 2025 不进迁移：远程部署后须手动跑一次 `import-fangyao.mjs --apply`（与既有 import-* 同惯例）。**合规例外**：`migrations/0185_seed_fang_yao_data.sql` 是 deploy-anywhere 种子（默认自带数据），由 `--emit-migration` 生成、幂等——故**新部署无需**手动跑 import（数据已在种子内）；`--apply` 仅用于本地开发实例重建/逐行对账。
- 索引走点查/窄范围：`fang_yao_id`（按方取组成防全表扫）、`(fang_yao_id, position)`、`source_book_legacy_id`/UNIQUE `(source_book_legacy_id, fang_no)`/UNIQUE `source_fang_legacy_id`/`fang_name`。
- 迁移只建表不播数据：重导入新版本需另行 upsert 策略（当前源数据一次性冻结）。

## 数据审计（2026-11-05，7 轮只读探针逐列实测）

> 审计方式：解析 `ctwh/FangYao.sql`（804 行 / 36 列）+ `ctwh/FangYaoBody.sql`（2025 行 / 46 列），脚本 `.agent-tmp/audit{1..7}.py`（临时，已按仓库规范用后删）。**所有结论均为「可以 / 不可以 / 有条件可以（写明条件）」三档，无模糊档，每条带数字。** 格式保真以**解码 SQL 转义序列后**的字节为准（见 §Z）。

### 1. 主键 / 引用（健全，3 处需注明）

- FangYao `Id` **804 唯一**，但**非连续**：min=1 max=**809**，缺口 **5 个 = [757, 759, 760, 762, 763]**（源删除残留）。新 id 走 `randomShortUUID()`、源 Id 只存 `source_fang_legacy_id` → 缺口不影响。**可以**。
- FangYaoBody `FangId` → FangYao.Id **悬空 0**（100% 命中）。**可以**。
- FangYaoBody `Id` **2025 唯一，但混入 2 个巨型雪花 int64**：`1988156280564486144` / `1988156280572874752`，其余 2023 行为自增 1..2023。二者同属源方 **809「桂枝去芍药加皂荚汤」**（组成「红蓝花」「蛇床子」，Amount/Weight 均 NULL，IsEnable=0）。因源 Id 不复用、新 id 走 `randomShortUUID()`，巨型值不入库 → **不影响，但证明源 body Id 不可当 int 假设**。
- 两表 `IsDelete` 全 0 → `deleted_at` 导入全 NULL。**可以**。
- `CreateDate` 804/804 非空（样例 `2024-09-17 08:59:43`）；`ModifyDate` 141 非空 / 663 空。**可以**（导入不迁移这俩审计列）。

### 2. 字段填充与弃用（每列带非空数 / 最大长度）

- **FangYao 保留**：`FangName` 804/16、`FangNo` 804、`FangSourceBookId` 804/7、`YaoCount` 804/2（改读侧派生不落列）、`YaoList` **430/115**（空串→NULL）、`FangText` 804/**3804**（最长 = 源 Id 335，min=5 avg=193）、`FangdrinkNum` 803/3、`SignatureId`/`Signature` 804。
- **FangYao 弃（全空或噪声）**：`FangList`(0)、`Extend01-12`/`ParentId`/`ExtJson`/`CreateOrgId`/`OrgId`(全空)、`OtherMark`(1/804)。
- **FangYaoBody 保留**：`ShowName` 2025/11、`Amount` **2018/58**（7 空）、`ExtraProcess` **1905**（120 空）、`Weight` **1468**（557 空）、`YaoID` 2025、`SignatureId` 2025 / `Signature` 2023（**2 空即上述雪花行**）。
- **FangYaoBody 弃（全 2025 行空，中药学临床域不属方剂域）**：`SectionText`/`SectionTerm`/`JingMai`/`TeDian`/`ShiCi`/`ShiYi`/`Notes`/`ZhuZhi`/`ZhenJiu`/`AiJiu`/`PeiWu`；另弃噪声 `Suffix`(1)、`Extend07-12`(各 2)。

### 3. 排序键 `FangNo`（**不可以直接用**，P1 已裁定走甲案）

- **组内重复**：1001000 组 FangNo **重复 1 处** = 源 Id **481「五苓散」**与 **507「甘草干姜汤」同为 397**（二者均 IsEnable=0）。其余 4 组组内唯一：10002=[0,201] 重复 0、10001=[0,112] 重复 0、9040000=[202,684] 重复 0、9050000=[685,733] 重复 0。
- **跨书分段重叠**（全局非单一序列）：10001=[0,112]、10002=[0,201]、1001000=[342,683]、9040000=[202,684]、9050000=[685,733] —— 10002 与 9040000/1001000 区间交错，证明源 FangNo 是**按书独立编号后被拼进同一序列**，非全局自增。
- **结论**：`UNIQUE(source_book_legacy_id, fang_no)` 若直接用源 FangNo 会让导入在 1001000 组 fail-fast（重复 397）。**已裁定走 P1 甲**：`fang_no` 改系统托管组内连续序号（导入按源顺序组内重排 1..N、不含源值、不设源值追溯列），UNIQUE 约束即成立。

### 4. 方 ↔ 组成一致性（**46% 方无组成**，源数据天然不完整）

- **无组成方 373/804（46.4%）**，按书源：1001000=322、9050000=46、10002=2、9040000=2、10001=1。其中 **370 禁用 / 3 启用**（启用的 3 个 = 源 Id 39「禹余粮丸」、238「杏子汤」、282「黄连粉」，其 FangText 仅十几字如「方未见」「(佚)」→ 源刻意留空壳）。
- **每方组成数分布**：0 组成=373 方、1=25、2=54、3=78、4=77、5=63、6=40、7=46、8=18、9=16、10=4、11=1、12=4、14=3、21=1、23=1（最多 = 源 Id 137「鳖甲煎丸」23 味）。
- **YaoCount（源）与组成行数不一致 440/804**：如 源 Id 19「小柴胡汤」YaoCount=15 但 body 仅 7 行、源 Id 21「小青龙汤」13 vs 8。**根因**：YaoList（父表逗号串）含煎液/加减项（清酒、甘澜水、酒等非药材），而这些不进组成表。故 **`yao_count` 绝不可取源值，必须读侧 `COUNT(body)`**（决策 5）。
- **YaoList 与组成药名交叉**：完全一致 356 方；YaoList 多出 73 方（多出项如 清酒/甘澜水/酒/加减药）；body 多出 1 方（源 Id 152「术附子汤」多 姜、枣）。**故 YaoList 只作只读历史，不作真源**（决策 5）。
- **有方文无组成行但 FangText 含药味标记 `$u{}` 的 362 方**（如 源 Id 433–448 桂林古本一系列，FangText 用 `$u{药名}$w{剂量}` 写出完整组成却无 body 行）→ 这些是**源未结构化的组成**，本期不解析、原样保真 FangText（P3）。**不可**试图从 FangText 反解组成。

### 5. 格式保真（§Z 系列，解码 SQL 转义后字节级）

- FangText **含真实换行 `\n` 790/804**（dump 字面 `\n` 转义 2082 处全在 FangText 列，其它列 0）；**含制表符 `\t` 401**；**含 `\r` 0**。
- 逐行：**行首带空格/制表 1974 行**、**行尾带空格 401 行**（制表符对齐药味剂量）。整列首前导空白 804（FangText 普遍以序号如「1、$f{桂枝汤}」开头）。
- 标记 **9 种单字母**（`u/w/f/s/m/a/q/n/g`），**无多字母、无裸 `${`**（解析陷阱 0 方）→ 与 ming-ci 的 `$m{}`/`$n{}` 同源标记体系，原样不解析。
- FangName / YaoList / FangdrinkNum / Body.Amount / Body.ExtraProcess / Body.ShowName **含换行均 0**、含制表均 0。
- 非常规控制字符 0、私用区/增补平面字符 0 → 无编码陷阱。**可以**（导入脚本须先解码 `\'`/`\\`/`\n`/`\t` 再比对）。
- **花括号不配平 15 方（P3 已裁定修正配平）**：`{`≠`}` 计数不等的 15 方（如源 355「禹余粮丸」14`{` vs 13`}`、591「附子粳米汤」6 vs 10、669「白虎加桂枝汤」10 vs 5）→ 导入时做**结构性补齐**（缺失闭合 `}` 补、孤立多余 `}` 删，不增删/改写任何汉字/剂量/`$` 标记），输出逐方配平报告。其余格式一律原样保真。

### 6. 值域异常（逐项定案）

- **`FangdrinkNum` 非纯整数 1 处**：源 Id **261「大半夏汤」= `1.5`**（小数）；**NULL 1 处**：源 Id **627「白头翁加甘草阿胶汤」**。→ 列类型须容纳小数与空：定为 **`VARCHAR(64)`**（非 INTEGER），空串→NULL。其余为整数字符串（3×434、2×176、1×88、4×23、5×17、6×11、100×10、10×9…）。
- **组成行 `Amount` 内嵌标记 22 行**：如 `'$x{腹中痛者/心下悸小便不利者去黄芩)}三两'`、`'$x{若胸中烦而不呕者…去人参)}三两$x{(若渴去半夏加人参至}四两半$x{(并栝楼根四两)}'`（源 Id 19 小柴胡汤加减）。→ **原样保真不解析**（P3），Amount 走 TEXT 语义、列宽留 `VARCHAR(255)` 余量（实测 maxlen 58）。
- **`YaoID = -1` 2 行**：均为药名「木防己」（源方 214「木防己汤」、215「木防己去石膏加茯苓芒硝汤」，均 IsEnable=1）。→ 只读追溯列，-1 原样存 `yao_legacy_id`，不 join、不报错。YaoID 其余 165 唯一值，范围 0..171。
- **同名方跨书 219 个方名 / 涉及 588 行**：如「桂枝汤」×4（分属 10001/10002/9040000/1001000）。→ **跨书同名是正常现象**（同一方多书收载），靠 `source_book_legacy_id` 分组区分，**不做 FangName 唯一约束**。
- **组成行方内药名重复 1 处**：源方 322「桂枝麻黄各半汤」生姜 ×2。→ 不影响（position 仍唯一），原样导入。

### 7. 签名列位（仅保留、不作约束）

- FangYao `SignatureId` 804 全唯一（长度全 15）；`Signature` 非空 804、**唯一仅 797**（**7 个值各重复、涉 14 行**）。
- FangYaoBody `SignatureId` 2024/2025 唯一；`Signature` 非空 2023、**空 2**（即 2 个雪花行）。
- → `signature_id`/`signature` **列位保留、admin 不编辑、不做唯一约束、不作 ETag**（同 ADR-0062）。**可以**。

### 8. 启用状态一致性

- FangYao IsEnable：1=366 / 0=**438**（禁用过半）。FangYaoBody IsEnable：1=1468 / 0=557。
- **body.IsEnable ≠ 其方.IsEnable 的 226/2025 行**：如源方 316「桂枝汤」(10002) IsEnable=1 但其 5 味组成全 IsEnable=0。→ 按行独立存 `is_enable`、**不继承方状态**（同 ADR-0062 对 510 行的处理）。**可以**。

### 9. 书源组书名（F1 落地依据）

- 5 个 `FangSourceBookId` 全部命中 `ctwh-books/books.json` 的 `bookNo → name`，且各书 `fangCount` 与实测方数**逐组吻合**（329/202/113/111/49，合计 804）。
- `BookChapter.BookName` 只覆盖 10001/10002（另 3 个不在其 BookId 集合）→ **统一以 books.json 为书名真源**。注：10001 在 books.json 名为「伤寒金匮・(宋版)」，在 BookChapter 名为「伤寒论・(宋版)」——方剂取 books.json 口径。**可以**。

## 实施清单（**待"进入执行"后按序执行，本期不执行**）

1. 建分支 `feature/fang-yao`（不在 main 改）。
2. 新增 `src/shared/FangYao.ts`（类型 `FangYaoAdmin`/`FangYaoBodyAdmin`/`FangYaoInput`/`FangYaoBodyInput`/`FangYaoBoard` + 4 个 Zod schema + `.partial()`；文本字段不 `.trim()`）。
3. 新增 `src/server/fang-yao/types.ts`（`FangYaoDb` + PreparedStatement 端口，镜像 book-chapter）。
4. 新增 `src/server/fang-yao/store.ts`（方 + 组成读写；`nextFangNo`=组内 MAX+1（P1 甲，系统托管）、`nextPosition`=方内 MAX+1；两步删除 + `purgeHasBodies`；`yao_count` 读侧派生；查询全走索引并注明预计扫描行数）。
5. 新增 `src/server/fang-yao/handlers.ts`（`schema.safeParse` 校验 + `randomShortUUID()` + `FANG_YAO_ERRORS` 4 键 + 看板 `Promise.all` 并行拉书源组/方/组成）。
6. 新增 `migrations/0184_schema_fang_yao.sql`（下一号以现有最大号为准；建两表 + 索引 + `ext1-10` + `ext_permissions` 两码 + `ext_permission_nodes` 页面节点 `pn_page_fang_yao`）。
7. `Constants.ts` 加 `ADMIN_MENU_CODES.FANG_YAO` + `PERMISSION_CODES.CONTENT_FANG_YAO_READ/MANAGE`。
8. 跑 `yarn rbac:gen` 生成 seed 标记区与权限迁移。
9. `seed.ts` 填中文短名「方剂查看」/「方剂维护」+ `EDITOR_PERMISSIONS` 授予，**再跑一次** `yarn rbac:gen`。
10. 补 `src/shared/RbacPermissionDocs.ts` 两码长说明。
11. `AdminPageGuards.ts` 登记 `"fang-yao"` 路由。
12. `StringUtils.ts` 加 `ADMIN_URLS.ajaxFangYao*()` 6 条。
13. `i18n/zh-CN.ts` + `en.ts` 加 `menu.item.fangYao`/`pageTitle`/`pageDocumentTitle`/UI 块 `fangYao`/`errors.fangYao`（双语键数相等）。
14. `scripts/check-server-layout.ts` WHITELIST 加 `"fang-yao"`。
15. `manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 登记两表（durable）。
16. 新增 6 个 ajax 端点（`requireRbac` + `env.FEED_DB as unknown as FangYaoDb`）。
17. 新增 `src/pages/[adminPath]/fang-yao/index.astro`（`requirePagePermission` + AdminShell + `FangYaoApp`）。
18. 新增 `src/components/admin/fang-yao/FangYaoApp.tsx`（`AdminTreeNavLayout` + `AdminGroupTree` 两层树：书源组→方；右栏方详情含 `fang_text` 字节保真展示 + 组成清单 CRUD；`fangToPayload`/`bodyToPayload` 返回 `Record<string, unknown>`，不带 `fang_no`/`position`）。
19. 新增 `scripts/import-ctwh/import-fangyao.mjs`（全量 804+2025、**确定性 id `'fy'`/`'fb'`+9 位补零**（源 Id / 源顺序序号）、**`--emit-migration` 生成 0185 deploy-anywhere 种子**（哨兵编码分块 + `INSERT OR IGNORE` 幂等）、**`--apply` 实写本地 D1**（`INSERT OR REPLACE` + 先清空重建）、**先解码 SQL 转义 `\'`/`\\`/`\n`/`\t` 再逐字节比对**、反查 books.json 派生 `source_book_name`、全格式保真不解析标记、`fang_no` 组内按源顺序重排 1..N）。**花括号配平（P3）**：对 `{`≠`}` 的 15 方做结构性补齐（缺失闭合 `}` 在标记终点补、孤立多余 `}` 删除，不增删/改写任何汉字/剂量/`$` 标记），输出逐方配平报告供人工复核；`Amount` 内嵌 `$x{}` 的 22 行**不改**。**量化自检断言（任一不符 fail-fast）**：方行数=804、组成行数=2025、`FangId` 悬空=0、书源组=5 且 fangCount 吻合(329/202/113/111/49)、书名命中=5/5、`fang_text` 含 LF 方=790 / 含 TAB 方=401 / 含 CR=0、标记 `$u{`=4053 `$w{`=3634 `$f{`=332 `$s{`=227 `$m{`=217 `$a{`=68 `$q{`=41 `$n{`=16 `$g{`=3、配平后方文 `{`==`}` 全部成立、`fang_drink_num` 非整数=1(1.5)/NULL=1、`Amount` 内嵌标记=22(原样)、`yao_legacy_id`=-1 行=2、无组成方=373。
20. 写契约测试 + 运行时测试 `tests/unit/fang-yao-{handlers,store}.test.ts`（**只写不跑**；含 `yao_count` 未软删计数语义、`show_name` NOT NULL 联动断言）。
21. 补 `docs/novel-cms/adr/` 之外：本 ADR 状态由 Proposed 翻 Accepted。

## P1 / P2 / P3 决策（2026-11-05 用户裁定，已定稿）

### P1 — 源排序键 `FangNo` 组内重复 → 采甲：`fang_no` 改系统托管组内连续序号

**是什么**：源 `FangNo` 本该是"每本书里的方剂序号"，但实测**在 1001000（桂林古本）组内重复了 1 处**：源 Id **481「五苓散」** 与源 Id **507「甘草干姜汤」** 的 FangNo **同为 397**。而本 ADR 给 `fang_no` 加 `UNIQUE(source_book_legacy_id, fang_no)` 约束（同一本书里序号不重复）——这两行会撞约束，导入 fail-fast。

**裁定 = 甲（系统托管组内连续序号）**：导入时在同一书源组内按源顺序重排为 1..N（桂林古本 329 方 → 1..329、金匮宋版 202 → 1..202、伤寒宋版 113 → 1..113、伤寒人纪 111 → 1..111、金匮人纪 49 → 1..49）。UNIQUE 约束成立、组内排序稳定、admin 新建走组内 `MAX+1`。

**用户修正**：**不另加 `source_fang_no` 源值追溯列** —— 源 `FangNo` 本就是"按书独立编号后拼进同一序列"的脏值（跨书分段重叠：10002=[0,201] 与 9040000=[202,684] 交错），无追溯价值；方剂只要**正确归属到对应书源组**（`source_book_legacy_id`）即可，组内顺序由系统托管。故表结构不设 `source_fang_no`（对齐 ADR-0062 决策 4"源值杂乱绝不作排序键"先例，但比本草更彻底——连源值列都不留）。

### P2 — 373 个源无组成的方（46.4%）→ 全量导入 804

**是什么**：804 个方里，**373 个（46.4%）在源 `FangYaoBody` 表里没有任何组成行**（一味药都没有）。按书源：桂林古本 322、金匮人纪 46、金匮宋版 2、伤寒人纪 2、伤寒宋版 1。其中 **370 个是禁用状态（IsEnable=0）**，只有 **3 个启用**——源 Id 39「禹余粮丸」、238「杏子汤」、282「黄连粉」，这 3 个的 `FangText` 只有一句占位（如「方未见」「(佚)」），是源刻意留的空壳。

**裁定 = 全量导入 804 方**：与源 804 逐行对账（最硬的正确性证明）。空组成在 UI 显示为空态（同本草"16 个无正文卷章"的处理），方名 + `FangText` 仍在、可搜、不误导。`is_enable` 全量保真（366 启用 / 438 禁用），禁用方不在看板主视图突出，但存在记录不丢。

**补充事实**：另有 **362 个方虽 body 为空、`FangText` 里却用 `$u{药名}$w{剂量}` 写出完整组成**（桂林古本 433–448 一系列最典型）——本期不解析，这些方组成区显示为空、但方文里有内容可看。

### P3 — 源格式瑕疵 → 原样保真；但 `FangText` 花括号不配平的 15 方导入时修正配平

**是什么**：两处源数据本身的"脏"：
1. **`FangText` 花括号不配平 15 方**：`{` 与 `}` 数量不等，如源 355「禹余粮丸」14 个 `{` vs 13 个 `}`、591「附子粳米汤」6 vs 10、669「白虎加桂枝汤」10 vs 5。
2. **组成行 `Amount` 内嵌 `$x{}` 标记 22 行**：如源 19「小柴胡汤」剂量写成 `'$x{腹中痛者/心下悸小便不利者去黄芩)}三两'`。

**裁定 = 原样保真为基调，唯一例外是花括号配平**：
- **`FangText` 花括号不配平的 15 方 → 导入时修正配平**（使 `{` 与 `}` 计数相等）。
- **其余一律不改**：组成行 `Amount` 内嵌的 `$x{}` 标记 22 行**原样保真不解析**（`$x{}` 不在已知 9 种单字母标记内、语义不明，乱解析风险高，留二期再定义）。

**配平修正口径（执行期约束，避免过度改写）**：仅做**结构性补齐**，不触碰任何文字/标记字符——
1. **缺失闭合 `}`**：若某 `$<字母>{` 标记打开后未闭合 → 在该标记内容的合理终点补 `}`。
2. **多余 `}`**：若存在无对应 `$<字母>{` 的孤立 `}` → 删除该孤立 `}`。
3. 配平只以「`{` 计数 == `}` 计数」为目标，**不增删/改写任何汉字、剂量、`$` 标记本身**。
4. 导入脚本须输出**逐方配平报告**（15 方逐行列出：源 `{`/`}` 数 → 修正动作 → 结果 `{`/`}` 数），可人工复核。

**注**：本草同源标记体系（`$u/w/f/s/m/a/q/n/g`）在 ming-ci 是"原样不解析"，方剂 `FangText` 亦原样存储不解析；配平修正只发生在**导入期的一次性数据清洗**，不改运行时解析行为。

### 附：D1 单语句 100KB 限制核算（用户提示项，已量化排除风险）

D1 单条 SQL 语句字面量上限 **100,000 字节**（先例见 ADR-0062 决策 11、`docs/agents/d1-sync.md`）。对本模块两表实测：

| 表 | 行数 | 全列字节合计 | 单行最大字节 |
|---|---|---|---|
| `fang_yao`（方） | 804 | **574,294 B（561 KB）** | **10,691 B** |
| `fang_yao_body`（组成） | 2025 | 591,928 B（578 KB） | **141 B** |

**结论：无风险，但前提是走逐行参数化 INSERT。** 因为参数化绑定的 `?` 占位符与绑定值**不计入语句文本长度**，单条语句的实际长度 ≈ SQL 骨架（列名 + 占位符，约 1–2 KB），远低于 100KB；单行最大值 10,691 B 也远低于上限。两表全量虽各约 560–580 KB，但那是"逐行累加"的总传输量，不是单条语句体积——**严禁**把多行拼成一条巨型 INSERT（那才会撞 100KB，正是 ADR-0062 决策 11 让 0182 按 60 行/条拆分的原因）。故本模块：**方 804 行 + 组成 2025 行全部走导入脚本的参数化逐行 INSERT，不进迁移 SQL**，既避开 100KB 限制、又保住格式保真。**合规例外**：0185 deploy-anywhere 种子用 `--emit-migration` 生成，按 <80KB 分块（13 条 INSERT，单条 max 81,458 B）+ 哨兵编码（LF/TAB/CR → `@@NL@@`/`@@TB@@`/`@@CR@@`，运行时 `replace(..., char(10/9/13))` 还原）——单条仍 <100KB，满足上限。
