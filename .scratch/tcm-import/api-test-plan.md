# 移动端接口测试文档（AppBookRequest）

> 目的：把旧 .NET 后端（netcore）作为**标准**，逐接口测试本项目（microfeed）的移动端接口
> `/api/AppBookRequest/*`，记录**接口清单、返回数据、差异、根因、修复、测试记录、测试程序**。
>
> 测试日期：2026-09-30　测试人：雪芙（AI）　复核：andy
> 状态：**进行中**（2026-10-01 第十二轮全量复测：**10 部已导入书逐一**双端抓取 + 逐字段比对；7 部书 8 端点零 MISMATCH，3 部书仅 `GetBookIdFang` 保留 netcore 不下发方剂的超集差异 ①；桂枝汤甘草修复在 App 端点层已生效）



---

## 1. 测试环境

| 角色              | 地址                          | 说明                                                         |
| --------------- | --------------------------- | ---------------------------------------------------------- |
| 标准（old）         | `http://192.168.2.158:9991` | 旧 .NET 后端（netcore / vol.api.sqlsugar），App 内置默认设备密钥 HMAC 直签 |
| 被测-本地（new）      | `http://localhost:4321`     | 本地实例 `ctwh-881019-xyz`（dev server；部分数据）                    |
| 被测-远端（new-prod） | `https://feed.881019.xyz`   | 生产实例（全量数据，当前为旧代码版本）                                        |

比对焦点书：**BookNo=1001000 伤寒杂病论・(桂林古本)**（netcore 与两侧 microfeed 均有数据）。

- netcore `channelId` 语义 = `BookNo`（`1001000`）
- microfeed `channelId` = 频道 11 位 id（`5IGM9t76quT` = `tcmId("work","12")`）
- 篇章 id：`FH7C1pOgiiZ`（源章序号 10010001）

---

## 2. 移动端接口清单（14 个路由）

落点：`src/pages/api/AppBookRequest/*.ts`（路由）+ `src/server/tcm/reads.ts`（读函数）+ `src/server/tcm/envelope.ts`（信封）。

**响应信封**：除 `GetTipsStyleConfig` 外，统一 `{code:200, data:<载荷>, msg:"请求成功"}`，载荷字段名全小驼峰。
`GetTipsStyleConfig` **故意不包信封**（App 的 `StyleConfigApiBean` 直接反序列化顶层 `styles`）。

| #  | 端点                   | 方法   | 参数          | 响应载荷                                                                                                                                                                                           | golden 可比 |
| -- | -------------------- | ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1  | `GetNav`             | GET  | —           | `[{caseId, name, navList:[{bookNo, imageUrl, bookName, chengShu, author, caseTag, desc:null, chapterCount:0}]}]`                                                                               | ✔（分类化改造）  |
| 2  | `GetBookChapter`     | GET  | `bookId`    | `[{bookId, chapterSection, chapterHeader, signatureId}]`                                                                                                                                       | ✔         |
| 3  | `GetChapterContent`  | GET  | `chapterId` | `[{section, header, signatureId, data:[{id, text, note, sectionvideo, height, signature, signatureId, fangList}]}]`                                                                            | ✔         |
| 4  | `GetBookIdFang`      | GET  | `bookId`    | `[{yaoCount, height, name, ID, drinkNum, text, signature, signatureId, fangList, yaoList, standardYaoList:[{suffix, amount, yaoID, weight, showName, extraProcess, signature, signatureId}]}]` | ✔         |
| 5  | `GetAllZhongYao`     | GET  | —           | `[{name, text}]`（**仅这两个字段**）                                                                                                                                                                   | ✔（容器去重改造） |
| 6  | `GetAliaZhongYao`    | GET  | —           | `[{bieming, name}]`（三源合并）                                                                                                                                                                      | ✔         |
| 7  | `GetAllMingCi`       | GET  | —           | `[{id, mingCiList[], name, imageUrl, text}]`                                                                                                                                                   | ✔         |
| 8  | `GetTipsStyleConfig` | GET  | `version=0` | `{styles:[{marker, color, isSmallFont, linkType}]}`（**裸，不包信封**）                                                                                                                                | ✘ 旧后端无此端点 |
| 9  | `login`              | POST | `LoginInfo` | `{Account, Name, …}` + 签发 API Key                                                                                                                                                              | 需登录，未纳入本轮 |
| 10 | `replaceToken`       | POST | —           | 新 Token                                                                                                                                                                                        | 未纳入本轮     |
| 11 | `GetProjectInfo`     | GET  | —           | 字典 `ProjectInfo`                                                                                                                                                                               | 未纳入本轮     |
| 12 | `GetLoginInfo`       | GET  | —           | 字典 `LoginInfo`                                                                                                                                                                                 | 未纳入本轮     |
| 13 | `getAboutInfo`       | GET  | —           | `[{text, name}]`                                                                                                                                                                               | 未纳入本轮     |
| 14 | `getPicCaptcha`      | GET  | —           | 图片验证码（本项目无此能力）                                                                                                                                                                                 | 未纳入本轮     |

> 本轮聚焦 **8 个内容端点**（#1–#8）。#9–#14 属登录/配置链路，App 需登录态，后续单列。

---

## 3. 测试方法与程序

工具目录：`.scratch/tcm-import/golden/`

| 程序                | 作用                                           | 关键参数                                                                |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `capture.mts`     | 一次性抓 old（netcore，HMAC 签名）+ new（microfeed，匿名） | `--old <url> --new <url> --book-no <X> --old-dir <d> --new-dir <d>` |
| `capture-new.mts` | 只抓 microfeed 侧（可指向远端）                        | `--base <url> --out-dir <d> --book-no <X>`                          |
| `compare.mts`     | 逐字段比对，差异分类                                   | `--old-dir <d> --new-dir <d> [--lenient-ids]`                       |

**差异分类**（`compare.mts` 判定，依据 spec §6/§6.0/§15）：

| 分类                      | 含义                                     |
| ----------------------- | -------------------------------------- |
| `OK`                    | 完全一致                                   |
| `known-id`              | id 字段已按拍板换成 11 位新 id（存在性校验通过）          |
| `known-signature-value` | 签名字段结构对齐、值不同（源签名不可复现，拍板保留字段名）          |
| `known-order`           | 成员相同仅顺序（yaoList/fangList 旧按组成序）        |
| `known-null-to-empty`   | 源 `YaoId=0` 哨兵 → `null`                |
| `known-adaptation`      | 数据模型改造（GetAllZhongYao 容器去重、GetNav 分类化） |
| `known-data-drift`      | dump 与旧后端活动库的少量数据出入                    |
| `known-new-endpoint`    | 旧后端无此端点                                |
| **`MISMATCH`**          | **必须对齐的差异（比对失败）**                      |

**复现命令**（本地）：

```bash
# 1. 抓取 netcore(old) + 本地(new)
node --import tsx .scratch/tcm-import/golden/capture.mts \
  --old http://192.168.2.158:9991 --new http://localhost:4321 \
  --book-no 1001000 --old-dir old-1001000 --new-dir new-1001000
# 2. 比对
node --import tsx .scratch/tcm-import/golden/compare.mts \
  --old-dir old-1001000 --new-dir new-1001000
```

---

## 4. 测试结果记录

### 4.1 第一轮：netcore vs 本地（修复前）— 2026-09-30

| 端点                  | 结果                        | 差异分类                                          |
| ------------------- | ------------------------- | --------------------------------------------- |
| GetNav              | ✅ 零硬差异                    | `{known-adaptation:3, OK:6}`                  |
| GetBookChapter      | ✅ 零硬差异                    | `{known-id:62, OK:62}`                        |
| GetChapterContent   | ✅ 零硬差异                    | `{OK:7, known-signature-value:2, known-id:1}` |
| **GetBookIdFang**   | ❌ **1644 处 MISMATCH**     | `{MISMATCH:1644, OK:1146, …}`                 |
| **GetAllZhongYao**  | ❌ **172 处 MISMATCH**      | `{MISMATCH:172, known-adaptation:2}`          |
| **GetAliaZhongYao** | ❌ 1 处 MISMATCH（204 条多重集差） | `{MISMATCH:1}`                                |
| **GetAllMingCi**    | ❌ 2 处 MISMATCH            | `{MISMATCH:2}`                                |
| GetTipsStyleConfig  | ➕ 新增端点                    | —                                             |

### 4.2 第二轮：netcore vs 本地（修复后）— 2026-09-30

| 端点                 | 结果                 | 差异分类                                                                                          |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------- |
| GetNav             | ✅ 零硬差异             | `{known-adaptation:3, OK:6}`                                                                  |
| GetBookChapter     | ✅ 零硬差异             | `{known-id:62, OK:62}`                                                                        |
| GetChapterContent  | ✅ 零硬差异             | `{OK:7, known-signature-value:2, known-id:1}`                                                 |
| **GetBookIdFang**  | ✅ **零硬差异（1644→0）** | `{OK:2132, known-id:358, known-signature-value:395, known-order:658, known-null-to-empty:11}` |
| **GetAllZhongYao** | ✅ **零硬差异（172→0）**  | `{known-adaptation:2}`                                                                        |
| GetAliaZhongYao    | ❌ 1 处（本地数据缺口，非代码）  | `{MISMATCH:1}`                                                                                |
| GetAllMingCi       | ❌ 2 处（本地数据缺口，非代码）  | `{MISMATCH:2}`                                                                                |
| GetTipsStyleConfig | ➕ 新增端点             | —                                                                                             |

### 4.3 第三轮：netcore vs 远端生产（部署前）— 2026-09-30

| 端点                  | 结果                | 差异分类                                              |
| ------------------- | ----------------- | ------------------------------------------------- |
| GetNav              | ✅ 零硬差异            | `{known-adaptation:2, OK:11, known-data-drift:1}` |
| GetBookChapter      | ✅ 零硬差异            | `{known-id:62, OK:62}`                            |
| GetChapterContent   | ✅ 零硬差异            | `{OK:7, known-signature-value:2, known-id:1}`     |
| **GetBookIdFang**   | ❌ 1644 处（远端仍是旧代码） | `{MISMATCH:1644, …}`                              |
| GetAllZhongYao      | ✅ 零硬差异            | `{known-adaptation:2}`                            |
| **GetAliaZhongYao** | ✅ **零硬差异**        | `{known-data-drift:1}`                            |
| **GetAllMingCi**    | ✅ **零硬差异**        | `{known-id:17, OK:57}`                            |
| GetTipsStyleConfig  | ➕ 新增端点            | —                                                 |

> **第三轮是判定"本地差异是数据缺口还是代码 bug"的关键证据**：远端全量数据下，
> `GetAliaZhongYao` / `GetAllMingCi` 与 netcore **完全对齐** ⇒ 端点代码正确，本地差异纯属本地数据不全。

### 4.4 第四轮：netcore vs 远端生产（**部署后**）— 2026-09-30

部署命令：`yarn manage deploy --instance ctwh-881019-xyz`（EXIT=0，耗时 5m36s）。

| 端点                 | 结果                 | 差异分类                                                                                          |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------- |
| GetNav             | ✅ 零硬差异             | `{known-adaptation:2, OK:11, known-data-drift:1}`                                             |
| GetBookChapter     | ✅ 零硬差异             | `{known-id:62, OK:62}`                                                                        |
| GetChapterContent  | ✅ 零硬差异             | `{OK:7, known-signature-value:2, known-id:1}`                                                 |
| **GetBookIdFang**  | ✅ **零硬差异（1644→0）** | `{OK:2132, known-id:358, known-signature-value:395, known-order:658, known-null-to-empty:11}` |
| GetAllZhongYao     | ✅ 零硬差异             | `{known-adaptation:2}`                                                                        |
| GetAliaZhongYao    | ✅ 零硬差异             | `{known-data-drift:1}`                                                                        |
| GetAllMingCi       | ✅ 零硬差异             | `{known-id:17, OK:57}`                                                                        |
| GetTipsStyleConfig | ➕ 新增端点             | —                                                                                             |

> **远端生产 8 个内容端点全部零 MISMATCH** ⇒ 修复已生效、生产接口与 netcore 对齐。

### 4.5 第五轮：netcore vs 本地（**名词导入后**）— 2026-09-30

按 `novel-book-ops` 技能，用 `scripts/import-ctwh/import-term.mjs --apply` 把 17 条名词（源 `ctwh/MingCi.sql`）
导入本地：新建「名词」书频道 `tcmterm0001`（普通书、genre=本草）+ 确定性根 chapter `ZDAkg3UmGf2`（=卷），
17 条 `term` 经 `tcm_parent_id` 挂其下。

| 端点               | 结果                                         | 差异分类                         |
| ---------------- | ------------------------------------------ | ---------------------------- |
| GetNav           | ✅ 零硬差异                                     | `{known-adaptation:3, OK:6}` |
| **GetAllMingCi** | ✅ **零硬差异（2→0）**                            | `{known-id:17, OK:57}`       |
| GetAliaZhongYao  | ❌ 1 处（**另一独立数据缺口**：bieMing/yaoAlias，与名词无关） | `{MISMATCH:1}`               |
| 其余 5 端点          | ✅ 零硬差异                                     | 同 §4.2                       |

> 本地 8 个内容端点现仅剩 `GetAliaZhongYao` 一处，根因是**别名三源数据缺失**（本地 `section.bieMing` 覆盖
> 0/984、yao `aliases[]` 仅 27/172），与名词无关——需另行补导别名数据（或从远端 resync）。

### 4.6 第六轮：netcore vs 本地（**别名导入后**）— 2026-09-30

别名三源：① `yaoAlias`→yao `aliases[]`、② `Yao.YaoList`→yao `yaoNames`、③ `BookBody.BieMing`→section `bieMing`。
本轮修 `build.ts` 的 yaoAlias 折叠（原按 `YaoName` join 会**丢弃** 4 条短名行），使**源①完整**：

| 端点                  | 结果                                       | 差异分类           |
| ------------------- | ---------------------------------------- | -------------- |
| **GetAliaZhongYao** | ❌ 1 处（本地 141→**144** 条；源①已 47/47，缺口全在源③） | `{MISMATCH:1}` |
| 其余 7 端点             | ✅ 零硬差异                                   | 同 §4.5         |

> 新增 `{食蜜→蜜}`、`{煅灶下灰→煅灶灰}`、`{艾叶→艾}`（与 netcore 逐字一致）。
> 剩余 199 条**全部来自源③**——`BookBody.BieMing` 只存在于 `9020000`(神农本草经・人纪) 与
> `400100`(神农本草经疏) 两本书，桂林古本一条没有。**用户拍板：那两本书暂不处理**，故该端点保持差异。

### 4.7 第七轮：netcore vs 本地（**13 部书全量导入后，逐书比对**）— 2026-10-01

按 `ctwh-books/books.json` 把其余 9 部书（9040000/10001/10002/9050000/20100000/20200000/20300000/9020000/400100）
全部 build+repour 导入本地（3 部源无正文的 100100/9010000/9030000 跳过），随后**对 13 部书逐一
`capture.mts --book-no` 双端抓取 + `compare.mts` 比对**（netcore `192.168.2.158:9991` 可达）：

| 书 (BookNo)         | GetBookChapter  | GetBookIdFang      | 备注                                                          |
| ------------------ | --------------- | ------------------ | ----------------------------------------------------------- |
| 1001000 桂林古本       | ✅               | ✅                  | 回归通过                                                        |
| 10001 伤寒金匮・(宋版)    | ✅               | ✅                  | netcore 下发 315 = 113+202（宋版两本合并），compare `known-merge` 合并对齐 |
| 20100000 难经        | ✅               | ✅（双方空）             |                                                             |
| 20200000 素问        | ✅               | ✅（双方空）             |                                                             |
| 20300000 灵枢        | ✅               | ✅（双方空）             |                                                             |
| 9020000 神农本草经・(人纪) | ✅               | ✅（双方空）             |                                                             |
| 400100 神农本草经疏      | ✅（**修复后**，8→0）  | ✅（双方空）             |                                                             |
| 9040000 伤寒论・(人纪)   | ✅（**修复后**，18→0） | ❌ 111（netcore 返回空） | 见遗留差异 ①                                                     |
| 10002 金匮要略・(宋版)    | ✅               | ❌ 202（netcore 返回空） | 见遗留差异 ①                                                     |
| 9050000 金匮要略・(人纪)  | ✅               | ❌ 49（netcore 返回空）  | 见遗留差异 ①                                                     |

全局端点：`GetAliaZhongYao` ✅ **归零**（此前差 199 条的源③ `BookBody.BieMing` 随 9020000/400100 导入收口）；
`GetNav` / `GetAllZhongYao` / `GetAllMingCi` / `GetTipsStyleConfig` 维持对齐。

**本轮发现并修复 2 个真 bug**：

- **问题 6：篇章 `chapterSection` 排序类型差**——netcore 按**字符串**排序（9040000 的「前言」章
  section=904000203 排第 3 位，"904000203" < "9040004"），本地按数值排（垫底）→ 9040000 比对 18 处
  MISMATCH（同名章节错位）。修复：`reads.ts getAppBookChapters` 与 `extCategory.ts getTcmBookChapters`
  的 `ORDER BY` 改 `CAST(json_extract(...) AS TEXT)`。等宽 section 的书序不变，1001000/20100000 回归通过。
- **问题 7：篇章标题被 `trim()`**——netcore `chapterHeader` **原样下发**（400100 8 处前导空格、
  9040000 3 处尾随空格），`build.ts` 对篇章标题做了 `trim()` → 逐字节不对齐。修复：`build.ts` 篇章
  `title` 不再 trim（同 MingCi title「原样」惯例）。重建 9040000/400100 并 repour 后归零。

**遗留差异（netcore 侧行为，非导入 bug，接受）**：① `GetBookIdFang` 对 9040000(111)/10002(202)/9050000(49)
返回**空**——netcore 活动库只对 10001（宋版 315=113+202 合并下发）与 1001000 下发方剂；本地按 dump
`FangSourceBookId` 忠实导入是**超集**（方剂管理看板可用），方剂字段本身已被 10001/1001000 的逐字段
比对验证正确。

**配套测试修复**：`tests/unit/tcm-import.test.ts` 2 个存量失败对齐已提交行为——①容器频道随发
（1 work + 3 容器 = 4）；②夹具 FangBody.YaoID 改 6 以锁定「源 0-based → 导入 +1」补偿语义。

### 4.8 第八轮：netcore vs 本地（**以桂林古本为标准修正全书章节/方剂/药物关联**）— 2026-10-01

用户指令：以《伤寒杂病论・(桂林古本)》的章节序号排列为标准，修正后来导入书本的章节、药方匹配、药物关联。

**实测差距（桂林古本 vs 9 部新书）**：①条文 `volume` 标签/`chapterNo` 桂林古本 984/984 全覆盖、新书 0（build.ts
不写，桂林古本靠导入后回填——技能 §4.6 规定重导后必跑、本轮漏跑）；②方剂 `book_id` 布局两套（桂林古本=真实书、
新书=容器 tcmfang0001）→ `getTcmBookFang` 按 book_id 过滤是新书写页「附：方剂」拿不到的唯一漏网查询；
③`fangYaoList.yaoId` 悬空 2 处（金匮要略・(宋版)——build.ts 越界闸只查 `≤yaoMaxId`、不查 YaoId 是否真在 dump，
YaoId 有空洞）。

**真 bug 8：篇章排序的真实键是源主键序（BookInfoId），不是 section 字符串序**。第七轮的 `CAST AS TEXT` 只是
碰巧修好 9040000（前言 904000203 排第 3）：10001 的 section 是数字 0..21，字符串序会排成 0,1,10,11,…，
netcore 实际是 0,1,2,…——**只有「源主键（插入）序」能同时解释两书**。修复：`build.ts` 给篇章写书内主键排名
`_microfeed.no`（同 fang `no` 排名先例）；三处 ORDER BY 统一收敛到 `src/server/tcm/ordering.ts` 的
`COALESCE(no, CAST(section AS TEXT)), id`（桂林古本等存量书无 no 时回落，等宽 section 结果不变）。

**修复清单**：①`build.ts` 篇章 `_microfeed.no` = 书内 BookInfoId 排名；②`ordering.ts`（新增，三处共用）；
③`extCategory.ts getTcmBookFang` 改按 `$._microfeed.sourceBookId` 过滤（两布局铁律，同 extFang.ts/App）；
④`build.ts` yaoId 闸收紧为 YaoId 成员检查；⑤重灌 9 部书 + 重跑 `import-yao.mjs --apply`（per-book repour
会把引用 yao 写回悬空容器——**每次 repour 后必须重跑**）+ `backfill-tcm-volume.mjs`（8066 条文全部补齐
volume/chapterNo）。

**验证结果（复跑）**：
- **GetBookChapter：10 部书全部零 MISMATCH**（含 9040000 前言第 3、10001 数字序+known-merge 合并 22 章、桂林古本回归）。
- 书页「附：方剂」：金匮要略・(宋版) 202 首、伤寒论・(人纪) 111 首均出现（修复前缺失），桂林古本 329 首无回归。
- 药方匹配（条文 fangList→方剂标题）：桂林古本自身 535/543（98.5%），新书 96–98% 同噪声水平；未命中为源数据
  简称/合并引用（「柴胡汤」「小柴胡汤，麻黄汤」），全局标题集 435 个可命中绝大多数。
- 药物关联：yaoId 悬空 **0**；null（65/70/88）= 源 dump Yao 表仅 172 行的已知缺口（引用的药在 netcore 601 味内、
  dump 没有），非映射错误。（注：此「悬空 0」是按当前 build.ts 重导的代码层结果；本地库实际因旧 build + 仅覆盖
  桂林古本 329 方的补丁，残留 223 个 null 组成行，已于第十轮 §4.10 / `novel-book-ops` #21 修复，备份 `.sqlite.bak-20261001-174538`。）
- 单测 49/49 全绿；typecheck 0 error。

**4.8.1 卷面板脏标题规范化（补刀，针对用户原话：素问显示「第20200001条·上古天真论篇第一」而非「1」）**

- **根因**：卷面板 `buildTcmVolumeBoard`（`src/server/feed/extVolume.ts`）只读 `data.title` 作条文展示。历史
  `tcm-status-title.mjs`（9/30）把**已存在**条文的 title 缩成卷内章号，使桂林古本呈「平脉法第一 → 1,2,3」；
  但 **9 部新书 10/1 才导入**，跑在缩号脚本之后 → 漏跑 → 标题仍是 `build.ts` 生成的源脏标题
  `第<ReceiptNo>条・<篇章名>`。两张面板差异即源于此。
- **修复一（存量数据）**：`.scratch/tcm-import/normalize-section-titles.mjs --apply`
  - 动态定位库（`fileURLToPath` 避 Windows `D:\D:\` 双前缀 bug）；
  - 9 书 channelId 集合（XNK0VFX39Xv/q6u5siNb2hT/ydyQltIuQv6/Kcb7X2K5LTh/tZYk25WiJ0R/drsRImTi5tv/
    ghBqURJwurj/ZhuBd0Vj7kl/OsOP62cyp3j）；
  - 只改 `data.title LIKE '第%条%'` 的脏标题 → `String(Math.trunc(Number(chNo)))`（chNo 取自
    `_microfeed.chapterNo`），幂等。
  - 全局补充 1 条桂林古本残留（mWPC6jJcIdX 原 `第1001000720条・杂病例第五` → `20`）。
- **修复二（源头）**：`scripts/import-ctwh/build.ts` 条文构建段改为 `title: String(idx + 1)`
  （按 `ReceiptNo` 排序后的卷内序号），源 `ReceiptNo` 仍存 `_microfeed.receiptNo` 不丢；删除不再使用的
  `header` 中间变量（避免 tsc TS6133）。
- **复验结果（2026-10-01 续）**：
  - 全库 `tcm_kind='section'` 且 **title 字段本身含「第*条」= 0**（7082 新书 + 1 桂林古本 + 全库扫描全清）。
  - 卷内连续性：素问最大卷 11 条文，标题 `"1".."11"` 连续 ✅；其余书同模式。
  - 21 条 `data LIKE '%第%条%'` 是**正文/注释引用**（如 难经「五十八难」、伤寒互引），title 字段本身干净 → 非脏标题，正常。
  - 门禁复验：`tsc --noEmit` **0 error**（修了 build.ts 未用变量 `header`）；tcm 单测
    `tcm-import 16` + `tcm-golden 6` + `tcm-markers 10` = **32/32 全绿**。

### 4.9 第九轮：netcore vs 本地全量复测 — 2026-10-01

按本文档 §3 复现命令，对 **10 部已导入书逐一** `capture.mts --book-no` 双端抓取（netcore
`192.168.2.158:9991` vs 本地 `localhost:4321`，产物目录 `old-r9-<BookNo>/`、`new-r9-<BookNo>/`）
+ `compare.mts` 比对。

**本地（new）结果**：

| 书 (BookNo) | GetBookChapter | GetBookIdFang | 其余端点 |
| --- | --- | --- | --- |
| 1001000 桂林古本 | ✅ `{known-id:62, OK:62}` | ✅ `{OK:2132, known-id:362, known-signature-value:395, known-order:658, known-null-to-empty:7}` | ✅ 零 MISMATCH |
| 10001 伤寒金匮・(宋版) | ✅ `{known-id:54, OK:54, known-merge:1}` | ✅ `{OK:3377, known-id:654, …, known-merge:1}` | ✅ 零 MISMATCH |
| 20100000/20200000/20300000/9020000/400100 | ✅ 零硬差异 | ✅（双方空） | ✅ 零 MISMATCH |
| 10002 金匮要略・(宋版) | ✅ | ❌ 202（全部为「新多出的行」= 遗留差异 ①） | ✅ |
| 9040000 伤寒论・(人纪) | ✅ | ❌ 111（同上，遗留差异 ①） | ✅ |
| 9050000 金匮要略・(人纪) | ✅ | ❌ 49（同上，遗留差异 ①） | ✅ |

全局端点：`GetAliaZhongYao` ✅ `{known-data-drift:1}`（netcore 活动库别名数已变化，多重集差异归入数据漂移）、
`GetNav` / `GetAllZhongYao` / `GetAllMingCi` / `GetChapterContent` / `GetTipsStyleConfig` 维持一致。
**本地除遗留差异 ①（用户已拍板接受）外零 MISMATCH**；第八轮修复（`ordering.ts` 主键排名、
`getTcmBookFang` sourceBookId、标题不 trim、`title: String(idx+1)`）在 9040000/400100/10001/1001000 复测中全部保持归零。

---

### 4.10 第十轮：方剂组成药味关联完整性核验（桂枝汤少一味甘草）— 2026-10-01

用户指令：核验后来导入的药方数据与「书」的关系是否正确，以 netcore 后端为标准、与本地后端验核。

**实测差距（本地 vs netcore）**：`/admin/items/UN8KV9xhXQH/`（**桂枝汤**）编辑页「药味组成」只显示 4 味，缺 **甘草**。
整库扫描 804 方剂 / 2023 组成行，发现 **223 个 `yaoId=null` 组成行 = 221 甘草 + 2 木防己**（其余 ~1800 行正常）。

**根因（netcore 佐证）**：本地库由**旧 build.ts** 导入，且 `fix-fang-yao.mjs` 历史只覆盖源 FangId 426–754（桂林古本 329 方）；
**桂枝汤 FangId=1（属宋版 `10001`）不在内** → 其组成行停留在旧 build 的 null 状态。源 `ctwh/FangBody.sql` 实际有
**2023 行、覆盖 430 个 distinct FangId**（组成数据完整），故 null **不是源缺失**。netcore `GetBookIdFang` 的
`standardYaoList` 带 `甘草 yaoID=0`（0-based→甘草），明确佐证 netcore 桂枝汤确有甘草且关联正常。

**修复（只动数据，不动代码）**：`.scratch/investigate-fang/repair-fang-yao.mjs --apply`（幂等）——
- 221 个 `甘草` null 行 → 本地甘草条目 `vVJUANA6k8h`；
- 2 个 `木防己` null 行 → 本地防己条目 `M9HezPeSGkC`（源《神农本草经》注「防己（木防己）」即同药）；
- 改前已 `cp` 备份 D1（`.sqlite.bak-20261001-174538`）。

**验证结果**：
- 桂枝汤 5/5 药味全部正确关联（甘草→「1、甘草」）；
- 全库 `yaoId=null` 组成行 = **0**（重扫确认）；
- 方剂→书关系健康：804 方 `sourceBookId` 全指向真实频道、0 悬空；
- 无真错链：另 96 行「显示名≠解析药材」全是合法别名/异写（白芍药→芍药、白蜜→石蜜、生葛→葛根、川乌→乌头等）
  或源 `ShowName` 误标（术附子汤「姜」行源 `YaoID=9→10=附子`，链接跟权威 `YaoID` 走，与 netcore 一致，非导入错）。

**回归判据（已写进 `novel-book-ops` §4.3.5）**：
```sql
SELECT json_extract(data,'$._microfeed.no'), json_extract(data,'$.title'), json_each.value->>'$.showName'
FROM items, json_each(json_extract(data,'$._microfeed.fangYaoList'))
WHERE tcm_kind='fang' AND json_each.value->>'$.yaoId' IS NULL;
-- 健康值：0 行
```

**与 §4.8「yaoId 悬空 0」的关系**：§4.8 那句是**按当前 build.ts 重导的代码层**结果（成员闸命中 0 导入缺失）；
本地库实际因旧 build + 仅覆盖桂林古本 329 方的补丁，残留 223 个 null 组成行，本轮才补齐。两轮结论不矛盾——
代码已对，库需按当前 build 重导或跑本修复脚本。

### 4.11 第十一轮：netcore vs 本地复测（第十轮修复后回归）— 2026-10-01

按本文档 §3 复现命令，对 **10 部已导入书中的两本关键书**（`1001000` 桂林古本 = 主比对标准；
`10001` 伤寒金匮・(宋版) = 桂枝汤所在、第十轮 223 null 修复目标）逐一 `capture.mts --book-no` 双端抓取
（netcore `192.168.2.158:9991` vs 本地 `localhost:4321`，产物目录 `old-1001000/`、`new-1001000/`、
`old-10001/`、`new-10001/`）+ `compare.mts` 比对。**全局端点**（GetNav / GetAllZhongYao / GetAliaZhongYao /
GetAllMingCi / GetTipsStyleConfig，与 book-no 无关）随两次抓取一并覆盖。

**本地（new）结果**：

| 书 (BookNo) | GetBookChapter | GetBookIdFang | 其余端点 |
| --- | --- | --- | --- |
| 1001000 桂林古本 | ✅ `{known-id:62, OK:62}` | ✅ `{OK:2132, known-id:362, known-signature-value:395, known-order:658, known-null-to-empty:7}` | ✅ 零 MISMATCH |
| 10001 伤寒金匮・(宋版) | ✅ `{known-id:54, OK:54, known-merge:1}` | ✅ `{OK:3377, known-id:654, known-signature-value:1195, known-order:225, known-null-to-empty:6, known-data-drift:1, known-merge:1}` | ✅ 零 MISMATCH |

全局端点：`GetNav` ✅ `{known-adaptation:3, OK:6}`、`GetAllZhongYao` ✅ `{known-adaptation:2}`、
`GetAliaZhongYao` ✅ `{known-data-drift:1}`、`GetAllMingCi` ✅ `{known-id:17, OK:57}`、
`GetTipsStyleConfig` ➕ 新增端点（旧后端无）。

**第十轮修复在 App 端点层已生效（直接核验抓取产物）**：本地 `new-10001/GetBookIdFang.json` 中
桂枝汤 `yaoCount=5`、`yaoList=["桂枝","芍药","甘草","生姜","大枣"]` 与 netcore 逐字一致；
其 `standardYaoList` 甘草 → `yaoID="vVJUANA6k8h"`（即第十轮 `repair-fang-yao.mjs` 写入的本地甘草条目 id），
**该组成行 `yaoID=null` 条数 = 0**。netcore 桂枝汤甘草 `yaoID=0`（0-based→甘草），两侧按 known-id 对齐。
⇒ 第十轮补齐的 221 甘草 + 2 木防己 null 组成行，已真实反映在移动端 `GetBookIdFang` 契约中，
不再是「后台有、App 缺一味」。

**结论**：本轮（第十一轮）两本 + 全局端点与 netcore **全部零 MISMATCH**，与第九轮基线一致；第十轮数据修复
未引入任何端点回归。其余 8 部书（20100000/20200000/20300000/9020000/400100/9040000/10002/9050000）
数据模型与第九轮一致，仅 9040000/10002/9050000 保留「netcore 活动库不下发方剂」的遗留差异 ①（拍板接受）。

### 4.12 第十二轮：netcore vs 本地**全量 10 部书**复测（按用户要求逐本，非抽样）— 2026-10-01

用户指令：验核必须是**全部书**，不是一两本抽样。按本文档 §3 复现命令，对 **10 部已导入书逐一**
`capture.mts --book-no` 双端抓取（netcore `192.168.2.158:9991` vs 本地 `localhost:4321`，
产物目录 `old-all-<BookNo>/`、`new-all-<BookNo>/`）+ `compare.mts` 比对。本轮**每本书都带全局端点**
（GetNav / GetAllZhongYao / GetAliaZhongYao / GetAllMingCi / GetTipsStyleConfig，与 book-no 无关，
随每次抓取一并覆盖，结论在各书一致）。

**全量结果（new 侧）**：

| 书 (BookNo) | 书名 | GetNav | GetBookChapter | GetChapterContent | GetBookIdFang | GetAllZhongYao | GetAliaZhongYao | GetAllMingCi | GetTipsStyleConfig |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1001000 | 伤寒杂病论・(桂林古本) | ✅ | ✅ `{known-id:62,OK:62}` | ✅ | ✅ `{OK:2132,known-id:362,known-signature-value:395,known-order:658,known-null-to-empty:7}` | ✅ | ✅ | ✅ | ➕ |
| 10001 | 伤寒金匮・(宋版) | ✅ | ✅ `{known-id:54,OK:54,known-merge:1}` | ✅ | ✅ `{OK:3377,known-id:654,known-signature-value:1195,known-order:225,known-null-to-empty:6,known-data-drift:1,known-merge:1}` | ✅ | ✅ | ✅ | ➕ |
| 20100000 | 难经 | ✅ | ✅ `{known-id:162,OK:162}` | ✅ | ✅（双方空 `{}`） | ✅ | ✅ | ✅ | ➕ |
| 20200000 | 素问 | ✅ | ✅ `{known-id:162,OK:162}` | ✅ | ✅（双方空 `{}`） | ✅ | ✅ | ✅ | ➕ |
| 20300000 | 灵枢 | ✅ | ✅ `{known-id:162,OK:162}` | ✅ | ✅（双方空 `{}`） | ✅ | ✅ | ✅ | ➕ |
| 9020000 | 神农本草经・(人纪) | ✅ | ✅ `{known-id:14,OK:14}` | ✅ | ✅（双方空 `{}`） | ✅ | ✅ | ✅ | ➕ |
| 400100 | 神农本草经疏 | ✅ | ✅ `{known-id:158,OK:158}` | ✅ | ✅（双方空 `{}`） | ✅ | ✅ | ✅ | ➕ |
| 9040000 | 伤寒论・(人纪) | ✅ | ✅ `{known-id:22,OK:22}` | ✅ | ❌ **111**（全部「新多出的行」= 遗留差异 ①） | ✅ | ✅ | ✅ | ➕ |
| 10002 | 金匮要略・(宋版) | ✅ | ✅ `{known-id:44,OK:44}` | ✅ | ❌ **202**（同上，遗留差异 ①） | ✅ | ✅ | ✅ | ➕ |
| 9050000 | 金匮要略・(人纪) | ✅ | ✅ `{known-id:50,OK:50}` | ✅ | ❌ **49**（同上，遗留差异 ①） | ✅ | ✅ | ✅ | ➕ |

**遗留差异 ① 已逐本核实**（读 `report-old-all-<B>-new-all-<B>.json`）：9040000/10002/9050000 的
`GetBookIdFang` MISMATCH **100% 为「新多出的行」**（本地按 dump `FangSourceBookId` 忠实导入为超集、
netcore 活动库不下发这三本书方剂），**无任何字段级错配**——方剂字段本身已被 10001/1001000 的逐字段
比对验证正确。该差异用户已于第七轮拍板接受。

**结论**：10 部书全量复测，7 部书 8 端点零 MISMATCH；3 部书仅 `GetBookIdFang` 保留已接受的超集差异 ①；
全局端点（GetNav / GetAllZhongYao / GetAliaZhongYao / GetAllMingCi / GetTipsStyleConfig）在 10 次抓取中
**一致零 MISMATCH**。第十轮（桂枝汤甘草 223 null 修复）未引入任何端点回归。本轮取代第十一轮的抽样范围，
构成完整基线。

---

## 5. 问题、根因与修复

### 问题 1：GetBookIdFang —— 1001000 的 wire 形状判断错误（真 bug）

- **现象**：1644 处 MISMATCH，全部为同一模式：netcore 发大写 `ID`（字符串 `"342"`）+ 字符串数值
  （`yaoCount:"4"`、`height:"0"`、`drinkNum:"3"`），microfeed 发小写 `id` + **数字**（`yaoCount:4`、`height:0`、`drinkNum:3`）。
- **根因**：`src/server/tcm/reads.ts` 的 `FANG_NUMERIC_WIRE_BOOKNOS = new Set(["1001000"])`——
  依据 spec 初稿"1001000 桂林古本走 `id`+数字数值"的假设。**实测 golden 推翻该假设**：netcore 对 1001000
  的 wire 与 10001 **完全一致**（大写 `ID` + 字符串数值）。
- **修复**：`FANG_NUMERIC_WIRE_BOOKNOS` 置空（所有书统一走非数值 wire）。
- **验证**：本地 1644 → **0** ✅。


### 问题 2：GetAllZhongYao / GetAliaZhongYao —— yao 名序号前缀泄漏进 App 契约（真 bug）

- **现象**：`GetAllZhongYao` 172 处、`GetAliaZhongYao` 204 条——microfeed 的 yao `name` 是 `"1、甘草"`，
  netcore 是裸药名 `"甘草"`。
- **根因**：后台卷面板展示需要，上一轮（工单 E/H）把 yao 条目标题改成 `"<序号>、<药名>"`（如 `"38、蜀椒"`）。
  但 `getAppAllYao` / `getAppYaoAliases` 直接用 `titleOf(data)` 作 App 的 `name` ⇒ 前缀泄漏进移动端契约。
- **修复**：新增 `yaoAppName()`（剥离 `^\d+、`），仅用于 App 端点的 yao `name`；后台标题保留前缀。
  该修复对**有/无前缀两种数据都安全**（无前缀时正则不匹配，名字不变）。
- **验证**：本地 172 → **0**、别名 204 → 收敛（仅剩数据缺口）✅。

### 问题 3：GetAllMingCi 为空（本地数据缺口，非代码）

- **现象**：本地返回 `{"code":200,"data":[]}`（35 字节），netcore 有 17 条名词。
- **根因**：本地实例 `ctwh-881019-xyz` 为**部分导入**，缺「名词」容器频道与 17 条 `term` 条目。
- **证据**：远端生产（全量数据）`GetAllMingCi` 与 netcore 完全对齐 ⇒ 端点代码正确。
- **处置**：需向本地补导名词数据（或从远端 resync）后复测；**非代码问题**。

### 问题 4：GetAliaZhongYao 残留 204 条（本地数据缺口，非代码）

- **现象**：本地 141 条 vs netcore 341 条；netcore 独有 202、本地独有 2。
- **根因**：三源中本地缺两源——
  - **第三源 `BookBody.BieMing` 为空**：本地 `section` 条目 `bieMing` 覆盖 **0/984**（源缺或未导入）；
  - **第一源 `yaoAlias` 不全**：本地 yao 仅 **27/172** 有 `aliases[]`（共 43 条）、**52/172** 有 `yaoNames`。
  - 且 netcore 的 `GetAliaZhongYao` 是**全局聚合**（含其他书 `BookBody.BieMing`），本地只导入了桂林古本。
- **证据**：远端生产（全量数据）`GetAliaZhongYao` 与 netcore 零硬差异（仅 1 条 known-data-drift）⇒ 端点代码正确。
- **处置**：需向本地补导别名三源数据（或从远端 resync）后复测；**非代码问题**。
- **2026-09-30 更新**：第一源已修复（见问题 5）；第二源本就齐全；第三源（两本书）用户暂不处理。

### 问题 5：GetAliaZhongYao —— yaoAlias 折叠丢弃短名行（真 bug，源①）

- **现象**：本地别名 43 条 vs 源 `yaoAlias` 47 行。
- **根因**：`build.ts` 的 yaoAlias 折叠按 `YaoName` join Yao 表；4 条用**短名**的行（`蜜`/`艾`/`煅灶灰`）
  匹配不到 Yao 表的长名（`石蜜`/`艾叶`/`煅灶下灰`）→ 被静默丢弃。**但 netcore 对 yaoAlias 表原样下发**
  （`name` = yaoAlias.YaoName，不 join）——golden 实测 `{食蜜→蜜}`、`{艾叶→艾}`、`{煅灶下灰→煅灶灰}`。
- **修复**：`build.ts` 折叠改为**原样保留全部行**、`name` 用源 `YaoName`；孤儿行挂到最贴近的 yao
  （YaoList 包含 → 子串 → 最长公共前缀；endpoint 只遍历全部 yao 的 `aliases[]`，挂哪条不影响输出）。
- **验证**：本地 43 → **47**（源有本地无=0、本地有源无=0）；端点 141 → 144。

### 问题 6：方剂「药味组成」少一味（桂枝汤缺甘草，本地库 null 残留，非代码 bug）

- **现象**：`/admin/items/UN8KV9xhXQH/`（桂枝汤）编辑页「药味组成」只显示 4 味，缺甘草；整库扫出 **223 个 `yaoId=null` 组成行**（221 甘草 + 2 木防己）。
- **根因**：本地 D1 由**旧 build.ts** 导入，且 `fix-fang-yao.mjs` 仅覆盖源 FangId 426–754（桂林古本 329 方），
  **桂枝汤 FangId=1（宋版 `10001`）不在内** → 组成行停在旧 build 的 null 状态。源 `FangBody.sql` 共 2023 行 /
  430 distinct FangId（组成完整），null 非源缺失。
- **netcore 佐证**：`GetBookIdFang` 的 `standardYaoList` 带 `甘草 yaoID=0`（0-based→甘草）⇒ netcore 桂枝汤确有甘草。
- **修复**：`.scratch/investigate-fang/repair-fang-yao.mjs --apply`（幂等，甘草→`vVJUANA6k8h`、木防己→`防己` `M9HezPeSGkC`）；
  根治 = 用当前 build.ts（`tcmId("yao",YaoID+1)` + 成员闸）重导带方剂书 + 重跑 `import-yao.mjs --apply`。
- **验证**：桂枝汤 5/5 关联；全库 null 组成行 = 0；方剂→书 0 悬空；无真错链（96 处显示名差异全是合法别名/源误标）。
- **回归**：`novel-book-ops` §4.3.5 SQL 扫 null 应 0 行（2026-10-01 第十轮，见 §4.10）。

---

## 6. 返回数据样本（netcore vs microfeed）

### 6.1 GetBookIdFang（修复前差异 / 修复后对齐）

netcore（bookId=1001000）第 0 条：

```json
{"yaoCount":"4","height":"0","name":"麻黄汤","ID":"342","drinkNum":"3",
 "text":"$u{麻黄}$w{三两、去节} …","signature":"FD1E1E7F…",
 "signatureId":"620047195783237","fangList":[],
 "yaoList":["杏仁","甘草","桂枝","麻黄"],
 "standardYaoList":[{"suffix":null,"amount":"七十个","yaoID":"17","weight":null,
   "showName":"杏仁","extraProcess":"去皮尖","signature":"48FA…","signatureId":"620047195783238"}, …]}
```

microfeed（修复前，错误）：`yaoCount:4`(数字)、`height:0`(数字)、`id:"dR1IAFFs7UI"`(小写)、`drinkNum:3`(数字)。
microfeed（修复后，对齐）：`yaoCount:"4"`、`height:"0"`、`ID:"dR1IAFFs7UI"`、`drinkNum:"3"`（id 值换 11 位，属 known-id）。

### 6.2 GetAllZhongYao（修复前差异 / 修复后对齐）

| | name | text（截断） |
| --- | --- | --- |
| netcore | `甘草` | `1、$u{甘草}\r\n$q{《神农本草经》}：…` |
| microfeed（修复前） | `1、甘草` | 同上 |
| microfeed（修复后） | `甘草` | 同上 |

### 6.3 GetAliaZhongYao（本地数据缺口）

| | 条目数 | 样例 |
| --- | --- | --- |
| netcore | 341 | `{bieming:"旋华", name:"旋覆花"}`、`{bieming:"消石", name:"芒硝"}` |
| microfeed 本地 | 141 | 本地缺 `旋华→旋覆花`（第三源缺）；`消石→赤消`（数据源差异） |
| microfeed 远端 | ≈341 | 与 netcore 对齐（仅 1 条 known-data-drift） |

### 6.4 GetAllMingCi（本地数据缺口）

| | 条目数 | 说明 |
| --- | --- | --- |
| netcore | 17 | `{id, mingCiList[], name, imageUrl, text}` |
| microfeed 本地 | 17 | **已导入**（§4.5）→ 与 netcore 对齐（`known-id:17, OK:57`） |
| microfeed 远端 | 17 | 与 netcore 对齐（`known-id:17, OK:57`） |

---

## 7. 结论与待办

**代码层**：8 个真 bug 已修复（问题 1/2/5/6/7/8），本地内容端点与 netcore 对齐；篇章排序三处统一到
`src/server/tcm/ordering.ts`。

**数据层（2026-10-01 第七轮更新）**：本地实例已完成 **13 部书中 10 部**的实际导入（桂林古本 + 9 部新书 +
全局 yao/term 库；3 部源无正文跳过）。`GetAllMingCi` / `GetAliaZhongYao` 均已归零（源③随 9020000/400100
导入收口）。唯一遗留差异 = `GetBookIdFang` 对 9040000/10002/9050000：netcore 活动库不下发（侧行为），
本地按 dump 忠实导入为超集（见 §4.7）。

**生产层**：修复已部署（`yarn manage deploy`），**远端 8 个内容端点全部零 MISMATCH** ✅。
（注：第七轮的 2 个新修复 `CAST AS TEXT` 排序 + 篇章标题不 trim 尚未部署远端。）

**待办**：
1. ✅ **部署** `reads.ts` 修复到远端生产 → 远端 `GetBookIdFang` 归零（第四轮验证）。
2. ✅ 向本地补导**名词**数据（`scripts/import-ctwh/import-term.mjs`，17 条）→ 本地 `GetAllMingCi` 归零（第五轮验证）。
3. ✅ 别名：源③随第七轮导入 9020000/400100 收口 → `GetAliaZhongYao` 归零（第七轮验证）。
4. ⏳ 登录 / 配置类端点（#9–#14）单列测试。
5. ⏳ 部署第七/八轮修复（排序常量、篇章 no、getTcmBookFang sourceBookId、yaoId 成员闸、build.ts 标题）到远端生产后按 §4.7/§4.8 复测远端。
6. ⏳ 提交（用户手动执行）：本轮改动 + 本测试文档。
5. ✅ 门禁：`yarn typecheck` 0 error / 0 warning / 5 hints。
6. ⏳ 提交（用户手动执行）：`src/server/tcm/reads.ts` + `scripts/import-ctwh/import-term.mjs` + 本测试文档。

---

## 附：文件索引

- 读函数：`src/server/tcm/reads.ts`（`getAppAllYao` / `getAppYaoAliases` / `getAppBookFang`）
- 信封：`src/server/tcm/envelope.ts`
- 路由：`src/pages/api/AppBookRequest/*.ts`
- 测试程序：`.scratch/tcm-import/golden/{capture,capture-new,compare}.mts`
- 名词导入：`scripts/import-ctwh/import-term.mjs`（`--apply` 幂等；新建名词书 `tcmterm0001` + 根 chapter + 17 条 term）
- 别名折叠：`scripts/import-ctwh/build.ts`（yaoAlias → yao `aliases[]`；`name` 用源 `YaoName` 原样、孤儿行挂最贴近 yao）
- 本轮产物：`.scratch/tcm-import/golden/{old-1001000,new-1001000,new-prod-1001000}/`、
  `report-old-1001000-new-1001000.json`、`report-old-1001000-new-prod-1001000.json`
- 第十二轮全量产物：`.scratch/tcm-import/golden/{old-all-<BookNo>,new-all-<BookNo>}/`（10 部书各一套）、
  `report-old-all-<BookNo>-new-all-<BookNo>.json`（逐本比对报告）
- 规范：`.scratch/tcm-import/spec.md`（§6 端点契约、§6.2 golden 比对、§15 差异清单）
