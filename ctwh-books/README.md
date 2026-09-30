# ctwh 按需导入结构（按《伤寒杂病论・(桂林古本)》单书导入范式）

> 状态：2026-09-30 基于 `ctwh/` 源 dump 实际解析 + `scripts/import-ctwh/build.ts` 行映射核实。
> 参考实现：**《伤寒杂病论・(桂林古本)》**（BookNo `1001000`），已导入本地实例
> `ctwh-881019-xyz`，频道 id `5IGM9t76quT`——本目录所有书都按它的「单书导入」方式拆分。

---

## 1. 这是什么

`ctwh/` 是旧 .NET 后端的一次性 **合并 MySQL dump**（8 张表、约 16MB），里面混着 **13 部书**。
本目录不重复拆物理源文件，而是把它们**逻辑拆成 13 个离散、可独立按需导入的书单元**：

- `books.json` —— 13 本书的拆分清单（每本的 BookNo、书名、分类、源章节数、方剂数、推算频道 id、导入命令）。
- `<BookNo>/out/` —— 各书**独立**的导入产物目录（构建时 `--out` 指向这里，互不覆盖），按需生成。
- 导入逻辑完全复用已验证的 `scripts/import-ctwh/` 管线（`main.ts --book-no <BookNo>`）。

> 为什么是「逻辑拆分」而非「物理拆源文件」：`build.ts` 的 `--book-no` 已能在构建期按
> `WorkInfo.BookNo` 选出单本书的全部 篇章/条文/方剂，重跑即用、确定性 id、幂等。
> 物理拆 13 份 16MB dump 既冗余又易漂。

---

## 2. 13 本书清单（来自 `books.json`）

| BookNo | 书名 | 分类 | 源章节数 | 方剂数 | 备注 |
|---|---|---|---:|---:|---|
| `100100` | 针灸大成 | 针灸(cat_zhenjiu) | 0 | 0 | ⚠️ 源无 Book 行 → 导入仅建空频道 |
| `9010000` | 针灸篇・(人纪) | 人纪01(cat_renji01) | 0 | 0 | ⚠️ 源无 Book 行 |
| `9040000` | 伤寒论・(人纪) | 人纪01 | 11 | 111 | |
| `9030000` | 黄帝内经・(人纪) | 人纪01 | 0 | 0 | ⚠️ 源无 Book 行 |
| `10001` | 伤寒金匮・(宋版) | 1runoCsI7dr | 27 | 113 | 内容实为「伤寒论・(宋版)」27 篇 |
| `10002` | 金匮要略・(宋版) | 1runoCsI7dr | 22 | 202 | |
| `20100000` | 难经 | j24vLiF3Sym | 81 | 0 | ✅ 已演示构建（见 §5） |
| `20200000` | 黄帝内经・素问 | j24vLiF3Sym | 81 | 0 | |
| `20300000` | 黄帝内经・灵枢 | j24vLiF3Sym | 81 | 0 | |
| `9020000` | 神农本草经・(人纪) | 人纪01 | 7 | 0 | |
| `1001000` | 伤寒杂病论・(桂林古本) | 1runoCsI7dr | 31 | 329 | ✅ **已导入**（参考实现） |
| `400100` | 神农本草经疏 | OteD-aXHV_d | 79 | 0 | |
| `9050000` | 金匮要略・(人纪) | 人纪01 | 25 | 49 | |

**推算频道 id 已核对**：`tcmId("work", ChapterId)` 对 桂林古本（BookNo 1001000 → ChapterId 12）
推导出的 id 与本地已导入频道 `5IGM9t76quT` **完全一致** ⇒ 单书重跑会 `INSERT OR REPLACE`
同一频道，幂等无翻倍。（见 `books.json.idVerification.match = true`）

---

## 3. 导入前置条件（重要，先读）

1. **容器频道必须已存在于目标 D1**。方剂/本草/名词三容器：
   `tcmfang0001` / `tcmyao00001` / `tcmterm0001`。
   - 单书模式（`--book-no`）**只随带方剂容器** `tcmfang0001`（状态 1），不建/不修 `tcmyao00001`、`tcmterm0001`。
   - **本地实例现状（2026-09-30）**：缺 `tcmyao00001` 与 `tcmterm0001`；且 `tcmfang0001` 是 `status=3`（已删）。
     导入任何带方剂的 book 前，建议先恢复容器频道（单书产物里的 `tcmfang0001` 会把它从 3 改回 1）。
     带 yao/term 的全局库需另跑一次「仅容器+全局 yao/term」导入（见 §4 第 0 步）。
2. **全局 yao（Yao.sql 172 条）/ term（MingCi.sql 17 条）库**只在**全量**（不带 `--book-no`）时导入。
   单书模式只带入「本书方剂引用到的中药」（`fangYaoList.yaoId` 关系依赖），不会导入整本本草库。
3. **先停 `manage dev`**（独占 sqlite），再 repour/apply。

---

## 4. 按需导入一本书的步骤

以《难经》(BookNo `20100000`) 为例，其余书把 `<BookNo>` 替换即可（命令也已在 `books.json` 每本的 `importCommand`）。

### 第 0 步（仅首次 / 需要 yao·term 时）：补齐容器频道与全局库
若目标库缺 `tcmyao00001`/`tcmterm0001`，或要一次性灌入全部中药/名词，用**全量**构建（不带 `--book-no`）取到三个容器频道 + 全局 yao/term：
```bash
node --import tsx scripts/import-ctwh/main.ts --full --out .scratch/tcm-import/out --src ctwh
# 然后 §4.3 应用到目标库（此 out 含全部频道/条目）
```

### 第 1 步：构建单书产物（不落库，安全）
```bash
node --import tsx scripts/import-ctwh/main.ts \
  --book-no 20100000 --full \
  --out ctwh-books/20100000/out --src ctwh
```
产物：`ctwh-books/20100000/out/tcm-channels.sql` + `tcm-batch-NNN.sql` + `summary.json`。

### 第 2 步：核对 summary（必须全绿）
脚本退出码 0 且 `summary.json` 满足：
- `report.residualEscapes === 0`（MySQL 转义不能残留）
- `report.markerCountSource === report.markerCountOutput`（标记逐字节保留）
- `report.warnings.length === 0`
- `itemsByKind` 与预期章节/条文数吻合

### 第 3 步：应用进目标 D1
```bash
# 先停 manage dev，再：
node --import tsx .scratch/tcm-import/repour.mts ctwh-881019-xyz local-state ctwh-books/20100000/out
```
`repour.mts` 末参即本目录的 per-book `out`（`recursive_triggers=ON` 保证 FTS 触发器同步）。

### 第 4 步：验证书页
- 后台 `/admin/channels/<channelId>` 看章节树；
- 公开 `/book/<channelId>/` 看目录；
- 回归：桂林古本（984/31）、星河剑歌（14/3）不受影响。

---

## 5. 已验证演示（难经 20100000）

按 §4 跑过，结果：
```
模式：单书 BookNo=20100000
频道：2        （难经频道 tZYk25WiJ0R + 方剂容器 tcmfang0001）
条目：{"chapter":81,"section":165}
标记：源 22 / 产物 22    残留转义：0   警告：0   退出码：0
```
- 246 条 items 的 `book_id` 全部 = `tZYk25WiJ0R`（246 列值 + 246 个 `_microfeed.bookId` = 492 处引用）；
- 165 条 section 全部经 `tcm_parent_id` 挂到对应 chapter；
- 首章标题「一难」。
产物位于 `ctwh-books/20100000/out/`，**未落库**（应用需另行授权）。

---

## 6. 已知源缺口

- `针灸大成`(`100100`)、`针灸篇・(人纪)`(`9010000`)、`黄帝内经・(人纪)`(`9030000`)
  在源 `Book` 表**没有任何篇章行** ⇒ 这三本导入后只有频道（书名+简介），无章节正文。
  属源数据本身缺口（`build.ts` 会对非小说 caseTag 告警）。其内容可能不在此 dump 内。

---

## 7. 与现有脚本的关系

| 脚本 | 作用 |
|---|---|
| `scripts/import-ctwh/parse.ts` | 手写 MySQL dump 逐行解析（一次性脚本豁免，spec §10） |
| `scripts/import-ctwh/build.ts` | 源行 → 目标 channels/items 行映射（11 位确定性 id、转义还原、代理字符清洗、标记保留） |
| `scripts/import-ctwh/main.ts` | CLI：读 `ctwh/` → `--book-no` 单书 / `--full` 全量 → 写 `--out` 目录 |
| `.scratch/tcm-import/repour.mts` | node:sqlite 直灌本地 D1（`<instance> <state-dir> [out-dir]`） |
| `.scratch/tcm-import/verify-fidelity.mts` | 保真审计（递归清洗 UTF-16 代理字符等） |

导入事实来源（约束级）：`.scratch/tcm-import/spec.md`（16 节）+ 该目录 `issues/01..18`。
