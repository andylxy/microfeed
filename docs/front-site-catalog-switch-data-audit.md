# 前台内容引擎切换：数据完整性核准报告

> 配套 [ADR-0066](./novel-cms/adr/0066-front-site-standalone-module-engine.md) 与 [技术规范](./front-site-catalog-switch.md)。
> 本文只做一件事：把「切换后会不会缺数据、会不会出异常」逐项量出来，每个结论后面跟数字与可重跑的探针。
> 核准日期：2026-11-07。核准对象：本地实例库 `ctwh-881019-xyz` 的 D1（只读探针，无写入）。

## 0. 结论摘要

| # | 结论 | 数字 |
| --- | --- | --- |
| 1 | 书 ID 两侧相同，书页地址不失效 | 12/12 命中，`book_info` 无孤儿 |
| 2 | **卷 ID 两侧完全不相交**，445 个卷页地址失效（D1-A） | 交集 0/445 |
| 3 | **条文 ID 两侧完全不相交**，8,066 个锚点失效（D1-A） | 交集 0/8066 |
| 4 | 方剂/中药/名词 ID 两侧完全不相交，993 个条目页地址失效；分类地址由 id 变 key，另 3 个失效 | 交集 0/804、0/172、0/17 |
| 5 | 卷与条文都能用业务键 100% 对上（仅作数据对等核对，不做地址映射） | 卷 445/445、条文 8066/8066 |
| 6 | **`is_enable` 不是发布开关**，按它过滤会丢 88.5% 正文、22.9% 卷 | 7,136/8,066 正文、102/445 卷 |
| 7 | 930 条本草条目的正文不在 `section_text` 里，只在 `section_note` | 只读 `section_text` 保留率 52.3%，本草两本 18.1%/6.7% |
| 8 | 名表换源几乎零回归，但正文语料一换，中药可链接次数会变。**分流口径是唯一不丢不涨的** | `$f` 1,535→1,534（−1 次）；`$u` 旧 44/57、分流 44/57、只 `section_text` 33/36、全量拼接 48/62 |
| 9 | 分类计数与首页书目会变 | 伤寒金匮 3→5，首页 9→10 卡 |
| 10 | 中药/名词的容器书在 `book_info` 里已软删 | 2 行 `deleted_at` 非空 |
| 11 | 按书分组匹配比全局名表少解析 27 次跨书引用（现网既有缺陷，D5 裁决沿用按书） | 1,534 vs 1,561 |
| 12 | **站点外壳也是旧真源**：四个前台主题页都经 `loadPublishedFeed` 读主频道 `channels` 与 `items` 窗口 | 4 个页面 + `sitemap.xml` + `[...path]` 自定义页；D6-B 整体弃用 |
| 13 | **反向引用索引 2,841 行全是旧 id**，且由前台写入 | `section_id`=`items.id`、`section_seq`=items rowid；换新表要动 schema + 后台写入链，D7-C 前台砍掉该块 |
| 14 | 标记字典 `ext_annotation_markers` 是纯配置，与旧内容体系无关 | 15 行（`code`/`title`/`color`/`link_type`/`sort_order`）；D8-A 保留 |
| 15 | **站点外壳 4 个字段在 `settings` 里没有键**（复核补正，原报告只核了内容层） | `settings` 13 个分类零命中；真源是主频道 `channels.data`。裁决 ③：一条 `data` 迁移把这 4 个键复制进 `settings`，前台只读 `settings`，显示不变 |
| 16 | 原清单漏了 2 个公开出口与 1 块可见内容 | `/json`、`/i/<id>/json` 仍读 `publicFeed`；书页「附：方剂」804 首会随 `getTcmBook*` 一起被删 |

## 1. 量基线（核准起点）

| 对象 | 行数 | 口径 |
| --- | --- | --- |
| `settings` / `book_groups` | 3 组 | `shanghan`(0) / `neijing`(1) / `bencao`(2) |
| `book_info` | 12 | 10 alive + 2 软删；`is_enable` 全部 1 |
| `channels` | 13 | 1 条主频道「肘后斋」`_WgpmyEc5Ze` |
| `ext_category` | 3 | id `4kyJU8BwOPq`/`Ec7udPShw8b`/`gsY3ELgQsE4`，slug 与 `book_groups.key` 逐字相同 |
| `book_chapter` | 445 | 全部 `deleted_at IS NULL`；102 条 `is_enable=0` |
| `book_chapter_body` | 8,066 | 全部非删；930 条 `is_enable=1`；字符 446,546 |
| `items tcm_kind='chapter'` | 447 | 445 卷 + 2 本扁平书的 root 篇章 |
| `items tcm_kind='section'` | 8,066 | 全部 `status=1`；字符 854,481 |
| `items tcm_kind='fang'` | 804 | 与 `fang_yao` 等量 |
| `items tcm_kind='yao'` | 172 | 与 `zhong_yao` 等量 |
| `items tcm_kind='term'` | 17 | 与 `ming_ci` 等量 |
| `fang_yao` | 804 | 全部非删；`is_enable=0` 438 行、`=1` 366 行（后者只是「有组成」，不是发布状态） |
| `zhong_yao` | 172 | 全部非删；`is_enable` 全 1 |
| `ming_ci` | 17 | 全部非删；`is_enable` 全 1 |
| `fang_yao_body` | 2,025 | 方剂组成行 |
| `ext_annotation_markers` | 15 | 标记语法字典；`link_type` 非 0 的只有 `f`(2)/`u`(1)/`g`(3) |
| `ext_marker_citations` | 2,841 | 覆盖 6 本书；切换后前台零读写，表冻结（D7-C） |

## 2. 逐项核准

### A. 题材分类（`book_groups`）

| 检查 | 结果 |
| --- | --- |
| 分组清单 | 3 组，`sort` 0/1/2，key 与 `ext_category.slug` 逐字相同 |
| 每组书数（`book_info` alive + enabled） | shanghan 5 / neijing 3 / bencao 2 |
| 孤儿：`case_division` 不在分组清单 | 0 |
| 空分组：清单里有、书数 0 | 0 |
| `case_division` 空值 | 0 |

判定：分类层可整层替换，无缺口。

### B. 书目（`book_info` ↔ `channels`）

| 检查 | 结果 |
| --- | --- |
| `book_info` 有、`channels` 无 | 0 |
| `channels` 有、`book_info` 无 | 1（主频道 `_WgpmyEc5Ze`，`is_primary=1`） |
| `book_name` 重复 | 0 |
| `book_no` 空 | 0 |
| `author` 空 | 5 / 10 |
| `image_url` 空 | 10 / 10 |
| 软删行 | 2：`4KbG9bDqdz3`（中药）、`tcmterm0001`（名词） |

判定：书 ID 保留，书页地址不受影响。5 本无作者的行在主题里回落到「未知作者」，与现状一致（`channels` 侧作者也全空）。

### C. 卷（`book_chapter` ↔ `items tcm_kind='chapter'`）

| 检查 | 结果 |
| --- | --- |
| 逐本卷数 | 81/81/81/79/31/27/25/22/11/7，两侧一致 |
| ID 交集 | **0 / 445** |
| 业务键 `chapter_section` ↔ `items._microfeed.section` | 445/445 命中（按书作用域唯一，`(source_book_id, chapter_section)` 445/445 唯一） |
| `chapter_section` 全局重复 | 22 组，全部来自「伤寒金匮・宋版」与「金匮要略・宋版」共用 0–21，按书作用域不冲突 |
| `source_chapter_legacy_id` 与 `items` 对得上 | 26/445（**不可用作映射键**） |
| `is_enable=0` 的卷 | 102：神农本草经疏 77/79、金匮要略・人纪 25/25 |
| 无条文（空卷） | 16，两侧同为空 |

判定：卷内容对等，但 ID 体系不同；映射键是 `(source_book_id, chapter_section)`，不是 `source_chapter_legacy_id`。

### D. 正文文本（`book_chapter_body` ↔ `items tcm_kind='section'`）

| 检查 | 结果 |
| --- | --- |
| `receipt_no` ↔ `_microfeed.receiptNo` 映射 | 8,066/8,066 双向命中 |
| `receipt_no` 全局唯一 | 8,066 个不同值 / 8,066 行 |
| ID 交集 | **0 / 8,066** |
| 逐字节相同 | 6,435（79.8%） |
| 仅空白差异 | 701（前导缩进、行尾空白） |
| 实质内容差异 | **930（11.5%）**，全部是本草条目行 |
| 孤儿正文（`book_chapter_id` 不存在） | 0 |
| `receipt_no` 空 | 0 |
| 同卷内 `receipt_no` 重复 | 0 |
| 空 `section_text` | 0 |

### E. 正文渲染口径（本次核准最重要的发现）

`book_chapter_body` 的正文被拆成两列，拆法按书不同：

| 书 | 行数 | `section_text` 字符 | `section_note` 字符 | 只读 `section_text` 相对旧正文的保留率 |
| --- | --- | --- | --- | --- |
| 神农本草经疏 | 1,040 | 67,139 | 318,138 | **18.1%** |
| 神农本草经・(人纪) | 399 | 7,717 | 115,701 | **6.7%** |
| 伤寒论・(人纪) | 391 | 23,264 | 158,729 | 105.6%（`section_note` 是额外讲义） |
| 金匮要略・(人纪) | 121 | 8,265 | 107,309 | 103.7%（同上） |
| 其余 6 本 | 6,115 | 340,161 | 0 | 100.0% |
| 合计 | 8,066 | 446,546 | 699,877 | **52.3%** |

- 本草条目的 `section_text` 只有条目名（如「1、丹砂」4 字符），正文在 `section_note`（「味甘，微寒，无毒。主身体五藏百病……」）；旧 `items.content_text` 是「条目名 + 别名 + 正文」的拼接。
- 判定式：**旧正文去掉空白后 100% 是 `section_text + section_note` 的子串**（8,066/8,066），即拼接可完整覆盖，不丢字。
- 但反过来不成立：人纪两本的 `section_note` 远超旧正文（720.8% / 1,346.9%），统一拼接会让页面多出约 23.6 万字符的讲义内容。
- 可判定的分界：`bencao_yao_name` 非空 = 930 行 = 需要拼接 `section_note` 的全部行（且恰好等于 `is_enable=1` 的 930 行）；其余 7,136 行 `bencao_yao_name` 为空，只读 `section_text` 即完整。

结论：渲染口径按 `bencao_yao_name` 分流——非空则 `section_text + section_note`，为空则只有 `section_text`。这条规则可 100% 还原旧正文，不引入讲义膨胀。

### F. 标记与引用解析

标记目录（`ext_annotation_markers`）决定了哪些码可链接：

| 码 | 含义 | `link_type` | 可链接 |
| --- | --- | --- | --- |
| `f` | 方剂 | 2 | 是 |
| `u` | 中药 | 1 | 是 |
| `g` | 名词解释 | 3 | 否（只上色） |
| `a` | 按语 | 0 | 否 |
| 其余 11 个 | 剂量/出处/强调/蓝字/橙字/批注/黑字/总起/异文/测试 | 0 | 否 |

正文标记实测：

| 码 | 新源（`section_text`）次数 | 行数 | 旧源（`items.content_text`）次数 | 行数 |
| --- | --- | --- | --- | --- |
| `$f{}` 方剂 | 1,585 | 1,343 | 1,585 | 1,343 |
| `$a{}` 按语 | 264 | 210 | 264 | 210 |
| `$u{}` 中药 | 36 | 21 | 57 | 24 |
| `$x{}` 橙字 | 49 | 3 | 51 | 4 |
| `$n{}` 蓝字 | 36 | 18 | 38 | 19 |
| `$m{}` 强调 | 34 | 14 | 35 | 15 |
| `$q{}` 出处 | 31 | 29 | 31 | 29 |
| 其余 6 个 | 17 | — | 18 | — |
| 含任一标记的行 | 1,468 | — | 1,473 | — |

引用解析覆盖率（逐次标记比对，不是抽样）。**这张表有三个自变量：名表、正文语料、渲染口径，必须分开读。**

先固定「名表」这一个变量（正文都取旧源 `items.content_text`）：

| 引用 | 旧名表命中 | 新名表命中 | 名表维度的差异 |
| --- | --- | --- | --- |
| `$f{}`（1,585 次） | 1,535（96.85%） | 1,534（96.78%） | **1 次**：`滑石乱发白鱼散`，新源存名 `滑石白鱼散` |
| `$u{}`（57 次） | 44 | 44 | 0 |

#### F.1 方剂引用（`$f{}`）

| 正文语料 | 总次 / 命中 / 断链（次数 / 名字） |
| --- | --- |
| 旧 `items.content_text` | 1,585 / 1,534 / 51（36） |
| 新 `section_text` | 1,585 / 1,534 / 51（36） |
| 新分流（930 本草行拼 `section_note`） | **1,585 / 1,534 / 51（36）** |
| 新 `st + section_note` 全量 | 1,610 / 1,544 / 66（38） |

`$f{}` 全部落在 `section_text`，三种语料下次数都是 1,585，所以方剂结论稳固：**唯一回归 1 次**。全量拼接会多出 25 次标记与 15 次断链（`section_note` 里的讲义引用），这也是 D2 不选全量拼接的原因之一。

#### F.2 中药引用（`$u{}`）

| 正文语料 | 总次 / 命中 / 断链（次数 / 名字） |
| --- | --- |
| 旧 `items.content_text` | 57 / 44 / 13（12） |
| 新 `section_text` | 36 / 33 / 3（3） |
| **新分流**（930 本草行拼 `section_note`） | **57 / 44 / 13（12）** |
| 新 `st + section_note` 全量 | 62 / 48 / 14（13） |

`$u{}` 的 21 次出现、11 次命中都在本草行的 `section_note` 里。D2 定案为按 `bencao_yao_name` 分流后，**总次与命中都回到旧源的 57/44，零回归**——这是「名表维度」与「语料维度」同时对齐的唯一口径。只读 `section_text` 会掉到 33/36，全量拼接会涨到 48/62 且把讲义带进正文。

既有缺口（两套名表都查不到，与换源无关）：**35 个名字 / 50 次**（`柴胡汤` 14 次、`泻心汤` 2 次、`四逆汤` 2 次，其余 32 名各 1 次）。另有 1 次「仅旧命中」，构成方剂那 1 次回归。`35 名 / 50 次` 与 `36 名 / 51 次` 的差，就是这 1 次回归——**名字数多 1、次数多 1，两个口径同源，不是两批不同的问题**。

> 纠错：方案早期把中药引用记成 `$a{}`（210 次）。`$a` 是**按语**（`link_type=0`，不可链接），中药是 `$u{}`。按旧文实施会把 210 条按语当药名去查表，同时漏掉真正的中药标记。

#### F.3 匹配范围：按书分组 vs 全局名表（27 次差异）

现网 `markerPopover.ts:190 loadFangBySourceBook` 按「当前书」查方剂（`json_extract(data,'$._microfeed.sourceBookId') = ?`）。实测这个作用域过严：

| 匹配范围 | `$f{}` 命中 / 总次 | 断链 |
| --- | --- | --- |
| 按书分组（现网行为） | 旧 1,535、新 1,534 | 50 / 51 次 |
| 全局名表（不限书） | 旧 1,562、新 1,561 | 23 / 24 次 |

差的 **27 次**全部是跨书引用：人纪版《金匮要略》（legacy `9050000`）正文引用 `桂枝汤`/`五苓散`/`大承气汤`/`四逆汤` 等，而 `fang_yao` 把这些方剂登记在宋版（`10001`/`10002`）与桂林古本（`1001000`）下，人纪组内查不到。涉及 25 个名字：

`泻心汤`(2)、`四逆汤`(2)、`去桂加白术汤`、`八味肾气丸`、`瓜蒂汤`、`附子汤`、`胶姜汤`、`五苓散`、`桂枝汤`、`猪苓汤`、`葛根汤`、`大承气汤`、`桂枝附子汤`、`甘草附子汤`、`白虎加人参汤`、`甘草泻心汤`、`小建中汤`、`甘草干姜汤`、`桔梗汤`、`越婢加半夏汤`、`小青龙加石膏汤`、`甘草汤`、`白头翁汤`、`麻黄杏仁甘草石膏汤`、`半夏散及汤`。

判定：

- 这 27 次是**现网既有缺陷**，不是换源引入。按书分组继续沿用，命中数与今天持平（1,534）；改全局名表，反而比今天多解析 27 次。
- 全局匹配引入一个新歧义：同名方剂在多本书下各有行（`桂枝汤` 在 `10001`、`10002` 各一条，`fang_yao.id` 不同），全局命中后链接落到哪一条需要定规则（本书优先 → 再回落全局）。
- **裁决 D5 = 按书（A）**：标注层方剂匹配锁定当前书，不跨书回落。全局回落虽多解析 27 次，但同名方剂在多本书下各有独立行（`桂枝汤` 在 `10001`、`10002` 各一条，`fang_yao.id` 不同），跨书命中必须再定「本书优先 → 再按书号升序」这类落点规则——那正是旧 `sourceBookId` 书本语义的复刻，等于把刚摘掉的耦合装回标注层。这 27 次与今天完全一致，不构成回归。

全局口径下的最终账：两套名表都缺 **10 个名字 / 23 次**（`柴胡汤` 14、`小柴胡`、`青龙汤`、`胃承气汤`、`当汤主`、`阳旦汤`、`膏发煎`、`大黄蟅虫丸`、`黄芪芍药桂枝苦酒汤`、`柴胡黄芩芍药半夏甘草汤` 各 1），这 10 个是源数据标记本身写错或简写（`当汤主` 是句子片段、`胃承气汤` 缺「调」字），任何匹配范围都解析不了。另有 1 次仅旧命中（`滑石乱发白鱼散`）。

#### F.4 方剂页「所属书」的回显来源

`/fang-yao/[id]/` 要显示方剂出自哪本书。候选是 `fang_yao.source_book_name`（导入期派生列）或按 `book_no = source_book_legacy_id` 反查 `book_info.book_name`：

| 检查 | 结果 |
| --- | --- |
| `source_book_name` ↔ `book_info.book_name`（5 组，按书号连接） | **5/5 逐字相同** |
| 5 本对应书的 `deleted_at` | 全部为 NULL |

判定：走 `book_info` 反查。两列值一致，但 `source_book_name` 是导入期快照，书改名后不会跟着变；`book_info.book_name` 是活的真源，且反查同时拿到 `book_info.id` 可直接链到书页。反查不到时留空，不回落到 `source_book_name`，也不展示 `source_fang_legacy_id`（源 FangYao.Id，属旧系统标识）。

### G. 方剂组成（浮层里的「组成」行）

| 检查 | 结果 |
| --- | --- |
| `fang_yao_body` 行数 | 2,025（1,468 条启用） |
| `yao_legacy_id` ↔ `zhong_yao.id` | **0 / 2,025**（`yao_legacy_id` 是源内序号 `0`/`1`/`5`） |
| `show_name` ↔ `zhong_yao.zhong_yao_name` | 1,930 / 2,025 = **95.3%** |
| 缺口 | 95 行（4.7%）按名查不到中药行，浮层里这些组成无法链接 |

判定：组成行的中药链接只能按 `show_name` 解析，覆盖率 95.3%；余 4.7% 需要兜底（不生成链接）。

### H. 中药 / 名词条目与归属

| 检查 | 结果 |
| --- | --- |
| `zhong_yao` 行数 / 名字唯一 | 172 / 172 |
| `ming_ci` 行数 / 名字唯一 | 17 / 17 |
| `zhong_yao.id` ↔ `items(tcm_kind='yao').id` | **0 / 172** |
| `ming_ci.id` ↔ `items(tcm_kind='term').id` | **0 / 17** |
| `items` 侧归属 | yao 172 行全部挂容器书 `4KbG9bDqdz3`；term 17 行全部挂 `tcmterm0001` |
| `zhong_yao` 归属字段 | **没有**（无 `source_book_id`） |
| `ming_ci.source_book_id` | 挂在 4 本真实书：伤寒论・(人纪) 8、神农本草经疏 7、伤寒杂病论・(桂林古本) 1、黄帝内经・灵枢 1 |
| 容器书在 `book_info` 的状态 | 两行都已软删（2026-11-06） |

判定：归属模型两侧不同。旧模型是「容器书聚合全部条目」，新模型是「条目挂源书（名词）或完全无归属（中药）」。切换后：

- 「中药」「名词」两本书页在 `book_info` 里已软删 → 按 `deleted_at IS NULL` 列书会消失；
- 172 条中药条目失去唯一的聚合入口（`zhong_yao` 无归属字段可查）；
- 17 条名词条目改为 `/ming-ci/[id]/` 单条可达，从正文 `$g` 标记进入（2026-11-07 修订：书页目录不再列名词，`listTermsByBook` 一并删除）。

### I. ID 与 URL 影响面

| 资源 | 旧 ID 来源 | 新 ID 来源 | ID 是否相同 | 受影响地址数 |
| --- | --- | --- | --- | --- |
| 书 | `channels.id` | `book_info.id` | 相同（12/12） | 0 |
| 分类 | `ext_category.id`（`4kyJU8BwOPq` 等） | `book_groups.key`（`shanghan` 等） | 不同 | **3** |
| 卷 | `items.id`（chapter） | `book_chapter.id` | 不同（0/445） | **445** |
| 条文 | `items.id`（section） | `book_chapter_body.id` | 不同（0/8066） | **8,066 锚点**（`#mf-toc-<id>`） |
| 方剂 | `items.id` | `fang_yao.id` | 不同（0/804） | **804** |
| 中药 | `items.id` | `zhong_yao.id` | 不同（0/172） | **172** |
| 名词 | `items.id` | `ming_ci.id` | 不同（0/17） | **17** |

分类地址为什么也会变：当前主题 `themes/feed-zh/web-body-start.mustache` 的分类导航链接写的是 `/category/{{id}}/`（不是 `{{slug}}`），而 `siteNav.category_nav[].id` 取自 `ext_category.id`。旧路由 `getCategoryBySlugOrId` 也是先按 id 命中。所以现网站的分类地址是 `/category/4kyJU8BwOPq/` 这一型；切到 `book_groups.key` 后变成 `/category/shanghan/`。

页面地址合计受影响：3（分类）+ 445（卷）+ 993（条目）= **1,441 个地址**，另有 8,066 个页内锚点。

映射键（各 100% 覆盖）。**只用于切换前核对两侧是同一批内容，不用于旧地址映射**（D1 裁决 A：旧地址一律 404）：

| 资源 | 映射键 | 覆盖率 |
| --- | --- | --- |
| 卷 | `(book_chapter.source_book_id, chapter_section)` ↔ `items(book_id, _microfeed.section)` | 445/445 |
| 条文 | `book_chapter_body.receipt_no` ↔ `items._microfeed.receiptNo` | 8,066/8,066（全局唯一） |
| 方剂 | `(source_book_legacy_id, fang_name)` ↔ `items(fang).title` | 803/804（1 处名称不同） |
| 中药 | `zhong_yao_name` ↔ `items(yao).title` 去编号取纯名 | 172/172 |
| 名词 | `ming_ci_name` ↔ `items(term).title` | 17/17 |

### J. 分类计数与首页书目

| 位置 | 旧口径 | 新口径 | 差异 |
| --- | --- | --- | --- |
| 分类导航「伤寒金匮」 | 3 本 | 5 本 | **+2**（`伤寒金匮・宋版`、`金匮要略・宋版` 在 `channels.status=10`，旧前台不显示） |
| 分类导航「内经」 | 3 本 | 3 本 | 0 |
| 分类导航「本草」 | 2 本 | 2 本 | 0 |
| 首页书架 | 9 张卡（含主频道「肘后斋」） | 10 张卡 | +2 本 status=10 的书，−1 主频道 |

判定：`book_info` 没有可表达「前台可见」的字段（`is_enable` 全 1），切换后 `status=10` 的两本书会首次出现在前台。这不是漏数据，是显示范围扩大。

### K. 书卡字段

| 字段 | 旧源 | 新源 | 结果 |
| --- | --- | --- | --- |
| 封面 `image` | `channels.data.image` = 全空 | `book_info.image_url` = 全空 | 0 回归（两侧都是占位图） |
| 简介 `description` | `channels.data.description` = 全空 | `book_info` 无此字段 | 0 回归 |
| 作者 `author` | `channels.data.authors[0].name` = 全空 | `book_info.author` 5 本有值 | **5 本由「未知作者」变为有值** |
| 连载状态 `serialStatusLabel` | 全部 `serializing` | 无字段，模板回落「连载中」 | 显示一致 |
| 字数 `wordCountLabel` | `ext_book_stats` | 无 | 10 张卡失去字数（与决策 5 一致） |

### L. 反向引用索引 `ext_marker_citations`

| 检查 | 结果 |
| --- | --- |
| 现有行数 / 覆盖书 | 2,841 / 6 |
| 索引内容 | `section_id` = 旧 `items.id`、`section_seq` = items 的 rowid、`book_id` = `channels.id`、`section_title` = `items.data.title` |
| 写入方 | 前台卷页渲染时 `ensureMarkerCitations` 整本扫 `items` 后写入；后台 `fang-references` 只读 |
| 切换后状态 | **前台不再读也不再写**；表与数据原地冻结，后台视图继续读（数据停在切换时刻） |

处置依据（D7-C）：换成新模块要同时做三件事——建两张索引表（schema）、后台保存正文后按书重算（后台写入链）、后台方剂编辑器改读新表（admin）。后两件都在「后端 / admin」里，与本次「只改前端主题」冲突，因此按「换不了的砍掉」让前台停止提供这一块。

砍掉前确认过「能不能低成本换」：`book_chapter_body` **没有** `position` 列也没有 `section_title` 列，全序键只能用 `receipt_no`（8,066/8,066 唯一）；条文标题旧值来自 `items.data.title`，从 `section_text` 首句派生只对上 4,818/8,066（59.7%）。即便只做前台实时查询（按书 LIKE 扫正文），标题也会有 40% 可读差异，仍然达不到「显示不变」。故不采用。

显示影响：条目浮层少一段「引用此方剂 / 引用此中药的条文」，其余不变。

### M. 站点外壳字段与公开出口（2026-11-07 复核补正）

这一节是复核「前台能不能真的零读 `channels`/`items`」时补的实测，原报告覆盖了内容层、漏了外壳层。

**M.1 `settings` 里到底有什么**

全库 13 个分类：`access`/`analytics`/`apiSettings`/`app_login_methods`/`book_groups`/`book_info_statuses`/`contentReview`/`customCode`/`mail_settings`/`mingci_groups`/`signup_sources`/`subscribeMethods`/`webGlobalSettings`。搜索 `description`/`language`/`copyright`/`publisher` 四个关键词，**零命中**。

`webGlobalSettings` 实际内容（逐字）：

```json
{"publicBucketUrl": "/media/", "favicon": {"url": "/assets/default/favicon.png", "contentType": "image/png"},
 "itemsOrder": "desc", "itemsSort": "published_at", "itemsPerPage": 20, "siteTitle": "肘后斋"}
```

**M.2 六个站壳字段的真源**

| 字段 | 旧链路真源（`FeedPublicJsonBuilder`） | `settings` 有吗 | 实测值 |
| --- | --- | --- | --- |
| `title` | `channel.title`；`_microfeed.siteTitle` 优先 | ✅ `siteTitle` | 「肘后斋」（与频道 title 逐字相同） |
| `favicon` | `resolveEffectiveFavicon(settings.favicon, channel.image)` | ⚠️ 有但无效 | settings 值 = `LEGACY_DEFAULT_FAVICON_URL` → 判「未上传」→ 实际用 `channel.image` = `/assets/default/channel-image.png` |
| `description` | `channel.description` → `htmlToPlainText` | ❌ | 空 |
| `language` | `channel.language` | ❌ | `en-us` |
| `copyright` | `channel.copyright` + `{{current_year}}` 展开 | ❌ | `©{{current_year}}` → `©2026` |
| `publisher` | `channel.publisher` → `authors[0].name` | ❌ | 空 |

主频道行：`channels.id = _WgpmyEc5Ze`，`is_primary = 1`，常态 1 行。

**M.3 结论**

站壳 6 个字段里只有 `title` 能纯靠 `settings` 复现；`favicon` 需要 `channel.image` 回退才等价；其余 4 个 `settings` 完全没有对应键。所以「站点外壳零读 `channels`」与「显示不变」在这 5 个字段上互斥，三条路（接受变化 / 读主频道 1 行 / 搬进 settings）里**用户裁决 ③**：一条 `data` 迁移按实例把这 4 个键（加改写后的 `favicon`）写进 `settings.webGlobalSettings`，前台只读 `settings`。显示逐字不变，代价是本次唯一一条迁移、且 4 个键暂无后台编辑入口（规范 §3.4「P1 裁决：③」）。

**M.4 另外三个被漏掉的入口**

| 入口 | 现状 | 影响 |
| --- | --- | --- |
| `/json`（`src/pages/json/index.ts`） | `jsonFeedResponse` → `loadPublishedFeed` → 整份 `publicFeed`（含 `items`） | 公开订阅出口，与 `rss` 同类；原方案只删 rss |
| `/i/<id>/json`（`src/pages/i/[slug]/json/index.ts`） | 同上，单条 | 同上 |
| `/robots.txt` | `publicSiteFileResponse` → `loadPublishedFeed`（带 items 窗口），输出只用 `request` 与 `hidden` | 读了不显示，属第二处已知例外 |

**M.5 书页「附：方剂」块**

`getTcmBookFang` 走 `items WHERE tcm_kind='fang' AND json_extract(data,'$._microfeed.sourceBookId')=?`，5 本书合计 804 首（329/202/113/111/49），是当前书页可见内容。原方案写「移除 `getTcmBook*`」会把这一块一并删掉；新源可用 `book_info.book_no = fang_yao.source_book_legacy_id` 等价替换（5/5 逐字相同，§F.4），块保留。

## 3. 口径铁律

**前台一律只用 `deleted_at IS NULL`，禁止用 `is_enable` 过滤。** 三处实测：

| 若按 `is_enable=1` 过滤 | 丢失量 | 占比 |
| --- | --- | --- |
| `book_chapter_body` | 7,136 / 8,066 行正文 | 88.5% |
| `book_chapter` | 102 / 445 卷（含 1,091 条正文） | 22.9% |
| `fang_yao` | 743 / 1,585 次方剂引用（4 本书的方剂整组 `is_enable=0`） | 46.9% |

`is_enable` 在独立模块里承载的是导入期语义（本草条目标记、方剂是否有组成、卷的来源状态），与「是否发布」无关。`zhong_yao`/`ming_ci` 的 `is_enable` 恰好全为 1，不能据此反推其他表同义。

**报告里的数字必须带单位，禁止跨单位并列。** 本报告同时用到三种量纲，混用会直接产生假结论：

| 单位 | 定义 | 本报告中的实例 |
| --- | --- | --- |
| 出现次数（token） | 同一名字在正文里被标记了多少次 | `$f` 1,585、`$u` 57 |
| 去重名字数（distinct） | 去掉重复后有多少个不同名字 | 断链 35 名、36 名 |
| 表行数（row） | 某张表有多少行 | `book_chapter_body` 8,066、`fang_yao_body` 2,025 |

同一个结论必须固定另外两个变量才能比较：**名表**（旧 `items` / 新 `fang_yao`+`zhong_yao`）与**正文语料**（旧 `content_text` / 新 `section_text` / 新分流 `st+(仅本草行)sn` / `st+sn`）。只换名表不换正文，`$f` 只差 1 次；一换正文，`$u` 的绝对命中就从 44 变 33（只 `section_text`）或 48（全量拼接），只有分流口径保持 44。本次验收基线固定为「新名表 + 分流语料」。四个变量里任何一个动了，「回归」结论就要重算。

**「覆盖率」必须写清分母属于哪张表。** 95.3% 的分母是 `fang_yao_body` 的 2,025 行组成，与正文里 1,585 次 `$f` 引用无关，两者不可相加、不可相减、不可互校。

## 4. 必须处置的风险

| 编号 | 风险 | 量化 | 处置 |
| --- | --- | --- | --- |
| R1 | 按 `is_enable` 过滤导致大规模丢内容 | 88.5% 正文 / 22.9% 卷 / 46.9% 引用 | 口径写死为 `deleted_at IS NULL`（第 3 节） |
| R2 | 只渲染 `section_text` 丢本草正文 | 930 行 / 保留率 52.3%（本草两本 18.1%、6.7%） | 按 `bencao_yao_name` 分流拼接 `section_note` |
| R3 | 统一拼接 `section_note` 造成页面膨胀 | 人纪两本 720.8% / 1,346.9%，多出约 23.6 万字符 | 同上，只在 `bencao_yao_name` 非空时拼接 |
| R4 | 1,441 个页面地址 + 8,066 个锚点的 ID 全断 | 分类 3、卷 445、条目 993、锚点 8,066 | D1-A：一律失效，不写 301、不给新表加 `legacy_item_id`、不建重定向表；分类 3 个旧地址同样 404 |
| R5 | 中药容器书软删 + `zhong_yao` 无归属字段 | 2 行软删、172 条无聚合入口 | D3-B：不恢复容器书，中药只在 `/zhongyao/[id]/` 单条可达 |
| R6 | `status=10` 的两本书首次上前台 | 分类 +2、首页 +2 | D4-A：一并上前台，可见性只看 `deleted_at` |
| R7 | 方剂组成链接按名解析缺 4.7% | 95 / 2,025 行（46 个不同药名：乌扇、乱发、大附子、姜、枣、川椒…） | 未匹配时不生成链接，浮层只显示文字 |
| R8 | 方剂名 1 处差异导致 1 次断链 | `滑石乱发白鱼散` vs `滑石白鱼散` | 加名称别名映射，或接受 1 次降级为纯文本 |
| R9 | 分类地址由 id 变 key | 3 个（`/category/4kyJU8BwOPq/` 等） | D1-A：`getGroupByKey` 只认 `book_groups.key`，旧 id 地址 404；不回查 `ext_category` |
| R10 | 中药引用绝对命中量随正文语料变化 | 44 → 33（只读 `section_text`）或 → 48（`st+section_note`） | 由 D2 定渲染口径；实施后按矩阵复算，不能用旧正文的 44 当验收基线 |
| R11 | 按书分组漏解 27 次跨书方剂引用 | 1,534 vs 全局 1,561 | D5-A：按书匹配，27 次降级纯文本；`refs.ts` 方剂查询必须带 `source_book_legacy_id = ?` |
| R12 | 站点外壳每页读 `channels`+`items` | 4 个前台主题页 + `sitemap.xml` + `[...path].astro`，都经 `loadPublishedFeed` | D6-B：主题页删 `loadPublishedFeed`/`publicFeed`/主题渲染，站点配置直查 `settings`；外观移植到 Astro 组件 + 静态 CSS；`sitemap` 改源、`rss`/`llms*` 下线、自定义页下线 |
| R13 | 反向引用索引全列都是旧体系语义 | 2,841 行，`section_id`=`items.id`、`section_seq`=items rowid、`book_id`=`channels.id` | D7-C：前台砍掉「引用此条目的条文」块，`buildTcmMarkerLayer` 停用 `ensureMarkerCitations`；因后台 `fang-references` 仍导入它，函数留在 `front-decoupling:ignore-*` 区段供后台复用，静态检查按区段跳过；旧表与后台代码不动 |
| R14 | 主题设置对前台失效 | 后台换主题不再改变前台外观 | D6-B 的必然结果；外观改由 `front-site.css`（四段 `<style>`：header 三段 + `web-home.mustache` 一段）与组件决定。后台主题页加说明属 admin 改动，超出本次范围，登记为独立待办 |
| R15 | 条文标题无法逐字复原 | 4,818 / 8,066（59.7%）与旧 `items.data.title` 一致 | 这也是 D7-C 不选「前台实时算」的理由之一：派生标题有 40% 可读差异，达不到「显示不变」 |
| R16 | 站点文件端点（sitemap / rss / **json** / llms） | `sitemap.xml.ts`、`rss/` 两个文件、`json/` **与 `i/[slug]/json/` 两个文件**、3 个 llms 路由都读 `publicFeed` | `sitemap` 改由 `catalog/sitemap` 生成；`rss`（含 `i/[slug]/rss`）**与 `json`（两条）** 及 `llms*` 八个文件删除；`[...path]` 下线、`404` 去自定义页查询；`robots.txt` 仍读旧真源，登记为第二处已知例外 |
| R17 | **站点外壳 4 个字段在 `settings` 里不存在** | `description`/`language`/`copyright`/`publisher` 的真源是主频道 `channels.data`，`settings` 13 个分类零命中（见 §M） | **裁决 ③**：一条 `data` 迁移按实例把这 4 个键复制进 `settings.webGlobalSettings`，并把 `favicon` 改写成现网生效值；前台只读 `settings`，显示不变。代价：破「零迁移」、4 个键暂无后台编辑入口 |
| R18 | 书页「附：方剂」块会被连带删除 | `getTcmBookFang` 读 `items tcm_kind='fang'`，5 本书共 804 首，是当前可见内容 | 不删块、只换源：`book_info.book_no = fang_yao.source_book_legacy_id`（§F.4 同一条链） |

## 5. 裁决记录

**D1–D8 全部已裁决**（2026-11-07，见下表「裁决」列）。总方向是「新模块与 `items`/`channels` 不允许有任何关系，且只改前端主题」：不接受以 `items.id` 为内容的任何新列或映射表，不让方剂解析跨出当前书，不把站点外壳留作例外，也不为反向引用去动 schema 与后端。

| 编号 | 决策 | 选项 | 影响 | 裁决 |
| --- | --- | --- | --- | --- |
| D1 | 卷/条文/条目的旧地址是否保留 | A 一律失效<br>B 路由层反查 `items` 后 301<br>C 一次性迁移给 5 张表补 `legacy_item_id` | A：1,441 地址 + 8,066 锚点 404；B：前台保留运行时 `items` 查询；C：把 `items.id` 换个列名存进新表 | **A**（用户：新模块与 `items` 不要有任何关系。C 属表结构级耦合，B 属运行时耦合，手工重定向表属 `items.id` 的死数据副本，三条全否） |
| D2 | 本草渲染口径 | A 按 `bencao_yao_name` 分流<br>B 统一 `section_text + section_note`<br>C 只 `section_text` | A 还原旧正文（103.0%）且不膨胀；B 人纪两本多出 23.6 万字符；C 丢 930 条正文（保留率 52.3%） | **A** |
| D3 | 中药/名词的容器书 | A 恢复两行 `book_info`<br>B 取消容器书页 | A 保留 2 个书页 + 聚合入口；B 删 2 个书页 | **B**（用户：容器书不在前台显示，`book_info` 已软删，只剩 `channels` 残留且与新模块解耦，不恢复） |
| D4 | `status=10` 的两本书 | A 一并上前台<br>B 用 `channels` 判据排除 | A 显示范围扩大；B 把旧链路语义带进新引擎 | **A**（用户：`channels` 的内容全部不要，与新模块无关；可见性只看 `deleted_at`） |
| D5 | 标注层方剂/中药的匹配范围 | A 按书分组<br>B 本书优先 + 全局回落 | A 与今天完全一致（1,534 次）；B 命中 1,561 次，但同名方剂跨书时须另定落点规则 | **A**（用户：`fang-yao/` 不要和旧数据有任何关系。B 的落点规则就是旧 `sourceBookId` 书本语义的复刻） |
| D6 | 站点外壳（主频道/`publicFeed`/mustache 主题）是否保留 | A 保留并声明为不变式例外<br>B 整体弃用，前台改 Astro 渲染 | A 每页仍走 `loadPublishedFeed` 读 `channels`+`items`，字面上违反零耦合；B 要移植 2,237 行主题资产（其中约 1,900 行是 CSS）并放弃「换主题改外观」 | **B**（用户：站点外壳全部去掉，旧 channels 体系的。A 是虚假声明——那个「例外」覆盖了每一条前台请求） |
| D7 | 反向引用索引 `ext_marker_citations` | A 保留，只换 `section_id`<br>B 换新表从 `book_chapter_body` 重算<br>C 前台砍掉「引用此条目的条文」块 | A 索引里同时存在两套 id 体系，且仍要整本扫 `items`；B 要建表 + 改后台写入链 + 改 admin 读侧；C 浮层少一段 | **C**（用户：换不了的砍掉；后端 / admin 不需要改动。B 三处里两处在后端/admin） |
| D8 | 标记字典 `ext_annotation_markers` | A 保留，明确其为语法字典<br>B 迁进 `settings.marker_styles` | A 前台继续读这一张 `ext_*`，需在不变式里写明例外；B 命名更干净，但要改后台 CRUD 与 App 端 `version` 语义 | **A**（用户：这个保留，它给的是转换 `$u{}` 这些符号的。B 收益只是命名洁癖） |

### 5.1 裁决连带的纠正

用户三次裁决「完全解耦」「新模块与 `items` 不要有任何关系」「站点外壳全部去掉」，加上本次「只改前端主题、后端 / admin 不改」后，本报告与规范里八条会把旧真源带回前台的设计已删除：

| 原设计 | 问题 | 纠正 |
| --- | --- | --- |
| D1 的 B：路由层反查 `items` 后 301 | 前台保留一条运行时 `items` 查询 | 删除；D1 落到 A（一律失效） |
| D1 的 C：一次性迁移补 `legacy_item_id` | 该列内容就是 `items.id`，把耦合从查询降为表结构依赖 | 删除；本次切换零 DDL、零迁移 |
| `/i/[slug]/` 继续读 `items` + `channels`，只换解释器 | 旧条目页本身就是耦合据点 | 删除；改为 `/zhongyao/[id]/`、`/fang-yao/[id]/`、`/ming-ci/[id]/` 三条单表路由 |
| 用 `channels.status` / `ext_book_status` 判前台可见性（D4 原 B） | 把旧链路的会员语义带进新引擎 | 删除；只看各表 `deleted_at` |
| 方剂「本书优先 + 全局回落」（D5 原 B） | 跨书命中要定书本落点规则，复刻旧 `sourceBookId` 语义 | 删除；方剂解析锁在当前书的 `source_book_legacy_id` 组内 |
| 站点外壳保留读 `channels`，只把内容层切走（D6 原 A） | 四个前台页面每页都调 `loadPublishedFeed`，它读主频道 `channels` 与 `items` 窗口；这条「例外」覆盖了全部前台请求 | 删除；D6 落到 B。`publicFeed`/主题渲染/`loadFeed` 从前台整体移除，站点配置改直查 `settings`（4 个缺失键由 R17 的 `data` 迁移补齐），外观由 Astro 组件 + 移植 CSS 承担 |
| 「站点外壳 6 个字段全部能从 `settings` 复现」（复核前的前提假设） | 实测 `settings` 只含 `siteTitle` 与 `favicon`（后者还是 legacy 默认值），`description`/`language`/`copyright`/`publisher` 零命中 | 裁决 ③：由一条 `data` 迁移按实例把这 4 个键复制进 `settings`，`favicon` 同时改写成现网生效值；前台只读 `settings` |
| 只删 `rss` 就算收口站点订阅出口（原 R16） | `/json` 与 `/i/<id>/json` 同样走 `jsonFeedResponse` → `loadPublishedFeed`，是同一类公开输出 | 一并删除；`robots.txt` 列为例外 |
| 书页「移除 `getTcmBook*`」（原 §3.2） | `getTcmBookFang` 喂的是「附：方剂」块，804 首可见内容，不是要退场的条目目录 | 只删 `getTcmBookEntries`；`getTcmBookFang` 改调 `listFangByBook` |
| 反向引用索引保留旧表、只换 `section_id`（D7 原 A） | `section_seq` 仍是 items 的 rowid，索引内并存两套 id 体系；重算仍要整本扫 `items` | 删除；D7 落到 C，前台不再提供该块 |
| 建 `ext_citation_index` 两张表重算反向引用（D7 原 B） | 要改 schema、后台写入链、admin 读侧，越出「前端主题」；且标题派生只有 59.7% 一致 | 删除；按用户「后端 / admin 不改」收敛为 C |

依据：ADR-0058 决策 2、ADR-0065 决策 1 均已写明独立模块与 `items`/`channels`「完全并行共存、互不读写、互不迁移、零共享外键」。

## 6. 复核方式

探针脚本留在 `.scratch/catalog-audit/`（未入库）：

| 文件 | 用途 |
| --- | --- |
| `03-groups-books.sql` | 分组/书目对等与孤儿 |
| `04-chapters.sql` | 卷/正文行数与空卷 |
| `05-id-overlap.sql` | 六类资源 ID 交集 |
| `06-mapping.sql` | 映射键覆盖率 |
| `07-keys.sql` | 唯一性与名字冲突 |
| `08-enable.sql` | `is_enable` 分布 |
| `09-text.sql` | 文本差异与排序 |
| `11-bencao.sql` | 本草标记字段 |
| `12-enable-semantics.sql` | 三处 `is_enable` 语义 |
| `13-cards.sql` | 书卡字段两侧对照 |
| `analyze*.py` | 标记解析、字符保留率、新旧命中对照 |
| `audit-consistency.py` | **口径互证**：每类数字的分子/分母/单位，对称归一化后重算 `$f`/`$u`，含断链名字清单 |
| `audit-matrix.py` | **正文语料 × 名表 2×2 矩阵**：三种正文语料 × 两种名表的命中/断链，用于判断「回归」是由换名表还是换正文造成 |

重跑前提：`npx wrangler d1 execute FEED_DB --local --persist-to .microfeed/instances/ctwh-881019-xyz/local-state --config .microfeed/instances/ctwh-881019-xyz/wrangler.jsonc`（只读）。
