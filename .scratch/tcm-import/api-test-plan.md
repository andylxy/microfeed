# 移动端接口测试文档（AppBookRequest）

> 目的：把旧 .NET 后端（netcore）作为**标准**，逐接口测试本项目（microfeed）的移动端接口
> `/api/AppBookRequest/*`，记录**接口清单、返回数据、差异、根因、修复、测试记录、测试程序**。
>
> 测试日期：2026-09-30　测试人：雪芙（AI）　复核：andy
> 状态：**进行中**（本地已修复 2 个 wire bug；远端待部署）

---

## 1. 测试环境

| 角色 | 地址 | 说明 |
| --- | --- | --- |
| 标准（old） | `http://192.168.2.158:9991` | 旧 .NET 后端（netcore / vol.api.sqlsugar），App 内置默认设备密钥 HMAC 直签 |
| 被测-本地（new） | `http://localhost:4321` | 本地实例 `ctwh-881019-xyz`（dev server；部分数据） |
| 被测-远端（new-prod） | `https://feed.881019.xyz` | 生产实例（全量数据，当前为旧代码版本） |

比对焦点书：**BookNo=1001000 伤寒杂病论・(桂林古本)**（netcore 与两侧 microfeed 均有数据）。
- netcore `channelId` 语义 = `BookNo`（`1001000`）
- microfeed `channelId` = 频道 11 位 id（`5IGM9t76quT` = `tcmId("work","12")`）
- 篇章 id：`FH7C1pOgiiZ`（源章序号 10010001）

---

## 2. 移动端接口清单（14 个路由）

落点：`src/pages/api/AppBookRequest/*.ts`（路由）+ `src/server/tcm/reads.ts`（读函数）+ `src/server/tcm/envelope.ts`（信封）。

**响应信封**：除 `GetTipsStyleConfig` 外，统一 `{code:200, data:<载荷>, msg:"请求成功"}`，载荷字段名全小驼峰。
`GetTipsStyleConfig` **故意不包信封**（App 的 `StyleConfigApiBean` 直接反序列化顶层 `styles`）。

| # | 端点 | 方法 | 参数 | 响应载荷 | golden 可比 |
| --- | --- | --- | --- | --- | --- |
| 1 | `GetNav` | GET | — | `[{caseId, name, navList:[{bookNo, imageUrl, bookName, chengShu, author, caseTag, desc:null, chapterCount:0}]}]` | ✔（分类化改造） |
| 2 | `GetBookChapter` | GET | `bookId` | `[{bookId, chapterSection, chapterHeader, signatureId}]` | ✔ |
| 3 | `GetChapterContent` | GET | `chapterId` | `[{section, header, signatureId, data:[{id, text, note, sectionvideo, height, signature, signatureId, fangList}]}]` | ✔ |
| 4 | `GetBookIdFang` | GET | `bookId` | `[{yaoCount, height, name, ID, drinkNum, text, signature, signatureId, fangList, yaoList, standardYaoList:[{suffix, amount, yaoID, weight, showName, extraProcess, signature, signatureId}]}]` | ✔ |
| 5 | `GetAllZhongYao` | GET | — | `[{name, text}]`（**仅这两个字段**） | ✔（容器去重改造） |
| 6 | `GetAliaZhongYao` | GET | — | `[{bieming, name}]`（三源合并） | ✔ |
| 7 | `GetAllMingCi` | GET | — | `[{id, mingCiList[], name, imageUrl, text}]` | ✔ |
| 8 | `GetTipsStyleConfig` | GET | `version=0` | `{styles:[{marker, color, isSmallFont, linkType}]}`（**裸，不包信封**） | ✘ 旧后端无此端点 |
| 9 | `login` | POST | `LoginInfo` | `{Account, Name, …}` + 签发 API Key | 需登录，未纳入本轮 |
| 10 | `replaceToken` | POST | — | 新 Token | 未纳入本轮 |
| 11 | `GetProjectInfo` | GET | — | 字典 `ProjectInfo` | 未纳入本轮 |
| 12 | `GetLoginInfo` | GET | — | 字典 `LoginInfo` | 未纳入本轮 |
| 13 | `getAboutInfo` | GET | — | `[{text, name}]` | 未纳入本轮 |
| 14 | `getPicCaptcha` | GET | — | 图片验证码（本项目无此能力） | 未纳入本轮 |

> 本轮聚焦 **8 个内容端点**（#1–#8）。#9–#14 属登录/配置链路，App 需登录态，后续单列。

---

## 3. 测试方法与程序

工具目录：`.scratch/tcm-import/golden/`

| 程序 | 作用 | 关键参数 |
| --- | --- | --- |
| `capture.mts` | 一次性抓 old（netcore，HMAC 签名）+ new（microfeed，匿名） | `--old <url> --new <url> --book-no <X> --old-dir <d> --new-dir <d>` |
| `capture-new.mts` | 只抓 microfeed 侧（可指向远端） | `--base <url> --out-dir <d> --book-no <X>` |
| `compare.mts` | 逐字段比对，差异分类 | `--old-dir <d> --new-dir <d> [--lenient-ids]` |

**差异分类**（`compare.mts` 判定，依据 spec §6/§6.0/§15）：

| 分类 | 含义 |
| --- | --- |
| `OK` | 完全一致 |
| `known-id` | id 字段已按拍板换成 11 位新 id（存在性校验通过） |
| `known-signature-value` | 签名字段结构对齐、值不同（源签名不可复现，拍板保留字段名） |
| `known-order` | 成员相同仅顺序（yaoList/fangList 旧按组成序） |
| `known-null-to-empty` | 源 `YaoId=0` 哨兵 → `null` |
| `known-adaptation` | 数据模型改造（GetAllZhongYao 容器去重、GetNav 分类化） |
| `known-data-drift` | dump 与旧后端活动库的少量数据出入 |
| `known-new-endpoint` | 旧后端无此端点 |
| **`MISMATCH`** | **必须对齐的差异（比对失败）** |

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

| 端点 | 结果 | 差异分类 |
| --- | --- | --- |
| GetNav | ✅ 零硬差异 | `{known-adaptation:3, OK:6}` |
| GetBookChapter | ✅ 零硬差异 | `{known-id:62, OK:62}` |
| GetChapterContent | ✅ 零硬差异 | `{OK:7, known-signature-value:2, known-id:1}` |
| **GetBookIdFang** | ❌ **1644 处 MISMATCH** | `{MISMATCH:1644, OK:1146, …}` |
| **GetAllZhongYao** | ❌ **172 处 MISMATCH** | `{MISMATCH:172, known-adaptation:2}` |
| **GetAliaZhongYao** | ❌ 1 处 MISMATCH（204 条多重集差） | `{MISMATCH:1}` |
| **GetAllMingCi** | ❌ 2 处 MISMATCH | `{MISMATCH:2}` |
| GetTipsStyleConfig | ➕ 新增端点 | — |

### 4.2 第二轮：netcore vs 本地（修复后）— 2026-09-30

| 端点 | 结果 | 差异分类 |
| --- | --- | --- |
| GetNav | ✅ 零硬差异 | `{known-adaptation:3, OK:6}` |
| GetBookChapter | ✅ 零硬差异 | `{known-id:62, OK:62}` |
| GetChapterContent | ✅ 零硬差异 | `{OK:7, known-signature-value:2, known-id:1}` |
| **GetBookIdFang** | ✅ **零硬差异（1644→0）** | `{OK:2132, known-id:358, known-signature-value:395, known-order:658, known-null-to-empty:11}` |
| **GetAllZhongYao** | ✅ **零硬差异（172→0）** | `{known-adaptation:2}` |
| GetAliaZhongYao | ❌ 1 处（本地数据缺口，非代码） | `{MISMATCH:1}` |
| GetAllMingCi | ❌ 2 处（本地数据缺口，非代码） | `{MISMATCH:2}` |
| GetTipsStyleConfig | ➕ 新增端点 | — |

### 4.3 第三轮：netcore vs 远端生产（部署前）— 2026-09-30

| 端点 | 结果 | 差异分类 |
| --- | --- | --- |
| GetNav | ✅ 零硬差异 | `{known-adaptation:2, OK:11, known-data-drift:1}` |
| GetBookChapter | ✅ 零硬差异 | `{known-id:62, OK:62}` |
| GetChapterContent | ✅ 零硬差异 | `{OK:7, known-signature-value:2, known-id:1}` |
| **GetBookIdFang** | ❌ 1644 处（远端仍是旧代码） | `{MISMATCH:1644, …}` |
| GetAllZhongYao | ✅ 零硬差异 | `{known-adaptation:2}` |
| **GetAliaZhongYao** | ✅ **零硬差异** | `{known-data-drift:1}` |
| **GetAllMingCi** | ✅ **零硬差异** | `{known-id:17, OK:57}` |
| GetTipsStyleConfig | ➕ 新增端点 | — |

> **第三轮是判定"本地差异是数据缺口还是代码 bug"的关键证据**：远端全量数据下，
> `GetAliaZhongYao` / `GetAllMingCi` 与 netcore **完全对齐** ⇒ 端点代码正确，本地差异纯属本地数据不全。

### 4.4 第四轮：netcore vs 远端生产（**部署后**）— 2026-09-30

部署命令：`yarn manage deploy --instance ctwh-881019-xyz`（EXIT=0，耗时 5m36s）。

| 端点 | 结果 | 差异分类 |
| --- | --- | --- |
| GetNav | ✅ 零硬差异 | `{known-adaptation:2, OK:11, known-data-drift:1}` |
| GetBookChapter | ✅ 零硬差异 | `{known-id:62, OK:62}` |
| GetChapterContent | ✅ 零硬差异 | `{OK:7, known-signature-value:2, known-id:1}` |
| **GetBookIdFang** | ✅ **零硬差异（1644→0）** | `{OK:2132, known-id:358, known-signature-value:395, known-order:658, known-null-to-empty:11}` |
| GetAllZhongYao | ✅ 零硬差异 | `{known-adaptation:2}` |
| GetAliaZhongYao | ✅ 零硬差异 | `{known-data-drift:1}` |
| GetAllMingCi | ✅ 零硬差异 | `{known-id:17, OK:57}` |
| GetTipsStyleConfig | ➕ 新增端点 | — |

> **远端生产 8 个内容端点全部零 MISMATCH** ⇒ 修复已生效、生产接口与 netcore 对齐。

### 4.5 第五轮：netcore vs 本地（**名词导入后**）— 2026-09-30

按 `novel-book-ops` 技能，用 `scripts/import-ctwh/import-term.mjs --apply` 把 17 条名词（源 `ctwh/MingCi.sql`）
导入本地：新建「名词」书频道 `tcmterm0001`（普通书、genre=本草）+ 确定性根 chapter `ZDAkg3UmGf2`（=卷），
17 条 `term` 经 `tcm_parent_id` 挂其下。

| 端点 | 结果 | 差异分类 |
| --- | --- | --- |
| GetNav | ✅ 零硬差异 | `{known-adaptation:3, OK:6}` |
| **GetAllMingCi** | ✅ **零硬差异（2→0）** | `{known-id:17, OK:57}` |
| GetAliaZhongYao | ❌ 1 处（**另一独立数据缺口**：bieMing/yaoAlias，与名词无关） | `{MISMATCH:1}` |
| 其余 5 端点 | ✅ 零硬差异 | 同 §4.2 |

> 本地 8 个内容端点现仅剩 `GetAliaZhongYao` 一处，根因是**别名三源数据缺失**（本地 `section.bieMing` 覆盖
> 0/984、yao `aliases[]` 仅 27/172），与名词无关——需另行补导别名数据（或从远端 resync）。

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

**代码层**：2 个真 bug 已修复（`reads.ts`），本地 `GetBookIdFang` 与 `GetAllZhongYao` 已零硬差异。

**数据层**：本地实例 `ctwh-881019-xyz` 为部分导入。`GetAllMingCi` 已通过导入**名词**数据（§4.5）归零；
`GetAliaZhongYao` 仍因缺**别名三源**数据（`section.bieMing` 覆盖 0/984、yao `aliases[]` 仅 27/172）而差异。
远端生产全量数据下两接口与 netcore 对齐，**证明端点代码正确**。

**生产层**：修复已部署（`yarn manage deploy`），**远端 8 个内容端点全部零 MISMATCH** ✅。

**待办**：
1. ✅ **部署** `reads.ts` 修复到远端生产 → 远端 `GetBookIdFang` 归零（第四轮验证）。
2. ✅ 向本地补导**名词**数据（`scripts/import-ctwh/import-term.mjs`，17 条）→ 本地 `GetAllMingCi` 归零（第五轮验证）。
3. ⏳ 向本地补导**别名三源**数据（`section.bieMing` / yao `aliases[]`）→ 本地 `GetAliaZhongYao` 归零。
4. ⏳ 登录 / 配置类端点（#9–#14）单列测试。
5. ✅ 门禁：`yarn typecheck` 0 error / 0 warning / 5 hints。
6. ⏳ 提交（用户手动执行）：`src/server/tcm/reads.ts` + `scripts/import-ctwh/import-term.mjs` + 本测试文档。

---

## 附：文件索引

- 读函数：`src/server/tcm/reads.ts`（`getAppAllYao` / `getAppYaoAliases` / `getAppBookFang`）
- 信封：`src/server/tcm/envelope.ts`
- 路由：`src/pages/api/AppBookRequest/*.ts`
- 测试程序：`.scratch/tcm-import/golden/{capture,capture-new,compare}.mts`
- 名词导入：`scripts/import-ctwh/import-term.mjs`（`--apply` 幂等；新建名词书 `tcmterm0001` + 根 chapter + 17 条 term）
- 本轮产物：`.scratch/tcm-import/golden/{old-1001000,new-1001000,new-prod-1001000}/`、
  `report-old-1001000-new-1001000.json`、`report-old-1001000-new-prod-1001000.json`
- 规范：`.scratch/tcm-import/spec.md`（§6 端点契约、§6.2 golden 比对、§15 差异清单）
