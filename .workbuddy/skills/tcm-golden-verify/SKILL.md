---
name: tcm-golden-verify
description: 用 netcore 老后端的 golden 捕获，核对 microfeed 本地导入的 TCM 数据（书 / 篇章 / 条文 / 方剂 / 中药 / 名词 / 别名）是否与老后端一致。This skill should be used when the user asks to 核对数据、和 netcore 对齐、验证导入结果、golden 比对，或怀疑某类 TCM 数据（方剂组成、中药、别名）导入不正确。覆盖 capture-new → compare → 报告判读 → 补充逐条核对（含 known-adaptation 端点必须单独查）的完整流程。
agent_created: true
---

# TCM 数据 golden 核对技能（对齐 netcore 老后端）

## 0. 为什么有这个技能

判断「本地导入的数据对不对」，**唯一权威标准是 netcore 老后端的响应**（golden），不是自写的比对脚本——自己写脚本极易因「dump 列解析少一列」「换行符表示不同」而得出假红/假绿结论。

工具链在 `.scratch/tcm-import/golden/`：
- `capture.mts`：同时抓 old（netcore）+ new（本地）
- `capture-new.mts`：**只抓本地**（old 已捕获时用这个，最常用）。**需 `MICROFEED_APP_TOKEN`**，缺凭证会在首个端点抛 401 并打印带凭证的复现命令
- `compare.mts`：逐字段比对 old vs new，输出分类判定报告

## 1. 前置条件

1. **本地 dev server 必须在跑**，且**带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`**（否则 Vite 优化器清理 `deps_temp_*` 被 safe-delete 闸杀死 → dev server 崩溃。详见 `novel-book-ops` 技能）。
   - 常驻起法：`run_in_background` 跑 `./node_modules/.bin/yarn manage dev --local --instance ctwh-881019-xyz`
2. **必须带 App 登录凭证 `mflc_…`**，否则 8 个内容端点**全部 401 `Unauthorized`**（见下方「鉴权」）。
3. 实例 `ctwh-881019-xyz`、端口 `4321`、焦点书号 `1001000`（桂林古本）。
4. **必须用管理的 node 全路径**（`C:/Users/zhs/.workbuddy/binaries/node/versions/22.22.2-3/node.exe`）跑 `--import tsx`；用 `yarn node` 会被 SIGTERM 且无输出。

### ⚠️ 鉴权：内容端点不再匿名放行（2026-05 移动端鉴权落地）

`/api/AppBookRequest/` 下8 个**内容**端点（`GetNav` / `GetBookChapter` / `GetChapterContent` / `GetBookIdFang` / `GetAllZhongYao` / `GetAliaZhongYao` / `GetAllMingCi` / `GetTipsStyleConfig`）要求 `Authorization: Bearer mflc_…`（→ 用户 → 角色 → 权限 `app:mobile:access`），外加 `X-Timestamp` / `X-Nonce` 防重放头。**匿名一律401**，无任何豁免开关。

```bash
MICROFEED_APP_TOKEN=<mflc_…> node --import tsx .scratch/tcm-import/golden/capture-new.mts \
  --base http://localhost:4321 --book-no 1001000 --out-dir new-1001000-recheck
```

**易误判点**：
- **dev server 重启后立刻全401** —— 重启前能裸抓不代表存在豁免；之前"裸抓 601/17"是重启前的旧状态。判据= 响应体是纯文本 `Unauthorized`（12 字节）而非 `{code:200,...}` 信封。
- **别去改 `optimizeDeps` 或查依赖** —— 401 与 vite 优化器无关。
- **别用后台 cookie 代替** —— 后台会话 cookie 与 `mflc_` 凭证是**两套鉴权**，后台 `/admin/*` 能开不代表 App 端点能抓。
- 想快速确认数据面而不带凭证时，**直查本地 D1 更省事**：
  ```bash
  node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite',{readOnly:true});console.log(db.prepare(\"SELECT COUNT(*) c FROM items WHERE tcm_kind='yao' AND status=1\").get())"
  ```
  （中药 172 / 名词 17 / 方剂 804 是健康基线；中药 17 条无序号前缀是**正常名词数据**，不是测试残留。）

## 2. 标准流程

### 步骤 1：抓本地当前数据（不要覆盖历史 golden）

```bash
MICROFEED_APP_TOKEN=<mflc_…> node --import tsx .scratch/tcm-import/golden/capture-new.mts \
  --base http://localhost:4321 --book-no 1001000 --out-dir new-1001000-recheck
```

- 产物写到 `--out-dir` 指定目录，**不会覆盖** `golden/new/`；但控制台文案固定打印「已覆盖 golden/new/*.json」，**别被误导**，用 `ls` 确认实际目录。
- 抓的端点：GetNav / GetBookChapter / GetChapterContent / GetBookIdFang / GetAllZhongYao / GetAliaZhongYao / GetAllMingCi / GetTipsStyleConfig。

### 步骤 2：与 netcore OLD 比对

```bash
node --import tsx .scratch/tcm-import/golden/compare.mts \
  --old-dir old-1001000 --new-dir new-1001000-recheck
```

- 传了自定义目录时报告自动命名 `report-<old>-<new>.json`，**不覆盖** `report.json`。
- `--state-dir` 默认 `local-state`（正确的本地库）；旧值 `.wrangler/state` 是「双本地库」错位目录。

### 步骤 3：判读分类（关键）

| 判定 | 含义 | 处理 |
|---|---|---|
| `OK` | 完全一致 | — |
| `known-id` | id 已换成 11 位新 id（存在性+形状校验） | 可接受 |
| `known-id-numeric` | App 侧 id 下发数值字符串（源 int64 不落库，值不可复现） | 可接受（2026-10-03 拍板 A） |
| `known-signature-value` | 源签名值无法复现（源 int64/签名不落库） | 可接受 |
| `known-order` | **仅顺序不同** | 必须再查是「数组顺序」还是「内容差」 |
| `known-null-to-empty` | 旧 null → 新 null/"" | 可接受 |
| `known-adaptation` | **数据模型改造（整体判定，不逐字段比）** | ⚠️ 见步骤 4 |
| `known-data-drift` | dump 与老库活动数据的少量出入 | 可接受 |
| `known-added-fallback` | GetBookIdFang 内「源 FangBody 缺行 / 旧端公式为空」致旧端无组成或无法，新端经 FangText 标记回退补出（拍板「补」的直接后果） | 可接受（2026-10-03 拍板 B'） |
| `MISMATCH` | 必须对齐 | 定位修复 |

### 步骤 4：⚠️ 补充逐条核对（别被「零硬差异」骗过）

**`known-adaptation` 是整体判定，compare 不会逐字段比对该端点。** 判据 = 报告里该端点**没有 OK 计数**（只有 `{"known-adaptation":N}`）→ 说明它根本没逐字段比对，此时「零硬差异」不代表数据正确，必须自己补跑逐条比对（脚本见 §3）。

实例：2026-10-01 `GetAllZhongYao` 曾长期是 known-adaptation（只有 `{"known-adaptation":2}` 无 OK 计数），正因如此「零硬差异」掩盖了「缺 429 味」——2026-10-03 已把它改为**真实比对**（现 `{"OK":3,...}`）。**其余仍属 known-adaptation 的端点同样要警惕**。

### 步骤 5：顺序差异要确认性质

`known-order` 数量大时（如 GetBookIdFang 的 658 = 329×2），用序列比对脚本确认：是方剂顺序、药味顺序，还是 compare 内部字段级判定。不要想当然。

## 3. 复用脚本（在 `.scratch/`）

| 脚本 | 用途 |
|---|---|
| `cmp-fang-order.mjs` | 方剂条数 / 顺序 + 每个方剂 `yaoList`、`standardYaoList` 的 showName 序列逐一比对 |
| `cmp-yao.mjs` | 中药条数 / name 序列 / 逐条 text 比对（含 firstDiff 定位） |
| `analyze-yao-gap.mjs` | 中药缺口分析：唯一药名数、本地缺失清单、需补齐 text 的条数 |
| `verify-yao.mjs` | 本地 yao ↔ 源 dump 核对（id/no/正文语义级/别名） |
| `gen_429_anchor.mjs` | 从 golden 反推 `GetAllZhongYao` 的 429 药名锚点 → 生成 `src/server/tcm/zhongyao-anchor.ts`（**429 是 netcore 策展清单、无法用规则还原**，新增经疏药条需重跑它才会下发） |
| `verify_dynamic.mjs` | 离线复刻 `getAppAllYao`（动态合并版）跑本地库：校验 601 基线 + 注入假新增看「新增 yao 是否自动合并」 |

## 4. 已知结论（2026-10-01 第七轮：13 部书逐书比对后）

- **逐书抓取**：`capture.mts --old http://192.168.2.158:9991 --new http://localhost:4321 --book-no <X> --old-dir old-<X> --new-dir new-<X>` 可对任意 BookNo 双端抓取（netcore 局域网可达）；`capture-new.mts` 同样支持 `--book-no`（**同样需 `MICROFEED_APP_TOKEN`**）。golden 目录里已留有各书 old-*/new-* 包可复用。
- **10 部已导入书全对齐**（GetBookChapter/GetChapterContent/GetNav/GetAllZhongYao/GetAliaZhongYao/GetAllMingCi）：1001000、10001、20100000、20200000、20300000、9020000、400100（+第七轮修复后的 9040000）。
- **GetAliaZhongYao 已归零**：此前差 199 条的源③ `BookBody.BieMing` 随 9020000/400100 导入收口（仅剩 1 条 known-data-drift）。
- **⚠️ GetBookIdFang 遗留差异（netcore 侧行为，接受）**：netcore 对 9040000(111)/10002(202)/9050000(49) 返回**空**；对 10001 返回 **315 = 113+202**（宋版两本合并下发，compare `known-merge` 已验证合并对齐）；对 1001000 返回 329。本地按 dump `FangSourceBookId` 忠实导入是超集，不是错数据。
- **两个新 bug 类（已修复，2026-10-01）**：
  1. **章节排序的真键 = 源主键（BookInfoId）序**（第八轮定论，推翻第七轮「字符串序」假说）：netcore 对
     9040000（前言 section=904000203 排第 3，数值序会垫底）与 10001（section 0..21 数字序，字符串序会排成
     0,1,10,11）只有主键序能同时解释。修复 = `build.ts` 写篇章 `_microfeed.no`（书内主键排名），三处 ORDER BY
     统一 `src/server/tcm/ordering.ts` 的 `COALESCE(no, CAST(section AS TEXT)), id`。**验证章节序必须抽查
     section 等宽与混合宽度两类书**（等宽书字符串序=数值序=主键序，测不出这类 bug）。
  2. **篇章标题 trim**：netcore `chapterHeader` 原样下发（400100 8 处前导空格、9040000 3 处尾随空格）；
     `build.ts` 曾 trim。修复 = 篇章 title 不 trim（同 MingCi 原样惯例）。改后必须**重建 + repour 受影响书**才生效。
- **⚠️ per-book repour 的固定收尾三步**（2026-10-01 两次实证）：repour 带方剂的书 → yao 被写回悬空容器
  `tcmyao00001` → **必须重跑 `import-yao.mjs --apply`**；再跑 `backfill-tcm-volume.mjs`（幂等补 volume/chapterNo）。
- **⚠️ 换新目录名重跑 capture/compare 的坑**：compare.mts 的 known-merge（10001 并上 10002）按
  `$.data` 旧多出行判定——10001 的旧抓包有 49 章/315 方（宋版合并），新抓只有 27/113 属正常
  known-merge；若报 50 处 MISMATCH 先核对是否新抓目录不完整，不要误判排序。
- **✅ 中药（GetAllZhongYao）已补齐 601 味（2026-10-03，**推翻此前「源 dump 缺口、暂不修」判断**）**：
  - 曾记「netcore 601 vs 本地 172 = 缺 429，且 112 味 text 截断」——**根因不是源缺数据，而是端点复刻不全**：那 429 味的正文本就在**《神农本草经疏》书**里，netcore 提取后与 Yao 合并下发（人纪 `ZhuBd0Vj7kl` 几乎不贡献）。已实现 601（172 + 经疏 429，同名药 `\r\n\r\n$q{《神农本草经疏》}` 合并）。
  - `compare.mts` 的 `compareYao` 已从 known-adaptation 放行改为**真实比对**（名集合 + 顺序 + 文本三级）：现在报 `{"OK":3,"known-data-drift":1}`。**改这个端点必跑 compare**，回归会直接报 MISMATCH。
  - 残余：文本 69 完全一致 / 531 仅空白差异（`\n` vs `\r\n`、空行——本地 import 丢失原始空行，属**已知保真限制**，内容逐字相同）/ 1 内容差异（石蜜=源 dump 与 netcore 活动库出入）。详见 `novel-book-ops` §4.13。
- `compare.mts` 对 `yaoID` 走 `ID_FIELDS` 的 known-id 放行（**只看是否 11 位、不校验指向**）→ 修正 `fangYaoList.yaoId` 的指向**不影响 golden 对齐**，可放心修。
- **⚠️ `known-id-numeric`（2026-10-03 新增判定，拍板 A）**：App 侧 `Fang.ID` / `standardYaoList[].yaoID` 必须发
  数值字符串（Gson `IntegerTypeAdapter` 只吃数值），而源 int64 不落库 → 值不可复现。判据 = 两侧同为数值形态
  且 `oldV !== newV`（**必须带 `oldV !== newV` 前置**，否则会把本就 OK 的相等 id 降级成 known-*）。
  看到该类条目时**不要**当成「要修的对齐问题」——除非同批出现字段级错配。
- **⚠️ `known-added-fallback`（2026-10-03 新增判定，拍板 B'）**：拍板「补」后，源 `FangBody` 缺行、但
  `FangText` 含组成标记的书（9040000/9050000/1001000）在导入时回退补出组成；netcore golden 旧端在那些位置
  **为空**（9050000 整本 `$.data` 为空、1001000 各方的 `standardYaoList` 为空）。`compare.mts` 把
  GetBookIdFang 内「新端比旧端多出的元素 / 旧端为空的组成数组」归为 `known-added-fallback`。
  **安全边界（勿改）**：① 仅 `GetBookIdFang` 生效；② `数组长度` 类只在 `oldArr.length === 0` 时放行；
  ③ 同位置双方都有值的项仍走 `diffValue`，值篡改照判 MISMATCH——**只放过纯新增，不放过值篡改**。
- **vitest 池 2026-10-01 已恢复可用**（此前记录的「池起不来」已失效）；单测相关：`tcm-import.test.ts` 夹具已对齐容器随发 + yaoId +1 补偿语义。

## 5. 坑清单

1. `yarn node --import tsx` 跑 capture **被 SIGTERM 且零输出** → 改用管理 node 全路径。
2. capture 控制台文案固定说「已覆盖 golden/new」→ 用 `--out-dir` + `ls` 验证真实产物位置。
3. **`known-adaptation` / 无 OK 计数 = 该端点没被逐字段比对**，必须自己补跑。
4. 解析 MySQL dump 时 `cols` 必须按表头**全列**取：少一列会整列错位（Yao 表要 `YaoId,YaoNo,YaoName`；FangBody 要 7 列才到 `ShowName`）。
5. 源 `YaoText` 里的 `\r\n` 是**字面反斜杠文本**（charCode 92,114,92,110），本地是真实换行 `</p>\r\n<p>` → 逐字比必红，要语义级比。
6. `tcmId` 的 `BASE62` 是 `0-9a-zA-Z`（**小写在前**），复刻错会导致 id 全不匹配。
