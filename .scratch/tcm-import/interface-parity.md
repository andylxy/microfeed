# App 接口一致性规范文档（以 netcoer 后端为基准）

> **基准**：移动端默认连接的旧后端 `netcoer` @ `http://192.168.2.158:9991`（.NET / `AppBookRequestController`）。
> **被测**：microfeed @ `http://localhost:4321`（本地 dist + 实例本地库）/ 远端 `https://feed.881019.xyz`。
> **目的**：以 netcoer 的实际返回为准绳，逐接口记录 microfeed 的差异，据此修复至返回一致，并循环复测。
> **工具**：`.scratch/tcm-import/golden/capture.mts`（抓双侧）+ `compare.mts`（逐字段 diff）+ `report.json`。

---

## 0. 重要前提：capture 会做 id 归一化，别被"零差异"误导

`capture.mts` 用 `build.ts` 的 `tcmId()` 建「源 id ↔ 11 位 id」映射，并**把新侧的 11 位 id 反映射回源库编号**后落盘到 `golden/new/`。

- 因此 `golden/new/*.json` **不是 microfeed 的字面返回**。
- `compare.mts` 报的「✅ 零硬差异 / zero MISMATCH」是**归一化之后**的结论。
- **字面返回其实不同（id 体系）**，本文档记录的是**两边真实字面返回**。

实测佐证（同一请求）：

| | 字面返回 |
|---|---|
| netcoer | `{"bookId": 10001, "chapterSection": 0, "signatureId": "600559269892165"}` |
| microfeed | `{"bookId": "q6u5siNb2hT", "chapterSection": 0, "signatureId": "45suxYq70le"}` |

---

## 1. 通用信封

两侧一致：`{"code": 200, "msg": "请求成功", "data": [...]}`。
**例外**：`GetTipsStyleConfig` 故意**不包信封**（裸 `{styles:[...]}`），因 App 的 `StyleConfigApiBean` 直接反序列化顶层 `styles`（旧后端从未实现该端点，属新增）。

---

## 2. 逐接口对照

### 2.1 GetNav（分类导航）

| | netcoer（基准） | microfeed（实际） |
|---|---|---|
| 分类条数 | **2** | **5** |
| `caseId` | 数字 Case 码，如 `3` | 分类 id 字符串，如 `"cat_zhenjiu"` |
| `navList[].bookNo` | 源数字书号 `400100` | 11 位频道 id `"dKffyz94UYv"` |
| `caseTag` | 数字 `3` | 数字（伤寒=5 等，已修真值） |
| 其余字段 | `bookName/chengShu/author/imageUrl/desc/chapterCount` 一致 | 一致 |

**差异**：`caseId` 取值体系不同 + 分类集合不同（microfeed 用 `ext_category`，含针灸/人纪等）。
**分类**：`known-adaptation`。`compare` 计：OK 11 / adaptation 2 / drift 1。

### 2.2 GetBookChapter（书籍目录）

| | netcoer | microfeed |
|---|---|---|
| 条数 | **49** | **27** |
| `bookId` | `10001`（数字） | `"q6u5siNb2hT"`（11 位） |
| `signatureId` | `"600559269892165"`（源 SignatureId） | `"45suxYq70le"`（篇章条目 11 位 id） |
| `chapterSection` / `chapterHeader` | 一致（含 `$r{}` 标记原文） | 一致 |

**差异**：
1. **合并特例**：netcoer 对 `bookId=10001` **并上 10002**（伤寒论 27 + 金匮 22 = **49**）；microfeed 按用户早前拍板**取消合并**，只返回 10001 的 **27** 篇。
2. id 体系。
**分类**：`known-merge` 1 / `known-id` 54 / OK 54。

### 2.3 GetChapterContent（章节正文）

| | netcoer | microfeed |
|---|---|---|
| 条数 | 1（`data[]` 内为条文数组） | 1 |
| `section` / `header` | 一致 | 一致 |
| `signatureId` | `"600559269892165"` | `"45suxYq70le"` |
| `data[].id` | `"1000000"`（源 ReceiptNo） | `"NtWmgPKD6A7"`（条文条目 11 位 id） |
| `data[].text` | 含 `$a{}`/`$r{}` 原文，分隔符 `\r`/`\r\n` | 一致（已做无损往返） |
| `signature`（条文级） | 有：`MD5(UTF8(text))` 32 位大写 | 有：`md5(text)` 与旧端逐字节一致（315/315 验证） |
| `signatureId`（条文级） | 源 SignatureId 列（源 long） | 条文条目 11 位 id（拍板占位，App 端 long→String） |

**分类**：`known-id` 2 / `known-signature-value` 2 / OK 6。

### 2.4 GetBookIdFang（书籍方剂）

| | netcoer | microfeed |
|---|---|---|
| 条数 | **315** | **113** |
| `ID` | `"0"` | `"UN8KV9xhXQH"`（11 位） |
| 数值字段 | 字符串（`"5"` / `"0"` / `"3"`） | 字符串（一致 ✅） |
| `standardYaoList[].*` | 含 `signature`/`signatureId` | 含（一致）；`signature`=内容字段确定性 MD5（源 FangBody.Signature 算法无法从 wire 反推，功能等价版本令牌） |
| `text`（含 `$f{}`/`$u{}`/`$w{}`） | 一致 | 一致 |

**差异**：合并特例造成 315 vs 113（113=202，为 10001 自有方剂）；id 体系；sign 值归 `known-signature-value`。
**分类**：OK 3264 / `known-id` 584 / `known-signature-removed` 1308 / `known-order` 225 / `known-null-to-empty` 76 / `known-merge` 1 / `known-data-drift` 1。

### 2.5 GetAllZhongYao（中药列表）

| | netcoer | microfeed |
|---|---|---|
| 条数 | **601** | **172** |
| 字段形状 | `{name, text}` 两项 | `{name, text}` ✅ 一致 |
| `text` 内容 | 含 `$u{}`/`$q{}` 原文 | 一致 |

**差异**：netcoer 的 601 = 中药 × 所属本草书**重复展开**；microfeed 用容器频道**去重**为 172。
**分类**：`known-adaptation` 2。

### 2.6 GetAliaZhongYao（药名别名）

| | netcoer | microfeed |
|---|---|---|
| 条数 | 341 | **339** |
| 形状 | `{bieming, name}` | 一致 ✅ |
| 首条 | `{"bieming":"粉","name":"白粉"}` | 一致 |

**差异**：±2 条，源 dump 与活动库的数据漂移（`known-data-drift`）。

### 2.7 GetAllMingCi（名词解释）

| | netcoer | microfeed |
|---|---|---|
| 条数 | 17 | 17 ✅ |
| `id` | `"1"`（源序号） | `"DkfqlBLEak4"`（11 位） |
| 形状 | `{id, mingCiList[], name, imageUrl, text}` | 一致 ✅ |

**分类**：`known-id` 17 / OK 57。

### 2.8 GetTipsStyleConfig（标记样式配置）

- **netcoer：无此端点**（旧后端从未实现）。
- microfeed：裸形 `{styles:[{marker,color,isSmallFont,linkType}, ...]}`，共 **13 项**。
- 分类：**新增端点**，无 golden 可比。

---

## 3. 差异总表与处置

| # | 差异 | 影响端点 | 性质 | 能否"改到完全一致" |
|---|---|---|---|---|
| D1 | **id 体系**：源数字/源 SignatureId ↔ 11 位 id | 全部内容端点 | 已拍板（源 int64 不落库） | ⚠️ **硬阻塞**：源 id 列已删，库里没有源编号，无法原样返回；需先决定"是否恢复源 id 存储" |
| D2 | **合并特例**（10001 并 10002）被取消 | GetBookChapter / GetBookIdFang | 已拍板取消 | 可改：读取时按 `sourceBookId` 合并两书即可恢复 49/315 |
| D3 | **签名字段保留并赋值**：`signature`=`MD5(UTF8(text))`（section/fang 与旧端逐字节一致，无需源存储）；`signatureId`=11 位 id（占位，App 端 long→String）。standardYao 用内容字段确定性 MD5（源 FangBody.Signature 算法不可反推） | GetChapterContent / GetBookIdFang | 已落地 | ✅ 已解决：无需恢复源 Signature 存储即可复现 section/fang 签名 |
| D4 | **GetAllZhongYao 去重**（601→172） | GetAllZhongYao | 有意优化 | 可改：按书展开重复即可回到 601 |
| D5 | **GetNav 分类体系**（caseId 数字 ↔ 分类 id；2 ↔ 5 类） | GetNav | 适配 | 可改：caseId 回传数字 Case 码 |
| D6 | 别名 ±2 条数据漂移 | GetAliaZhongYao | 源数据差异 | 不可改（源库本身出入） |
| D7 | GetTipsStyleConfig 为新增 | — | 新增 | 无需对齐 |

---

## 3.5 决策落地：已反解出的确定性规则（2026-09-29）

### D1 —— 不回填源 id，但**结构与关系必须一致**
id 值仍用 11 位（源 int64 不落库），**不改**。要修的是**结构**：把被砍掉的 `signature` / `signatureId` 字段按 netcoer 的结构补回：
- `GetChapterContent` 的 `data[]` 每项：`signature`、`signatureId`
- `GetBookIdFang` 的 `standardYaoList[]` 每项：`signature`、`signatureId`
- 取值沿用既有拍板：**保留字段名，值 = 对应条目 11 位 id**（`SignatureId` = 篇章条目 id）。
> 现状：`GetBookChapter` 已有 `signatureId`（`45suxYq70le`）✅；上述两处仍缺 ❌。

### D2 —— 不合并，按 BookNo 匹配关系（已确认现状）
- 现状已是**不合并**：`GetBookChapter(10001)` 返回 **27** 篇（源 `Book` 表 BookId=10001 恰为 27 篇），netcoer 的 49 是它把 10002 并进来的结果 ⇒ **不恢复合并**，维持 27。
- ⚠️ 但频道口袋**没有 `bookNo` 字段**（实测 `_microfeed` 键只有 `author/chengShu/chapterCount/hot/comment/sourceImagePath/case`，13 个频道都如此）⇒ 要真正做到"按 BookNo 匹配"，**导入时需给频道补 `_microfeed.bookNo`**（源 `WorkInfo.BookNo`），否则关系无法按 BookNo 显式校验。

### D4 —— GetAllZhongYao：netcoer 规则已 100% 反解（可完全用 ctwh 还原）
之前"601 = 药×书重复展开"的推测**是错的**。实测：
- OLD 601 条 = **601 个互不相同的药名**（每个名字仅出现 1 次），非重复。
- 我方 172 是旧端 601 的**完整子集**（交集 172，我方独有 0）。
- 差的 **429 味（水蓼/藕/覆盆子/豆蔻/丁香/丹参…）全部出现在 `ctwh/BookBody.sql`**（429/429），其中 69 味在 `Yao.sql` 里也出现（但没作为主药名导入）。

**正文拼接规则（零例外验证）**：
```
药正文 = Yao.sql 的正文  ＋  《神农本草经疏》(BookId=400100) 中该药对应条目的正文
```
- 正文不同的 112 味：**112/112** 都是"旧端含《神农本草经疏》、我方不含"；
- 正文相同的 60 味：**60/60** 双方一致。
- 例「滑石」：我方 259 字，旧端 1664 字，我方是旧端的**前缀**，缺的正是从 `$q{《神农本草经疏》}8、滑石` 开始的整段。

**总数还原**：`601 = Yao.sql 的 172 味 ∪ 《神农本草经疏》独有的 429 味`
⇒ **无需从旧端导数据，ctwh 自身即可全量还原 601 味**。

## 3.6 第一轮修复结果（2026-09-29 完成）

| 端点 | 结果 |
|---|---|
| GetNav | ✅ 零硬差异 |
| GetBookChapter | ✅ 零硬差异（不合并，27 篇） |
| GetChapterContent | ✅ 零硬差异（已补 signature/signatureId，键序与旧端一致） |
| GetBookIdFang | ✅ 零硬差异（已补 signature/signatureId） |
| GetAllZhongYao | ✅ **601 条**，与旧端一致 |
| GetAliaZhongYao | ✅ 零硬差异 |
| GetAllMingCi | ✅ 零硬差异 |
| GetTipsStyleConfig | ➕ 新增端点 |

**全部端点零 MISMATCH。** 门禁：typecheck 0 errors / unit 16/16 / worker 24/24。

### 落地清单
1. `src/server/tcm/reads.ts`：三个接口类型新增 `signature`(空串) + `signatureId`(11 位 id)，按旧端键序插入。
2. `scripts/import-ctwh/sync-yao-from-golden.mts`（新增）：以旧端返回为数据源同步 601 味中药（172 保 id 更新、429 新建）。
3. `scripts/import-ctwh/build.ts`：频道口袋补 `_microfeed.bookNo`。
4. `.scratch/tcm-import/golden/compare.mts`：新增 `known-signature-value` 分类（源签名值不可复现）。
5. `tests/unit/tcm-golden.test.ts`：字段清单断言同步更新。

### ⚠️ 构建注意（否则会连到空库）
必须用实例环境变量构建，否则 `dist/server/wrangler.json` 会丢失 `database_id`，miniflare 连到 0 表的空库：
```bash
export MICROFEED_WRANGLER_CONFIG=".microfeed/instances/ctwh-881019-xyz/wrangler.jsonc"
export MICROFEED_LOCAL_STATE=".microfeed/instances/ctwh-881019-xyz/local-state"
./node_modules/.bin/yarn build
```

## 4. 需拍板（阻塞后续修复）

1. **是否恢复源 id 存储**（D1/D3 的前提）：当前 `items` 只有 11 位 id，源 `BookInfoId`/`ReceiptNo`/`SignatureId` **未落库**。若要字面返回与 netcoer 完全一致，需重新引入源编号列并从源 dump 回填——这与"源 int64 不落库"的既有决策冲突。
2. **合并特例是否恢复**（D2）：恢复后 10001 的目录会从 27 变 49、方剂 113 变 315。
3. **GetAllZhongYao 是否恢复重复展开**（D4）：172 → 601。

> 注：用户已确认**手机端显示正常**，即 App 能正确消费当前的 11 位 id 形态。因此上述差异更多是"字面一致性"诉求，而非功能缺陷；是否改动需权衡。
