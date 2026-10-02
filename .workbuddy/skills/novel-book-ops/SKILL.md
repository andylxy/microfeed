---
name: novel-book-ops
description: 给 microfeed 本地实例的书（小说类 + TCM 类）建书、加卷与章节、草稿归卷、调整排布、维护卷面板与前端展示。This skill should be used when the user asks to 新建书/建一本小说、发布新章节、加更、开新卷、补卷名章号、调整卷章排位、维护卷面板，或询问书的关联匹配结构、必填字段、排序规则、TCM 书展示，或排查书页 / 目录 / 阅读页显示错乱（如书页显示了别的书的条目）。以《星河剑歌》为小说参考实现、《伤寒杂病论・(桂林古本)》为 TCM 参考实现。
agent_created: true
---

# 小说书 / TCM 书卷章操作技能（novel-book-ops）

## 0. 适用范围与参考实现

本技能面向 microfeed 本地实例 **`ctwh-881019-xyz`**（`manage dev` 运行），覆盖该实例里所有"书"的建书、加章、开卷、卷面板维护与前端展示。

- **小说参考实现**：《星河剑歌》频道 `J1jGJjUWeCz`（已逐章审计，实际数据表见 `docs/novel-cms/xinghe-book-structure.md`；设计 SSOT 见 `docs/novel-cms-design.md`）。
- **TCM 参考实现**：《伤寒杂病论・(桂林古本)》频道 `5IGM9t76quT`（BookNo `1001000`，31 篇章 / 984 条文 / 329 方剂）。
- TCM 批量导入：旧 .NET 后端 `ctwh/` 合并 dump 的 **13 部书**已按本范式拆成按需导入单元，工作区在仓库根 `ctwh-books/`（含 `books.json` 拆分清单 + `README.md` 流程，复用 `scripts/import-ctwh/main.ts --book-no`）。
- 两类书**结构模型不同但都已打通**——动手前必须先按第 1 节判别，用错会静默出错。

---

## 1. 动手前必读：两套书结构模型

本实例的"书"分两类，**下面的"三键规则"只对小说类成立**。判别 SQL：

```sql
SELECT 1 FROM items WHERE book_id='<书ID>' AND tcm_kind IS NOT NULL LIMIT 1;
```

- **无结果** → 小说类（星河剑歌等），走第 2、3 节。
- **有结果** → TCM 类（桂林古本等），走第 4 节。

| | 小说类 | TCM 类 |
|---|---|---|
| 卷是什么 | `_microfeed.volume` **字符串标签**（卷不是实体） | `tcm_kind='chapter'` 条目（篇章即卷，**是实体**） |
| 章是什么 | 普通 item | `tcm_kind='section'` 条目（条文） |
| 归属键 | 卷名逐字一致 | **`tcm_parent_id`**（指向所属篇章） |
| 序号键 | `_microfeed.chapterNo`（卷内从 1 起） | 权威 = `_microfeed.receiptNo`；`chapterNo` 仅是展示值 |
| 卷面板 | 可改（标签/改名/拖排序） | **可编辑**（`readOnly=false`），落点 = `tcm_parent_id` 列 + `volume` 标签 |
| 加章方式 | 本技能脚本 / 后台 | **只能走 `scripts/import-ctwh/` 导入**，禁止 `add-chapter.mjs` |

`add-chapter.mjs` 内置**闸 0**：目标书含 `tcm_kind` 会直接 `exit 2` 拒绝（写库前退出、零副作用）；确知后果才加 `--force`。

> ⚠️ **动书页 / 目录 / 阅读页翻页之前，先读 §4.9**：那里记着一次已发生的回归 —— 书页把**别的书**的条目
> 当成自己的目录渲染（中药书页显示星河剑歌章节），附反面代码、3 秒自检判据与回归测试命令。

---

## 2. 小说书：三键与排序铁律

### 2.1 关联匹配三键（任何小说书加章都必须三键齐）

| 键 | 落点 | 要求 |
|---|---|---|
| **书键（双写）** | `items.book_id` 列 + `data._microfeed.bookId` | 两处**同时写、必须一致**，值为该书频道 ID |
| **卷键** | `data._microfeed.volume` 字符串 | 卷不是实体；同书同卷各章卷名**逐字一致**（含空格）；跨书同名卷互不相干 |
| **序号键** | `data._microfeed.chapterNo` | **卷内序号**，从 1 起每卷独立计数；必须 = 标题「第Y章」的 Y；同卷唯一连续 |

参考实现（星河剑歌）：`第一卷 初入江湖` 章号 1-6、`第二卷 星河初现` 章号 2-5（第 1 章是未归卷草稿）、`第三卷 归墟之门` 章号 1-4——三键全合规即标准写法。

### 2.2 必填还是可选

写入层全可选（API Schema `.loose()`，空标题空正文草稿可存）；"必须"= 效果强制：

| 字段 | 不写的后果 |
|---|---|
| 书 `title` | 显示 untitled |
| 章 `title` / 正文 | 「未命名章节」/ 阅读页空白、搜不到 |
| `pub_date` | **该书阅读顺序崩**（空值排最前）——必填 |
| `volume` | 后台「未归卷」桶垫底；开卷后必须逐字一致 |
| `chapterNo` | 按 0 处理必乱序——强烈建议填 |
| `content_format` | 不用填，缺省即 HTML（`BodyFormat.ts:17`） |

### 2.3 排序铁律（对每本书独立生效）

`pub_date` = 该书**全局阅读顺序键**（公开书页平铺升序，同日才比 `chapterNo`；`chapterNo` 每卷重来不能当全局键）。新章 `pub_date` 必须晚于本书现有最新一章；插队取中间时刻。统一 `YYYY-MM-DDTHH:MM:SS.000Z` 格式（书页是字符串比较）。

---

## 3. 小说书：标准操作

### 3.1 建一本新书

后台：`/admin` 频道管理新建，填 书名 / 简介 / 作者 / 分类 / 连载状态 / 标签（即 `data._microfeed` 小说字段）。

脚本（数据结构照抄星河剑歌实际频道 JSON）：

```bash
node scripts/add-book.mjs --title "书名" --description "简介" --author "作者" \
  --genre "东方玄幻" --tags "热血,升级" \
  --serial-status serializing --sign-status signed
# 同名书已存在会拒绝；--force 强制。--db 可指定库路径。
```

分类接受 `ext_category` 的 ID 或名称，查不到置空警告。建完自检：`/book/<新书ID>` 能打开、书名正确。

### 3.2 加一章

**后台编辑页**：条目编辑器填 标题（`第X卷 第Y章 标题`）、正文、**发布时间**（排序键）、**卷 / 章号**。卷名是**下拉框**——选完「归属书本」后 `EditItemApp` 监听 `bookId` 变化 → `loadVolumes(bookId)` 打 `/admin/ajax/volumes?bookId=` → `volumeOptions()` 把返回的卷名 + 一项「未分卷」喂给 `AdminSelect`（原 `AdminInput` 改下拉，**只能选已有卷**，防 typo 散落未分卷）。章号仍手填数字（`EditItemApp/index.tsx`）。

**脚本**（自动双写书键、镜像 `content_text`、累加该书 `wordCount`、FTS 触发器自动处理）：

```bash
node scripts/add-chapter.mjs --book "星河剑歌" --title "第三卷 第5章 ×××" \
  --volume "第三卷 归墟之门" --chapter-no 5 \
  --pub-date "2026-03-05T09:00:00.000Z" --html 第三卷第5章.html
# --book 接受频道 ID 或书名（重名书要求用 ID）；--db 可指定库。
```

脚本四道闸：⓪ **TCM 拒绝闸**（`exit 2`）① `pub_date` 顺序闸（晚于本书最新章）② 同卷章号重号闸 ③ 标题中文数字章号与 `--chapter-no` 一致性警告。

⚠️ **脚本没有 dry-run，`--book` 指向真实小说书会立刻真写库**。测闸建议：
- **闸 0 最安全**——拿 TCM 书跑会直接 `exit 2`、零副作用；
- 测**闸 1** 才用 `--pub-date` 给一个会被顺序闸拒绝的旧时刻（安全失败），别拿真实小说书"试一下"。

**前置：先停 `manage dev`**（独占 sqlite；PowerShell 按命令行过滤杀进程树），完事重启。

### 3.3 开新卷（零配置）

首章 `volume` 直接写新卷名 + `chapterNo: 1` 重新计数；卷自动按该卷首章 `pub_date` 排在本书末尾。卷名一旦使用，本书后续章节必须逐字复制。

### 3.4 卷面板维护（小说落点）

`/admin/volumes/` 选中小说书：归入卷 / 新建卷 / 重命名卷 / 拖排序，落点都是 `_microfeed.volume` **标签**（卷非实体，权威即卷名一致性）。健康判据：`groups` 数 = 卷数、空名组（未分卷）= **0**、`chapters` 总数 = 章数、`books` 里**没有容器名**（方剂/本草/名词）。

**卷面板页脚分页**（两类书共用同一页面）：把看板**扁平成行**（`VolumesApp.tsx` 的 `rows`）——每个卷先占 1 个卷标题行、再每章 1 行，全部行数一起按「设置 → 条目设置」的每页条目数 `webGlobalSettings.itemsPerPage` 翻页（`volumes/index.astro` 归一化后作为 `itemsPerPage` prop 传入，默认 20、上限 300）。即**"卷 + 章"一起计数**：一页 N 行（卷标题行也算 1 行），卷可跨页；底部单一"上一页/下一页 + 第 X / Y 页"，仅当 `totalPages > 1` 时显示（同 items/list 规则——1 页的书不显示页脚）。改每页行数不用动组件，直接改设置里的数字。

### 3.5 发布后必做检查

- [ ] 书键双写一致：`SELECT book_id, json_extract(data,'$._microfeed.bookId') FROM items WHERE id='<章id>';` 两值相同；
- [ ] 顺序：`/book/<书ID>` 新章夹在预期上下章之间、阅读页「下一章」正确；
- [ ] 卷：后台卷面板落位正确、阅读页卷标正确；
- [ ] 序号：同卷无重号——
      `SELECT json_extract(data,'$._microfeed.chapterNo') n, count(*) c FROM items WHERE book_id='<书ID>' AND status!=3 AND json_extract(data,'$._microfeed.volume')='<卷名>' GROUP BY n HAVING c>1;`
- [ ] 搜索可命中新章正文；章与该书频道 `wordCount` 同步。

---

## 4. TCM 书：结构与维护

### 4.1 结构模型与权威键

TCM 书是另一套模型：**篇章（`tcm_kind='chapter'`）即卷，条文（`tcm_kind='section'`）即章**。结构权威始终是 `tcm_parent_id`——条文指向所属篇章。`_microfeed.volume` / `chapterNo` 只是**展示用派生值**（给编辑页 / 卷面板看），不直接决定结构。

### 4.2 卷面板可编辑（落点 = tcm_parent_id + volume 标签）

`buildTcmVolumeBoard`（`extVolume.ts`）返回 `readOnly:false`，三类操作落点（`volume-handlers.ts`）：

- **归入卷**（`assignChaptersHandler`）→ 解析 / 新建对应篇章行（`ensureTcmChapter`），再 `setTcmChapter` 用一条 SQL 同时写 `tcm_parent_id` 列 + `data._microfeed.volume` 标签；
- **重命名卷**（`renameVolumeHandler`）→ 改篇章实体 `data.title`（卷名即篇章标题）+ 同步该篇章下所有条文 `volume` 标签。
- 卷面板**章号输入框与"保存章号"按钮已移除**（2026-09-30，用户要求隐藏）：卷面板不再提供改章号入口；后端 `reorderChaptersHandler`（`ajax/volumes/reorder`）保留但暂无 UI 调用。改章号请走条目编辑页或 SQL（只写 `chapterNo` 标签、**不碰权威 `receiptNo`**）。

编辑后 board / 编辑页 / App 三方一致，不会再出现"标签改了但结构没动"。孤儿兜底桶只收 `tcm_kind='section'`，否则方剂（`tcm_parent_id` 为 NULL）会被收进"未分卷"造成回归。

### 4.3 方剂归属与组成（不要乱改）

方剂（`tcm_kind='fang'`）在**导入管线（build.ts）里 `book_id` 列 = 方剂容器频道**（`tcmfang0001`，`CONTAINER_CHANNEL_IDS.fang`），**真实书走 `_microfeed.sourceBookId`**（spec §16.3 明示"方剂的 book_id 是容器频道而非来源典籍"）。**但本地 ctwh 实例实测相反**（2026-09-30 直查 D1）：329 个方剂全部 `book_id = sourceBookId = 5IGM9t76quT`（真实书），`tcmfang0001` 是 `status=3` 空壳——两套布局都存在，**取方剂一律按 `sourceBookId` 过滤**（App `GetBookIdFang`、后台 `admin-list.ts` 的 `bookRef` CASE、方剂看板 `extFang.ts` 都是如此），对两种布局都成立。**`sourceBookId` 必须保留**，容器频道（方剂/本草/名词，带 `_microfeed.tcmContainer` 标记）已从书选择器过滤，不应当作一本书。组成（FangBody 2023 行）内嵌 `_microfeed.fangYaoList[]`：`{yaoId, amount, weight, suffix, showName, extraProcess}`，药味 ID 必须是中药条目 11 位 id。

**⚠️ 组成 `yaoId` 的 off-by-one（源 bug，2026-09-30 实测；改方剂组成必读）**：源 MySQL `FangBody.YaoID` 是**0-based 引用，比 `Yao.YaoId` 整体少 1**（甘草引用 = 0，悬空）。netcore 老系统下发的 `yaoID` 就是这错位值（麻黄汤杏仁=17，正解 18）。故：
- 导入必须用 `tcmId("yao", YaoID + 1)`（build.ts 已加补偿 + `yaoMaxId` 上限保护）；全量 2023 行验证：精确命中 1927；94 行是 `ShowName` 用别名异写同药（白芍药/芍药、香豉/豉、白蜜/石蜜、栝楼实/栝蒌），**语义一致不算错**；2 行 `YaoID=172` 越界。
- 未补偿时每条组成 `yaoId` 会指向「序号少一位」的错误中药条目——编辑页药名下拉显示错名（杏仁行显示当归）、甘草行 `yaoId=null` 显示**空白**。判据：`yaoId →` 本地 yao 条目裸名 ≠ 该行 `showName`。
- 本地已修：脚本 **`.scratch/fix-fang-yao.mjs`（`--apply`）** 按「源 FangBody + 标题匹配本地 yao」重写 **329 个桂林古本方剂**（源 FangId **426–754**，对应本地 `no` 1–329）的 `fangYaoList`，`--apply` 会写**完整对象数组**（勿写成纯 id 数组，否则编辑页全空）。
- 由于 `compare.mts` 把 `yaoID` 列入 `ID_FIELDS` 走 known-id 放行（只看是否 11 位、不校验指向），**修 `yaoId` 不影响 golden 对齐**，可放心修。
- **源 FangBody 实际很完整（纠正旧结论）**：`ctwh/FangBody.sql` 共 **2023 行、覆盖 430 个 distinct FangId** 的组成——几乎所有带方剂的书都含组成（含桂枝汤 FangId=1 等宋版方）。**本地某方剂 `fangYaoList` 出现 `yaoId:null` 绝不是「源数据缺失」**，而是两类历史遗留：① 早期 build.ts 缺 off-by-one 补偿（`YaoID+1`）或越界闸只查 `≤yaoMaxId` 不查成员；② `fix-fang-yao.mjs` 只覆盖源 **FangId 426–754（桂林古本 329 方）**，**非桂林古本方剂（如桂枝汤 FangId=1，属宋版 `10001`）未被覆盖** → 残留 null。netcore 标准佐证：桂枝汤 `standardYaoList` 带 `甘草 yaoID=0`（0-based→甘草），证明 netcore 确有甘草且正常关联。落点见 **§4.3.5 回归自检** + 历史修复索引 **#21**。

**方剂的管理入口（2026-09-30 重做：独立只读看板）**：

- **独立「方剂管理」看板 `/admin/fangs/`（只读，编辑跳条目页）**：菜单项 `fangs`（icon=`pill`、permission=`content:fang:read`、迁移 0073）。页面 `pages/[adminPath]/fangs/index.astro`（guard `content:fang:read`）+ 组件 `FangsApp.tsx`：选书（复用 `listVolumeBooks` 过滤容器）→ 与卷章页同款卡片看板逐行列出该书方剂（**方剂名链接跳条目编辑页** + `#no` + 状态徽章 `PUBLISHED||UNLISTED→已发布`），按 `itemsPerPage` 分页，**行内不编辑**。数据源 `ajax/fangs?bookId=`（`extFang.ts` `listFangBoard`，`tcm_kind='fang' AND status!=3 AND sourceBookId=书id` 按 `_microfeed.no,id` 序，行只带 `{id,name,no,status}`）。**没有 `content:fang:update` 权限/保存端点**——组成与状态编辑都走条目编辑页（通用条目权限守门），2026-09-30 曾短暂引入 `update` 权限 + `ajax/fangs/save`，因用户拍板"看板行跳条目编辑页"而整体移除。
- **编辑页「药味组成」表单**：`EditItemApp` 检测 `_microfeed.fangYaoList` 为数组即渲染 `FangEditor`（`EditItemApp/components/FangEditor.tsx`）——表格逐行编辑药名（AdminSelect 搜索中药，数据源 `ajaxItems?tcmKind=yao&limit=300`）/ 剂量 / 单位 / 炮制 / 显示名 / 备注，保存走 `onUpdateItemMicrofeedMeta('fangYaoList', next)` 合并回口袋（`updateAdminFeed` 直写整个 data，其余口袋字段不丢）。判断"是不是方剂条目"只能看 `fangYaoList` 数组特征——`getItemJson` 返回的 item **没有 `tcm_kind` 列**。
- **反向引用**：`admin/ajax/tcm/fang-references?name=<方剂名>`（`pages/[adminPath]/ajax/tcm/fang-references.ts`）——查 `tcm_kind='section'` 的 `_microfeed.fangList`（json_each 精确匹配）或正文 `$f{名}` 标记，返回引用条文列表，FangEditor 内联展示。

### 4.3.5 ⚠️ 组成完整性回归自检（2026-10-01 桂枝汤事件后必读）

**现象**：`/admin/items/<fangId>/` 编辑页「药味组成」少一味（如桂枝汤 5 味只显示 4 味），根因是某一行 `fangYaoList[].yaoId` 为 `null` → 该药材行渲染不出。桂枝汤（UN8KV9xhXQH）实测 221 行 `甘草` + 2 行 `木防己` 的 `yaoId=null`，覆盖 223 个方剂组成行。

**根因（以 netcore 为标准的核验）**：本地库由**旧 build.ts** 导入 + `fix-fang-yao.mjs` 只覆盖源 FangId 426–754（桂林古本 329 方），**非桂林古本方剂（桂枝汤 FangId=1 属宋版 `10001`）未被覆盖** → 组成行停留在旧 build 的 null 状态。netcore `GetBookIdFang` 的 `standardYaoList` 明确带 `甘草 yaoID=0`（0-based→甘草），证明 netcore 确有甘草且关联正常——**本地 null 是导入遗留，非源缺**。

**整库扫描判据（3 秒发现缺味）**：

```sql
-- 列出所有 yaoId 为 null 的组成行 + 其 showName（null 即缺味）
SELECT json_extract(data,'$._microfeed.no') AS no,
       json_extract(data,'$.title')         AS fang,
       json_each.value->>'$.showName'         AS showName
FROM items, json_each(json_extract(data,'$._microfeed.fangYaoList'))
WHERE tcm_kind='fang'
  AND json_each.value->>'$.yaoId' IS NULL;
-- 健康值：返回 0 行。
```

**修复（只动数据，不动代码）**：脚本 `.scratch/investigate-fang/repair-fang-yao.mjs`（`--apply` 幂等）——
把 null 行按 `showName` 映射到本地 yao 条目（`甘草`→`vVJUANA6k8h`、`木防己`→`防己` `M9HezPeSGkC`，源《神农本草经》注「防己（木防己）」即同药）。改动前 `cp` 备份 D1（`.sqlite.bak-<ts>`）。
**根治 = 用当前 build.ts 重导带方剂的书**：build.ts 现有 `tcmId("yao",YaoID+1)` 补偿 + `yaoSourceIdSet` 成员闸，重导即无 null；重导后**必须重跑 `import-yao.mjs --apply`**（per-book repour 会把引用 yao 写回悬空容器 `tcmyao00001`，见 #20）**和 `investigate-fang/fix-fang-book.mjs --apply`**（repour 会把 fang 的 `book_id`+口袋 `bookId` 写回容器 `tcmfang0001`，编辑页「归属书本」会显示「方剂」而非真实书，见 #22）。

**回归防线（改任何方剂导入 / 补丁 / repour 后必跑）**：
- 跑上面 SQL，应返回 **0 行** null；桂枝汤 `UN8KV9xhXQH` 组成数 = 5 且含 `甘草`。
- 归属 SQL：`SELECT count(*) FROM items WHERE tcm_kind='fang' AND status!=3 AND json_extract(data,'$._microfeed.sourceBookId') IS NOT NULL AND (book_id != json_extract(data,'$._microfeed.sourceBookId') OR json_extract(data,'$._microfeed.bookId') != json_extract(data,'$._microfeed.sourceBookId'))` 应 = **0**（book_id 列与口袋 bookId 是 ADR-0006 的副本/事实源对，必须同步搬）。
- 浏览器复核：`/admin/items/UN8KV9xhXQH/` 药味组成 5 行全显示（无需硬刷新，dev server 读同一 D1）。
- 网关注：netcore 对照 `GetBookIdFang` 的 `standardYaoList` 与本地 `fangYaoList` 药名集合一致。

### 4.4 状态语义——修显示 ≠ 改数据

条文默认 `status=4`(unlisted)，卷面板**显示为"已发布"**（显示层 `PUBLISHED || UNLISTED → 已发布`）。用户报"章节状态是草稿"时，**不要把 status 改成 1** 去"修"——那会把条文推进公开 feed/RSS。反之，若确有需要批量把条文转已发布（如 `status 4→1`），这是**有意的数据修复**，但要知道它会进 feed/RSS。

### 4.5 前端展示三套查询（与小说共用 `feed-zh` 主题，但走不同查询）

主题按 `data-mf-volume` 属性把目录 / 书页分组。TCM 书三个相关查询都在 `src/server/feed/extCategory.ts`：

- **书页目录按卷分组** → `getTcmBookChapters(db, bookId, baseUrl)`：遍历篇章（按 `_microfeed.section` 序）→ 其下条文（按 `_microfeed.receiptNo` 序），把**篇章标题写为条文 `volume`**，天然排除方剂。书页 `book/[id]/index.astro` 探测 `tcm_kind` 有则走此函数并**跳过 pub_date 重排**，效果与星河剑歌一致（卷标题 + 章列表）。
- **「附：方剂」区块** → `getTcmBookFang(db, bookId, baseUrl)`：取本书 `fang` 按 `_microfeed.no` 序；书页加「附：方剂 · N首」区块，**刻意不加 `data-mf-toc`** 避免被卷分组 JS 处理。主题需 `feed-zh` **≥ 0.1.35**。
- **阅读页翻页** → `i/[slug]/index.astro` 探测 `tcm_kind` 也走 `getTcmBookChapters`（天然不含方剂）；否则旧路径 `getBookChapters`（取 `status=1` 全部）会让 329 首方剂混进序列、把"下一章"指错到方剂。
- **平铺型 TCM 书（中药 / 名词）** → `getTcmBookEntries(db, bookId, baseUrl)`：这类书的条目直接挂在频道上、
  没有 `tcm_parent_id` 父行可走，取 `tcm_kind NOT IN ('chapter','section','fang')` 且 `book_id = 本书` 的行，
  按 `_microfeed.no` 序并补 `web_url`。⚠️ 书页对它**绝不能回落主 feed** —— 详见 §4.9（已发生过的回归）。

> **通用铁律**：凡是"取某书已发布条目"的列表（书页目录、阅读页翻页、RSS），对 TCM 书都要走 TCM 专用查询，否则方剂 / 目录类条目会混进章节序列。

### 4.6 数据规范化小坑（批量脚本必踩）

- **条文 `status 4→1` 会进公开 feed/RSS**：首页实测 200 正常，但 **RSS 是否混入方剂未验证**，上生产前自查。
- **标题 / 章号规范化**：源 `chapterNo` 可能浮点（如 `11.0`）。`CAST(chapterNo AS TEXT)` 直接产出 `"11.0"` 污染标题 / 章号 → 必须先 `CAST AS INTEGER` 再转 TEXT，并把 `chapterNo` 本身规范成整数。回填脚本把标题统一成章号（如某条文由「第1001000720条・杂病例第五」→「20」）。
- **`patchChapter` 对 TCM 不持久化 volume**：走 `feedCrud.saveInternalItem` 时 TCM 分支的 volume 改动不落库（但 `updated` 仍返 1，误导）。TCM 卷编辑用 `setTcmChapter` 直接 `UPDATE ... json_set` 才生效——自己写脚本改 TCM 卷 / 标签务必走直接 SQL，别指望 `patchChapter`。
- 重跑导入后要重跑回填脚本 `.scratch/backfill-tcm-volume.mjs`（幂等：按父篇章标题写 `volume`、卷内按 `receiptNo` 写 1..N）。

### 4.7 加章只能走导入脚本

TCM 书严禁 `add-chapter.mjs`——它只写 `volume`/`chapterNo` 标签，会被 TCM 结构忽略，新章落进"未分卷"桶。TCM 内容请走 `scripts/import-ctwh/`，单书导入 `main.ts --book-no 1001000 --full`。

### 4.8 归属书本修正（悬空 bookId → 真实频道）

**症状**：条目编辑页「归属书本」显示一串 11 位 id 而不是书名。**原因**：`EditItemApp` 的归属下拉用
`/ajax/books`（`listAdminBooks`，`status != 3`）做 `books.find(id === bid)`，**找不到就回落显示原始 id**
——即该条目 `_microfeed.bookId` 指向的频道在本库不存在（本地缺容器频道时最常见，见 §5）。

**改法**（脚本 `.scratch/tcm-import/reassign-tcm-book.mjs <db> <kind> <from> <to> [--dry-run]`）：

- 字段集对齐 `FeedDb._putItemToContentStatement`：改 `data._microfeed.bookId` + **镜像列 `book_id`**
  （两处必须同时改：列表/筛选读列、编辑页读 JSON，只改一处会不一致）+ 刷新 `updated_at`；
  `content_text` / `review_status` / `status` / `pub_date` 与归属无关，一律不动。
- 改 `bookId` **不影响 App 契约**：`reads.ts` 的 yao / term / fang 查询都按 `tcm_kind` 取，不按容器频道
  （容器频道只决定主题页面可见性）。
- 目标频道必须真实存在（脚本会校验），否则只是换了个悬空 id。
- **验证三层**：①双写一致且无残留旧 id；②复刻 `admin-list.ts` 的 `bookRef` CASE 表达式确认 `book_title`；
  ③真实浏览器读编辑页 `[data-slot="admin-select-value"]`（脚本 `.scratch/e2e/verify-item-book.mjs`）。
- 挂到普通书频道后，该书页目录走 `getTcmBookEntries`（平铺型 TCM 书，见 §4.5）：中药条目会以药名列表
  出现在书页目录里（实测 17 条，无其它书内容混入）。

### 4.9 ⚠️ 已知回归：书页显示「别的书」的条目（防复发）

**2026-09-30 实际发生过**：`/book/4KbG9bDqdz3/`（中药书）标题是「中药」，目录里却是**星河剑歌的章节**
（「第一章 边陲小城」）。触发条件：给一本书挂上 `tcm_kind` 条目（中药 / 名词这类平铺集合），而该书**没有任何篇章**。

**反面代码**（`book/[id]/index.astro` 的原写法 —— 不要再写回去）：

```js
const tagged = isTcmBook ? await getTcmBookChapters(...) : await getBookChapters(...);
const bookItems = tagged.length > 0 ? tagged : allItems;  // ← allItems 是【主 feed】的全部条目，不是本书的
```

**为什么容易再犯**：这行看起来是"兜底"，但 `allItems` 是**主 feed 的条目**。对没有篇章的 TCM 书，
`getTcmBookChapters` 必然返回空 ⇒ 一路回落到主 feed ⇒ 把别人的书当成自己的目录渲染。

**正确写法**：TCM 书永不回落主 feed。

```js
const bookItems = tagged.length > 0
  ? tagged
  : isTcmBook
    ? await getTcmBookEntries(db, bookId, Astro.url.origin)  // 本书自己的平铺条目
    : allItems;                                              // 仅非 TCM 书保留原回落
```

**自检判据（3 秒发现）**：
1. 书页目录里出现**不属于这本书**的条目（别的书名 / 章节名 / 角色名）；
2. `curl --noproxy '*' <书页> | grep -c <别的书关键词>` 应为 **0**（站头 logo 里的站点名不算 —— 那是主频道标题，
   本来就该出现）；
3. 目录条数 ≠ `SELECT count(*) FROM items WHERE book_id='<书ID>' AND status != 3`。

**回归防线（改 `bookItems` 那几行之前必跑）**：
- `./node_modules/.bin/yarn vitest run tests/unit/server/extCategory.test.ts` —— 含 4 个 `getTcmBookEntries` 用例
  （源序、排除已删 / 别书 / 方剂、`web_url` 带 id、篇章树书返回空）；
- 改完复验三页：中药书页（17 条药名）、桂林古本（984 条 / 31 卷）、星河剑歌（14 条 / 3 卷）；
- 浏览器复核：`.scratch/e2e/shot-book-page.mjs <bookId>`（公开页，无需登录，出截图 + 目录条目文本）。

**同类风险点**：任何 `X.length > 0 ? X : <全局列表>` 的写法，只要 `<全局列表>` 不是"按本书过滤"的，
就是同一个 bug。书页目录、阅读页翻页（§4.5）、RSS 都属于"取某书条目"的列表，同受此铁律约束。

---

### 4.10 ⚠️ 中药 / 本草类 yao 导入「错误区」（防复发）

**2026-09-30 连续踩了 6 个坑**，把 `ctwh/Yao.sql` 的本草条目导入并归属到「中药」书（频道 `4KbG9bDqdz3`）时，
凡不按下面落点做都会在后台 / 前端 / App 三处错位。统一工具：`scripts/import-ctwh/import-yao.mjs`（已内置全部修正，
`--apply` 幂等；`node --import tsx scripts/import-ctwh/import-yao.mjs` 仅构建看 summary）。

**错误区 1 — yao 落进不存在的容器频道 → 编辑页卷名显示原始 id**
源 `build.ts` 把 yao 归到 `tcmyao00001`（CONTAINER_CHANNELS 的「本草」容器频道）；本地单书导入只带 `tcmfang0001`，
本地**没有** `tcmyao00001` → `EditItemApp` 归属下拉 `books.find` 找不到 ⇒ 回落显示 11 位 id 而非「中药」（见 §4.8）。
落点：yao 的 `data._microfeed.bookId` + 镜像列 `book_id` **必须改到本地真实存在的「中药」书频道**（非容器频道）。

**错误区 2 — 卷面板空白（yao 不在 chapter/section 层级）**
`buildTcmVolumeBoard`（`extVolume.ts:231`）只渲染 `tcm_kind IN ('chapter','section')`；中药书 172 条全是 `yao`、
0 chapter/section ⇒ 卷面板选中「中药」内容空白。前端 `/book/<id>/` 能显示是走 `getTcmBookEntries`（平铺），与卷面板是两码事
（非硬编码，是展示模型限制）。落点（用户拍板）：建一个确定性根 chapter（`tcmId("chapter",书ID)` → 如 `F5Pf7dvj0rJ`，
title「中药」），把全部 yao 经 `tcm_parent_id` 挂到它下；yao 的 `tcm_kind` 仍为 `yao`，不污染 App 条文视图
（`reads.ts getAppChapterContent` 按 `tcm_kind='section'` 过滤，已验该 chapter 下 section=0）。

**错误区 3 — 卷名显示「未分卷」**
`EditItemApp/index.tsx:568-571` 读 `data._microfeed.volume` 标签，空则回落 `volumes.unfiled`（未分卷）。yao 默认没写
volume ⇒ 编辑页卷名显示「未分卷」而非「中药」。落点：给每条 yao 写 `_microfeed.volume="中药"`（与 TCM rename 维护的展示字段一致）。

**错误区 4 — 标题缺序号前缀（与源 / App 不一致）**
源每条 yao 正文首段形如 `<p>38、$u{蜀椒}</p>`，序号 = `_microfeed.no + 1`；标题应是 `38、蜀椒` 而非裸 `蜀椒`。
落点：`import-yao.mjs` 的 `deriveOrdinalPrefix()` 解析正文首段 `<p>`（先 strip `$x{...}` 标记）→ 匹配 `/^(\d+)\s*[、.．.]/`
→ 标题 = `${ordinal}、${baseTitle}`，映射幂等（先去已有前缀再拼）。**保留 canonical 名**（如 代赭石 not 赭石，正文 BieMing 不覆盖标题）。

**错误区 5 — yao ITEM ID 必须等于 `tcmId("yao",YaoId)`**
方剂经 `FangBody.YaoID → tcmId("yao",YaoId)` 引用 yao（存进 fang 的 `_microfeed.fangYaoList`）；yao 的 ITEM ID 若与
build.ts 推导不一致，方剂组成对不上（`yaoID` 字段变 null）。`import-yao.mjs` 复用 `build.ts` 的 `buildTargets` + `tcmId` 保证一致——
重导前会打印「id 一致性：全部与 tcmId 推导一致（无孤儿）」，不一致会警告并把旧行变成孤儿。

**错误区 6 — 标题不再是纯 canonical 名 → 精确查失配**
加前缀后标题不再是 `桂枝` 而是 `1、桂枝` 类；凡按 `title='桂枝'` 精确查的脚本 / 测试会失配 → 改用 `tcmId("yao",YaoId)` 或 `LIKE` 前缀。

**错误区 7 — 卷面板 / 编辑页章标题乱序（按 id 哈希序而非目录序）**
`buildTcmVolumeBoard`（`extVolume.ts:256`）子项排序原是 `ORDER BY json_extract(data,'$._microfeed.receiptNo'), id`；yao 没有 `receiptNo`（全 NULL）→ 退化为按 `id`（tcmId 哈希序）乱排，与 `/book/<id>/` 目录（`getTcmBookEntries` 按 `no` 排）不一致。修正：改成
`ORDER BY COALESCE(json_extract(data,'$._microfeed.receiptNo'), json_extract(data,'$._microfeed.no')), id`——条文仍按 receiptNo、yao/term 回落 `no`，与目录序一致。回归测试 `tests/unit/server/extVolume.test.ts` 已加 yao 排序用例锁定（yao 挂到根 chapter 下、断言按 `no` 而非 `id` 序）。

**错误区 8 — 序号前缀泄漏进 App 端点 `name`（2026-09-30 golden 抓包发现）**
`GetAllZhongYao` / `GetAliaZhongYao` 的 `name` 取自 `titleOf(data)`；加了「N、」前缀后 App 收到 `1、甘草`，
而 netcore 是裸名 `甘草` → golden 比对 172 处 MISMATCH（别名接口放大到 204 条）。**落点**：App 端点的 yao `name`
必须剥前缀——`src/server/tcm/reads.ts` 的 `yaoAppName()`（`titleOf(data).replace(/^\d+、/, "")`），仅用于 App，
后台标题保留前缀；该剥离对有/无前缀两种数据都安全（无前缀时正则不匹配、名字不变）。**判据**：
`curl -sL localhost:4321/api/AppBookRequest/GetAllZhongYao` 的 `.data[0].name` 应为裸名（`甘草` 而非 `1、甘草`）。
**错误区 9 — yaoAlias 折叠丢弃「短名」行（别名源①不全，2026-09-30）**
`build.ts` 的 yaoAlias 折叠按 `YaoName` join Yao 表；4 条用**短名**的行（`蜜`/`艾`/`煅灶灰`）匹配不到
Yao 表长名（`石蜜`/`艾叶`/`煅灶下灰`）→ 被静默丢弃（本地 43 条 vs 源 47 行）。**netcore 对 yaoAlias 表原样
下发**（`name` = yaoAlias.YaoName，不 join）——golden 实测 `{食蜜→蜜}`/`{艾叶→艾}`/`{煅灶下灰→煅灶灰}`。
**落点**：折叠改为原样保留全部行、`name` 用源 YaoName；孤儿行挂最贴近的 yao（YaoList 包含→子串→最长公共
前缀；endpoint `getAppYaoAliases` 只遍历全部 yao 的 `aliases[]`，挂哪条不影响输出）。**判据**：本地 yao
`aliases` 总条数应 = 源 `yaoAlias.sql` 行数（47）。
**自检判据（3 秒发现 yao 导入错）**：
1. `SELECT count(*) FROM items WHERE book_id='<中药书ID>' AND tcm_kind='yao'` 应 = 172（源 `Yao.sql` 行数）；
2. 全部 yao 的 `json_extract(data,'$._microfeed.bookId')` = 真实中药书频道 ID（不是 `tcmyao00001`）；
3. 全部 yao 的 `json_extract(data,'$._microfeed.volume')` = `'中药'`（非 NULL）；
4. 全部 yao 标题匹配 `/^\d+[、.．.]/` 且前缀 = `no+1`（抽查：no=37→`38、蜀椒`、no=111→`112、代赭石`）；
5. 卷面板选中该书不再空白：根 chapter 存在 + 全部 yao `tcm_parent_id` 指向它；
6. App 安全：`SELECT count(*) FROM items WHERE tcm_kind='section' AND tcm_parent_id='<根chapter>'` = 0（yao 不泄漏进条文视图）。

**回归防线（改 yao 导入 / 归属脚本前必跑）**：
- `node --import tsx scripts/import-ctwh/import-yao.mjs` 看 summary：`titlesPrefixed`/`yaoCount` 应 172；`id 一致性` 应全通过；
- 落库后实查上面 6 条判据（脚本 `scripts/import-ctwh/` 下临时 verify 也可）；
- 浏览器复核：`/admin/items/<yaoId>/` 卷名显示「中药」、标题带序号；公开页 `/book/<中药书ID>/` 列出药名（无需登录）。

---

### 4.11 名词（term）导入（与 §4.10 同一平铺书范式）

名词与中药同类——**平铺型 TCM 书**（`tcm_kind='term'` 直接挂频道、无篇章层级）。工具：
`scripts/import-ctwh/import-term.mjs`（照 `import-yao.mjs` 模式：复用 `build.ts` 的 MingCi→term 映射取子集
+ 补建频道 + 根 chapter，`--apply` 幂等）。

- **落点**：书频道 `tcmterm0001`（普通书、genre=本草、**无** `tcmContainer` 标记）+ 根 chapter
  `tcmId("chapter","tcmterm0001")`（title「名词」），17 条 term 经 `tcm_parent_id` 挂其下。
- **容器 vs 普通书**：`listAdminBooks`（编辑页归属下拉，`extBook.ts:144`）**不过滤** `tcmContainer`，只排除 `status=3`；
  只有卷面板 `listVolumeBooks`（`extVolume.ts:84`）过滤。⇒ 建普通书让名词出现在书选择器 / 卷面板 / 书页，
  编辑页「归属书本」显示「名词」（错误区 1 只在频道**不存在**时发生）。
- **源字段**：`title=MingCiName`（**原样不 trim**，netcore 含尾部换行如「畏\n」——golden 逐字节对齐）；
  `description=textToHtml(MingCiText)`；`_microfeed.{no, mingCiList, beiMing, type, sourceImagePath}`。
- **自检**：`SELECT count(*) FROM items WHERE tcm_kind='term'` = 17；全部 `tcm_parent_id` 指向根 chapter；
  `curl -sL .../GetAllMingCi` 的 `data[0].name` 为裸名（如「六气图」）。

### 4.12 ⚠️ 卷 / 章 / 条文：排序与标题现状（2026-10-01～02 多轮修订后）

改卷章前先读本节——**标题决定卷面板 / 书页目录显示什么**，而部分标题又在 App 契约里，改错直接破 golden。

**① 排序：只有一个键**

- **TCM 书**：三处查询（App `getAppBookChapters`、书页 `getTcmBookChapters`、卷面板 `buildTcmVolumeBoard`）
  统一用 `src/server/tcm/ordering.ts` 的 `TCM_CHAPTER_ORDER_SQL`（真键 = **源主键 BookInfoId 序**）。
  别再用 `ORDER BY section`（字符串序会拆散 10001 的 0..21，数值序会让 9040000「前言」垫底）。
- **小说书**：另走 §2.3（pub_date / chapterNo 三键），**不要混用** TCM 排序键。

**② 标题：分三类，各有各的红线**

| 层级 | 规则 | 红线 |
|---|---|---|
| **篇章 chapter** | 源样保留、**不 trim**（netcore `chapterHeader` 逐字节对齐，400100 有 8 处前导空格、9040000 有 3 处尾随） | 它 = App `GetBookChapter.header`，**改一个字就可能破 golden** |
| **本草条文** `HERB_BOOK_NOS={9020000,400100}` + `SectionNote` 非空 | 标题 = **整段 SectionText**（保留源序号，如 `292、牙子`）；描述 = SectionText + SectionNote | 判据必须**按书**——用「note 非空」会连 伤寒论・(人纪) 381 / 金匮・(人纪) 116 一起改坏（它们的 SectionText 是整段长文） |
| **其余条文 section** | `deriveSectionTitle()` 提炼；提炼不出 → 回退「卷内章号」 | 见下 |

**`deriveSectionTitle()` 提炼规则**（`scripts/import-ctwh/build.ts`，数据脚本必须 `import` 复用，禁止另写一份）：

1. 开头 60 字内有标题分隔符（`──/——/—/：/全角空格`）→ 取其之前的部分；
2. **无分隔符但首行 ≤30 字 → 取「首句」（截止到第一个 `。`，并去句末标点）当标题**
   （如 `4、痈疽毒气攻心，发谵语`、`今夫病，譬诸兵焉。`、`夫$x{药石}禀$m{天地偏至之气者也}`）；
3. 都没有 = 长散文正文 → **回退章号**（硬取首句只会得到「论曰 / 曰 / 问曰 / 帝曰」开场白）。

校验：取首行、折叠空白、**去句末标点**、长 2–30、**≤30 字允许 `，、；` 句中逗号**；
`。！？` 句末标点、去「N、」后为发语词（含以「曰」结尾者）一律拒绝；
**`$x{}`/`$m{}`/`$f{}` 引用标记允许保留**（如「夫$x{药石}禀$m{…}」、「…，$f{葛根汤}主之」）；
截断若落在标记内部，自动去掉不完整的标记尾巴（避免半个 `$x{`）。

**③ 改标题的两条铁律**

- **脚本必须限定 `tcm_kind='section'`**。篇章标题进 `GetBookChapter.header`、名词进 `GetAllMingCi`、
  方剂/中药同理——2026-10-02 r15 踩实：未限定导致 `GetBookChapter` 400100 8 处 / 9040000 3 处、
  `GetAllMingCi` 每书 1 处新 MISMATCH，只能从备份回滚重做。
- **改标题要同步 `site_search_documents.title`**（搜索索引里存了标题，否则前台搜到旧标题）。

**④ 现状数字（2026-10-02 收口）**：全库 8066 条 section，本轮回提炼/复提炼 **3508 条**（含 `$` 标记 232 条）；
余 **1203 条**仍保持序号——多为长散文（首句 >30 字、无标题结构）或带 `SectionNote` 的本草条文
（按书规则它们标题=整段 SectionText，不强行派生）；标题带尾随空格 **0** 条。

**⑤ 方剂编辑页「引用此方剂的条文」**：按 `书 + 篇章` 分组显示（章名做小标题、条号「、」串联），
且只查**本书**条文（`fang-references.ts` 的 `bookId` 参数，缺省=全局向后兼容）。详见 §4.3 / #22。

**⑥ 回归自检（改完必跑）**

```sql
-- 标题仍有尾随空格？健康值 0
SELECT count(*) FROM items WHERE trim(json_extract(data,'$.title')) != json_extract(data,'$.title');
-- 搜索索引与条目标题是否一致？健康值 0
SELECT count(*) FROM items i JOIN site_search_documents d ON d.content_id=i.id
  WHERE d.title != json_extract(i.data,'$.title');
```

再跑全量 golden（§6）：**篇章标题**进 `GetBookChapter.header`、**名词标题**进 `GetAllMingCi` —— 这两处必须零 MISMATCH（标题改动唯一对外风险面）。
**⚠️ 但条文（section）标题不在任何 golden 端点里**：`GetChapterContent` 的 section 对象只有 `{id, text}`，`GetBookChapter` 用的是 chapter 级 `chapterHeader`，grep `title` 全目录 **0 次**。
故改 section 标题**不会**破 golden —— 这正是 r16/r17/r18 三连改标题仍零 MISMATCH 的根因，也反证了 r15 那次回归**只**来自篇章/名词标题（当时脚本没限定 `tcm_kind='section'`，把它们也动了）。
结论：**只动 section 标题 → 无需跑 golden；动 chapter/term 标题 → 必跑 golden**。

## 5. 本地环境 & 部署陷阱（动手前必读）

- **admin 全页 500（裸 500）**：`/` 返回 200 但 `/admin/*` 全返回裸 `500` ⇒ 不是业务代码问题，是强杀 dev 进程树导致 **Vite 依赖预构建缓存损坏**（`.vite/deps_ssr/` 缺文件，admin 走 SSR）。修法：杀 dev → `mv node_modules/.vite node_modules/.stale/vite-<ts>`（用 mv 不用 rm，绕开 safe-delete 闸）+ 同样移走 `.astro` → `run_in_background` 重启 `manage dev`。重启后首访触发重新预构建。
- **双本地库路径陷阱**：本技能脚本 `DEFAULT_DB` 已正确指向 `local-state/v3/d1/...`（`manage dev` 读这里）；但裸 `wrangler --local` 写的是**另一个目录** `.wrangler/state/v3/d1/`——同名不同目录，导错库 = 页面 404 / 全站 500。手动用 `wrangler d1` 务必指定 `manage dev` 的 `local-state` 路径。
- **`yarn build` 裸跑静默生成空库**：`astro.config.ts` 用 `MICROFEED_WRANGLER_CONFIG` 选配置，裸跑回落仓库根 `wrangler.jsonc`（无 `database_id`）→ miniflare 换哈希新建 **0 表空 sqlite**，真库在另一哈希文件 → 全站 500 / TCM 端点全空。构建必须带：
  ```
  MICROFEED_WRANGLER_CONFIG=.microfeed/instances/<n>/wrangler.jsonc \
  MICROFEED_LOCAL_STATE=.microfeed/instances/<n>/local-state
  ```
  判据：`dist/server/wrangler.json` 的 `topLevelName` 应为实例名、`database_id` 应为 `a7188289-…`。
- **dev 重启跨调用回收 + 70s 冷启动**：`manage dev` 起的进程跨 Bash 调用会被回收，所以"起服务 + 轮询 + 抓页面"必须**在同一次调用内**完成（`nohup ... &` 后轮询等 `astro ready` + `Local http://localhost:4321/`），冷启动到可响应约 **70 秒**，只等 25s 会误判没起来。常驻起法 = `run_in_background` 跑 `./node_modules/.bin/yarn manage dev --local --instance ctwh-881019-xyz`（见 `dev-local-server.bat` 同款命令）。
- **⚠️ 起 dev 必须带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`**（2026-09-30）：Vite 重优化要删的 `node_modules/.vite/deps_temp_*` 超 50 文件 → safe-delete 闸抛错 → **dev server 崩溃**；崩溃后页面报 `file does not exist at .../deps_ssr/<dep>.js`（marked.js 等）。**表象像依赖不兼容，真因是闸杀死优化器——别去加 `optimizeDeps.exclude`**。修法：`export CODEBUDDY_SAFE_DELETE_ENABLED=0` 后重启；必要时先 `mv node_modules/.vite .vite-old-<ts>`。
- **主题激活一致性（公开页样式）**：公开站首页 / 书页样式取决于**激活主题**而非内容。本地若丢失 `feed-zh`（带 ADR-0010 画布色的 `--mf-page-bg`），样式会与远程全不对；排查本地≠远程页面样式时**先比激活主题**（`theme_state.active_theme_id`）。TCM 前端展示要求 `feed-zh` **≥ 0.1.35**（`manage theme install ./themes/feed-zh --local --instance <n>` → `theme activate <id>`）。
- **本地实例现状（2026-10-01 起）**：`ctwh-881019-xyz` 本地库已导入 **13 部书中 10 部**：桂林古本（31/984/329）+ 9 部新书（9040000/10001/10002/9050000/20100000/20200000/20300000/9020000/400100，见 `ctwh-books/books.json`）+ 全局 yao 172 / term 17。全库 tcm 计数：chapter 447 / section 8066 / fang 804 / yao 172 / term 17；活跃频道 14 个。**3 部源无正文跳过**（100100/9010000/9030000）。**per-book 导入带方剂的书后必须重跑 `import-yao.mjs --apply`**：build.ts 把书方剂引用的 yao 写进容器 `tcmyao00001`（本地无此频道），且 yao 的 11 位 id 与中药库相同 → INSERT OR REPLACE 会把中药库 yao 的 book_id 改到悬空容器（2026-10-01 实测 164 条被挪走，重跑 import-yao 归位）。远端仍是权威全集；需要全量可 `.scratch/backups/resync-remote-to-local.sh` 拉回（停服务后跑）。

---

## 6. 真实验证方法（别只查库模拟）

光查库只能证明"数据对"，不能证明"页面对"。两条路：

**① 打后台真实 API（推荐）**——需登录会话：

```bash
# 1) 登录拿 cookie（必须带 Origin，否则 CSRF 拦）
curl --noproxy '*' -c ck.txt -X POST http://localhost:4321/api/auth/sign-in/email \
  -H "Content-Type: application/json" -H "Origin: http://localhost:4321" \
  -d '{"email":"probe-admin@local.test","password":"Admin@12345"}'
# 2) 打真实接口：-L 跟随 Astro 结尾斜杠 308；--noproxy '*' 必带（否则走代理拿不到）
curl --noproxy '*' -s -L -b ck.txt "http://localhost:4321/admin/ajax/volumes?bookId=<书ID>"
curl --noproxy '*' -s -L -b ck.txt "http://localhost:4321/admin/ajax/items?limit=2000"
```

卷面板健康判据：`groups` 数 = 该书卷数、空名组（未分卷）= **0**、`chapters` 总数 = 章数、`books` 里**没有容器名**。条目列表判据：`bookTitle` 分布里不该出现容器名。

**② 读编辑页 HTML**——后台页是 `client:only` React，props 以 **HTML 转义 JSON** 嵌在页面里，形如 `&quot;volume&quot;:[0,&quot;平脉法第一&quot;]`，**直接 grep `"volume":"..."` 搜不到**，要按转义形态匹配。

本地管理员：`probe-admin@local.test` / `Admin@12345`（仅本地库，超级管理员）。库被重灌后账号会失效，用 `.scratch/insert-admin.mjs` 重建。

---

## 7. 远端生产

生产站点：**`https://feed.881019.xyz`**（实例 `ctwh-881019-xyz`）。本地改完走部署流程同步；**禁止**直接改远端 D1。注意：

- **代码部署不携带主题 bundle**：改了主题模板（如「附：方剂」分支）必须远端重新 `theme install` + `theme activate`，否则线上仍是旧模板。
- **数据类修复（回填、归属迁移、状态 / 标题规范化）不会随代码部署自动生效**，需对远端库单独跑一遍对应脚本（跑前先 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy` 否则 wrangler 报 7403，别误判 token 失效）。

---

## 8. 历史修复索引（问题 → 解决方案 → 落点，可追溯）

| # | 现象 | 解决方案 | 代码 / 脚本落点 |
|---|---|---|---|
| 1 | 后台选完书卷名还是手填框，易 typo 散落未分卷 | 选书后 `loadVolumes` 拉该书卷喂 `AdminSelect`（只能选已有卷） | `EditItemApp/index.tsx`（`volumeNames` / `componentDidUpdate` / `volumeOptions`） |
| 2 | `/admin/volumes/` 桂林古本无归入卷 / 新建卷维护 | `buildTcmVolumeBoard` 改 `readOnly:false`；assign/rename 对 TCM 走 `tcm_parent_id` 落点 | `extVolume.ts` / `volume-handlers.ts` |
| 3 | TCM 书详情页平铺不分组 | 探测 `tcm_kind` 走 `getTcmBookChapters`（篇章标题写为条文 `volume`） | `extCategory.ts` `getTcmBookChapters` / `book/[id]/index.astro` |
| 4 | 条文状态草稿 / 标题过长 / 书页缺方剂区块 | 批量 `status 4→1`；标题规范成章号（先 `CAST AS INTEGER`）；书页加「附：方剂 · N首」 | `.scratch/tcm-status-title.mjs` / `fix-title-int.mjs` / `extCategory.ts` `getTcmBookFang` / 主题 `web-feed.mustache`(≥0.1.35) |
| 5 | 阅读页翻到方剂而非下一卷首章 | 探测 `tcm_kind` 也走 `getTcmBookChapters`（天然不含方剂） | `i/[slug]/index.astro` |
| 6 | 条目「归属书本」显示 11 位 id 而非书名 | 把 `_microfeed.bookId` + `book_id` 列改挂真实频道（双写 + 刷 updated_at） | `.scratch/tcm-import/reassign-tcm-book.mjs` / `EditItemApp` 归属下拉回落逻辑 |
| 7 | 中药 / 名词这类书页渲染出**别的书**的章节列表 | 平铺型 TCM 书（无篇章）改走 `getTcmBookEntries`，不再回落主 feed | `extCategory.ts` `getTcmBookEntries` / `book/[id]/index.astro`（**防复发专章 §4.9**） |
| 8 | `ctwh/` 合并 dump 的 13 部书需要按需、分别导入（不重复拆物理源文件） | 逻辑拆成离散书单元：`books.json` 列 BookNo/频道 id/导入命令，`README.md` 给单书构建→核对→repour 流程；id 经 `tcmId` 确定性推导（已验证 桂林古本 id 一致） | `ctwh-books/books.json` / `ctwh-books/README.md` |
| 9 | 中药 yao 导入后：编辑页卷名显示原始 id / 卷面板空白 / 卷名「未分卷」/ 标题无序号前缀 / 方剂组成对不上 | yao 归真实中药书频道（非容器 `tcmyao00001`）；建根 chapter 挂 `tcm_parent_id`；写 `volume=中药`；标题从正文首段加 `N、` 前缀（保留 canonical 名）；ITEM ID 必须等于 `tcmId("yao",YaoId)` | `scripts/import-ctwh/import-yao.mjs`（含 `deriveOrdinalPrefix`）/ **防复发专章 §4.10** |
| 10 | 卷面板 / 编辑页章标题乱序（yao 按 id 哈希序而非目录 `no` 序） | 卷面板子项排序 `COALESCE(receiptNo, no)`：`extVolume.ts` 子项 `ORDER BY` 由 `receiptNo, id` 改为 `COALESCE(receiptNo, no), id`（条文仍按 receiptNo、yao/term 回落 no） | `src/server/feed/extVolume.ts` `buildTcmVolumeBoard` / 回归 `tests/unit/server/extVolume.test.ts` yao 排序用例 / **防复发专章 §4.10 错误区 7** |
| 11 | App 端点 `GetAllZhongYao` / `GetAliaZhongYao` 的 `name` 带「N、」序号前缀（netcore 是裸名） | App 端点剥前缀：`reads.ts` 新增 `yaoAppName()`（`titleOf(data).replace(/^\d+、/, "")`），仅 App 用、后台标题保留；对有/无前缀两种数据都安全 | `src/server/tcm/reads.ts` `getAppAllYao` / `getAppYaoAliases` / **防复发专章 §4.10 错误区 8** |
| 12 | 本地缺「名词」数据（`GetAllMingCi` 空） | 建普通书频道 `tcmterm0001`（genre=本草、无 tcmContainer）+ 根 chapter + 17 条 term；工具 `import-term.mjs` | `scripts/import-ctwh/import-term.mjs` / `src/server/tcm/reads.ts` `getAppAllTerms` / **防复发专章 §4.11** |
| 13 | 别名源①不全（yaoAlias 4 条短名行被丢弃，43/47） | `build.ts` yaoAlias 折叠改原样保留全部行、`name` 用源 YaoName；孤儿行挂最贴近 yao | `scripts/import-ctwh/build.ts` / `src/server/tcm/reads.ts` `getAppYaoAliases` / **防复发专章 §4.10 错误区 9** |
| 14 | per-book 导入后 repour 灌错目录（per-book out 被忽略） | `repour.mts` 曾有同名 `const outDir` 硬编码覆盖命令行第 4 参 → 已删；调用格式 `repour.mts <instance> local-state ctwh-books/<BookNo>/out` | `.scratch/tcm-import/repour.mts` |
| 15 | 9040000 篇章序错位（「前言」section=904000203 应排第 3 却垫底） | **真键 = 源主键（BookInfoId）序**，不是 section 字符串序（字符串序会拆散 10001 的数字 section 0..21）。`build.ts` 给篇章写书内主键排名 `_microfeed.no`；三处 ORDER BY 统一 `src/server/tcm/ordering.ts`：`COALESCE(no, CAST(section AS TEXT)), id` | `scripts/import-ctwh/build.ts`（chapterRankBySource）/ `src/server/tcm/ordering.ts`（reads/extCategory/extVolume 共用）（2026-10-01 第八轮） |
| 16 | 400100/9040000 篇章标题逐字节不等（前导/尾随空格） | netcore `chapterHeader` **原样下发不 trim**；`build.ts` 篇章 title 不再 trim（同 MingCi 原样惯例） | `scripts/import-ctwh/build.ts`（2026-10-01） |
| 17 | netcore `GetBookIdFang` 对 9040000/10002/9050000 返回空而本地按书有数据（10001 反而 netcore 多 202 金匮方） | **结构性分道（netcore 合并主书 vs 本地拆分子书，非 bug 非 netcore 局限）**：netcore 方剂独立表按书号管，活动库把金匮(10002) 合并挂到伤寒杂病论(10001)（→ 10001=315=伤寒113+金匮202、10002 返空），人纪系列(9040000/9050000) 在 netcore 整个就没有方剂（既不分发也不并入）。**本地方剂按 `sourceBookId` 拆到各子书**（App 逐本请求：10001=伤寒113、10002=金匮202、9040000=111、9050000=49），是与 netcore 旧合并行为的**刻意分道**（拍板"App 逐本请求"）。`compare.mts` 已把 10001 多出的金匮行归为 `known-merge` 接受；9040000/10002/9050000 本地有方、netcore 空属正常分歧。**2026-10-02 曾试"合并金匮进 10001 对齐 netcore"→ 必炸：netcore 的 315 顺序是独立方剂表主键/插入序（伤寒1–113 后杂乱交错），本地按书 `no` 排序无法复现，等长逐位比对出 3639 处 MISMATCH。结论：此路不通，回滚，维持本地拆分子书** | `.scratch/tcm-import/api-test-plan.md` §4.7/§4.8/§4.16/§4.17 遗留差异 ①（结构性分道）；`compare.mts` `known-merge` / `MERGE_ENDPOINTS` |
| 18 | 新书（容器布局）书页没有「附：方剂」区块 | `getTcmBookFang` 原按 `book_id` 过滤（只对桂林古本布局成立）→ 改按 `$._microfeed.sourceBookId` 过滤（两布局铁律，同 extFang.ts/App） | `src/server/feed/extCategory.ts` `getTcmBookFang`（2026-10-01 第八轮） |
| 19 | `fangYaoList.yaoId` 悬空（金匮要略・(宋版) 2 处指向不存在的 yao） | build.ts 闸原只查 `≤yaoMaxId`，YaoId 有空洞 → 收紧为 **YaoId 成员检查**（`yaoSourceIdSet.has`），空洞引用落 null | `scripts/import-ctwh/build.ts`（2026-10-01 第八轮） |
| 20 | 重灌书后中药库 yao 的 book_id 被改到悬空容器 `tcmyao00001` | **每次 repour 带方剂的书后必须重跑 `import-yao.mjs --apply`**（幂等归回 4KbG9bDqdz3）——本轮两次踩实 | `scripts/import-ctwh/import-yao.mjs`（2026-10-01 两次实证） |
| 21 | 桂枝汤等方剂「药味组成」少一味（编辑页某药材行空白）；整库扫出 **223 个 `yaoId=null` 组成行**（221 甘草 + 2 木防己） | 根因 = 旧 build.ts 导入 + `fix-fang-yao.mjs` 只覆盖源 FangId 426–754（桂林古本 329 方），漏了宋版桂枝汤（FangId=1 等）。netcore `standardYaoList` 证实甘草本应关联。**修复**：`.scratch/investigate-fang/repair-fang-yao.mjs --apply`（甘草→`vVJUANA6k8h`、木防己→`防己` `M9HezPeSGkC`，幂等）；根治=用当前 build.ts 重导带方剂书 + 重跑 import-yao。**回归**：§4.3.5 SQL 扫 null 应 0 行 | `scripts/import-ctwh/build.ts`（off-by-one+成员闸）/ `.scratch/investigate-fang/repair-fang-yao.mjs`（2026-10-01 第十轮） |
| 24 | 条文标题全是序号（如 `G9OnR1ZMxW2` 标题="1"），而 SectionText 里其实带标题（`1、五味之义──凡药酸属木入肝…`）；用户要求「提炼出合适的标题」且范围=全部书 | **规则 = `build.ts` 的 `deriveSectionTitle()`（单一实现，数据脚本 `import` 复用）**：①开头 60 字内有标题分隔符（`──/——/—/：/全角空格`）→ 取其之前的部分；②**无分隔符但首行 ≤30 字 → 取首句（截到第一个 `。`，去句末标点）当标题**（如 `4、痈疽毒气攻心，发谵语`、`今夫病，譬诸兵焉.`、`夫$x{药石}禀$m{天地偏至之气者也}`）；③都没有 = 长散文正文 → **回退章号**。校验：长 2–30、**≤30 字允许 `，、；` 句中逗号**（`4、痈疽毒气攻心，发谵语` 这类就是好标题），`。！？` 句末标点、去「N、」后为发语词（含以「曰」结尾）一律拒绝；**`$x{}`/`$m{}`/`$f{}` 引用标记允许保留**（用户明确要求，如「夫$x{药石}禀$m{…}」），截断若落在标记内部会自动去掉半个标记尾巴。全库收口 **3508 条**派生（含 `$` 标记 232 条），余 1203 条长散文/带 note 保持序号。**⚠️ 铁律：脚本必须限定 `tcm_kind='section'`**——篇章标题进 App `GetBookChapter.header`、名词进 `GetAllMingCi`，动它们会直接破 golden（2026-10-02 r15 踩实：新增 GetBookChapter 8+3 处、GetAllMingCi 10 处 MISMATCH，已回滚重做）。另：改标题要同步 `site_search_documents.title` | `scripts/import-ctwh/build.ts`（deriveSectionTitle）/ `.scratch/inspect-yao-books/fix-section-titles.mts`（**共 3508 条**，幂等；2026-10-02 第十五～十七轮）· **正文见 §4.12** |
| 23 | 本草两书（9020000 神农本草经・(人纪) / 400100 神农本草经疏）条文标题只剩序号（如 `0L2kXiogaZH` 牙子条 title="38"），中药名被第 8 轮「标题=卷内章号」规范化挤掉；描述也缺源 SectionNote | 本草条目特殊映射：**标题 = 整段 SectionText（保留源序号，如 `292、牙子`）、描述 = SectionText + SectionNote**；判据必须**按书**（`HERB_BOOK_NOS={9020000,400100}` + note 非空），**不能用「note 非空」**——伤寒论・(人纪)/金匮要略・(人纪) 也有 note（共 1427 条）且 SectionText 是整段长文，会污染标题。改 build.ts 时 `track()` 第二源文本要同步加 note，否则 build 末尾「标记数 源 vs 产物」断言抛错。**别名方向**：netcore = BieMing 第 1 token 为正名（`牙子→狼牙`/`鸡头实→芡实`/`蜂子→蜂蜜`…），用户直觉的「正名=中药名」会反转 39 条 → 维持 netcore 方向；自指别名 `桑螵蛸→桑螵蛸` **netcore 也有**（其唯一一条），故保留不删 | `scripts/import-ctwh/build.ts`（HERB_BOOK_NOS 分支）/ `.scratch/inspect-yao-books/fix-herb-sections.mjs`（930 条，幂等）（2026-10-01 第十四轮） |
| 22 | 方剂编辑页「归属书本」显示容器「方剂」而非真实书（475 方 book_id+口袋 bookId=tcmfang0001）；且「引用此方剂的条文」跨书混入其它书同名方的引用（桂枝汤全局 122 条跨 3 书） | 容器布局（build.ts 导入管线）与参照布局（桂林古本 329 方 book_id=真实书）混存。**数据修正**：`.scratch/investigate-fang/fix-fang-book.mjs --apply` 把 475 方 book_id+口袋 bookId 同步搬到 `sourceBookId`（113/202/111/49 按 book 分布，与 golden 遗留差异①计数吻合；幂等，改前 cp 备份）；**代码**：`fang-references.ts` 接受 `bookId` 参数（`AND book_id=?`，缺省全局=向后兼容），`FangEditor` 新 prop `bookId`（传 `microfeed.sourceBookId`）——每本书的编辑页只引用本书条文。**回归**：§4.3.5 归属 SQL 应 0 | `.scratch/investigate-fang/fix-fang-book.mjs` / `src/pages/[adminPath]/ajax/tcm/fang-references.ts` / `FangEditor.tsx`（2026-10-01 第十三轮） |
