# ADR-0066: 前台站点内容引擎切换到独立模块（book_info / book_chapter / fang_yao / zhong_yao / ming_ci）

- 状态：Proposed（2026-11-07 会话设计，待实施；实施后改 Accepted 并括注）
- 日期：2026-11-07
- 关联：ADR-0058（独立 `book_info`）、ADR-0059（`settings.book_groups` 分组树 SSOT）、ADR-0060（独立 `ming_ci`）、ADR-0061（独立 `zhong_yao`）、ADR-0062（独立 `book_chapter`）、ADR-0063（卷章三层树）、ADR-0065（独立 `fang_yao`）、`docs/zh/`（分册索引）、`CONTEXT.md`（领域词条）

## 背景

前台站点（主题渲染的公共页）的「分类 → 书 → 卷章 → 正文」内容引擎，目前完全建在 novel-cms 的两套老真源上：

- **书** = `channels` 行（`data` JSON 存 `title`/`authors`/`image`/`_microfeed`）；
- **正文** = `items` 行（`book_id` 挂书、`tcm_kind`/`tcm_parent_id` 层层叠加）；
- **分类** = `ext_category` 表 + `channels.genre` 镜像列；
- **字数/章节数** = `ext_book_stats` 物化表（从 `items` 聚合，`items` 触发器失效）；
- **站点外壳** = 主频道 `channels` 行的 `data`（站名/描述/图标/版权）+ `settings` 的站点设置，两者由 `loadPublishedFeed` 组装成 `publicFeed`，再喂给 mustache 主题。
- **反向引用索引** = `ext_marker_citations`，前台写入，`section_id` 是 `items.id`。

而后台已陆续建起**一套与 `channels`/`items` 完全解耦的独立模块**：`book_info`（书）、`book_chapter`/`book_chapter_body`（卷章/正文）、`fang_yao`（方剂）、`zhong_yao`（中药）、`ming_ci`（名词），分类走 `settings.book_groups`。两套并行共存、互不读写（ADR-0058 决策 2）。

用户诉求：**前台站点的显示方式不变，但数据源从 `channels`/`items` 整体切到这套独立模块**——因为正是 `channels`/`items` 的层层叠加耦合是要摆脱的根因。本次直接把前台渲染的**真源换掉**，并且**连站点外壳一起换**：没有加缓存层或数据访问层；`publicFeed` 本身就是旧真源的组装结果，留在前台就等于留一条隐式依赖。

## 数据对等性取证（本地 D1 只读探针，2026-11-07）

切源的可行性分两问：**行是否都在**、**ID 与口径是否对得上**。逐项量化的完整报告见 [`docs/front-site-catalog-switch-data-audit.md`](../../front-site-catalog-switch-data-audit.md)，此处只摘结论。

### 行数与归属：全部对等

| 内容层 | `items`/`channels` 侧 | 独立模块侧 | 对等 |
| --- | --- | --- | --- |
| 分类 | `ext_category` 3 行（slug `shanghan`/`bencao`/`neijing`） | `settings.book_groups` 3 组（key 逐字相同） | ✅ key=slug |
| 书 | `channels` 13 行（含主 feed「肘后斋」） | `book_info` 12 行（`channels.id = book_info.id`；唯一不在的是主 feed） | ✅ 同 ID，12/12 |
| 卷章 | `items tcm_kind='chapter'` 10 本（81/81/81/79/31/27/25/22/11/7） | `book_chapter.source_book_id` 10 本，逐本卷数一致 | ✅ 同书同数 |
| 正文 | `items tcm_kind='section'` 8,066 行 / 854,481 字符 | `book_chapter_body` 8,066 行 / `section_text` 446,546 字符 | ✅ 同数（字符口径见下） |
| 方剂（引用目标） | `items tcm_kind='fang'` 804 行 | `fang_yao` 804 行 | ✅ 等量 |
| 中药（条目 + 引用目标） | `items tcm_kind='yao'` 172 行 | `zhong_yao` 172 行 | ✅ 等量 |
| 名词（条目） | `items tcm_kind='term'` 17 行 | `ming_ci` 17 行 | ✅ 等量 |

### ID 与口径：三处必须按数据处置

| 检查 | 实测 | 影响 |
| --- | --- | --- |
| 卷 ID 交集 | **0 / 445** | 445 个卷页地址失效（决策 11） |
| 条文 ID 交集 | **0 / 8,066** | 8,066 个 `#mf-toc-<id>` 锚点同上 |
| 方剂/中药/名词 ID 交集 | 0/804、0/172、0/17 | 993 个 `/i/<id>/` 条目页地址同上 |
| 卷的映射键 | `(source_book_id, chapter_section)` ↔ `(book_id, _microfeed.section)`，445/445 | 可用；`source_chapter_legacy_id` 只对 26/445，不可用 |
| 条文的映射键 | `receipt_no` ↔ `_microfeed.receiptNo`，8,066/8,066，全局唯一 | 可用 |
| `is_enable` 语义 | 非发布开关：按它过滤丢 7,136/8,066 正文、102/445 卷、743/1,585 次方剂引用 | 前台只能用 `deleted_at IS NULL` |
| 正文列布局 | 930 条本草行（`bencao_yao_name` 非空）正文在 `section_note`；只读 `section_text` 保留率 52.3%（本草两本 18.1%/6.7%） | 渲染需按 `bencao_yao_name` 分流拼接 |
| 中药/名词归属 | `zhong_yao` 无归属字段；`ming_ci.source_book_id` 分散在 4 本真实书；容器书两行已软删 | 两个容器书页会消失，172 条中药失去聚合入口 |

三条关键链路贯通：

1. **分类 → 书**：`book_groups.key = book_info.case_division`（ADR-0063 已证 100% 命中）。
2. **书 → 卷章 → 正文**：`book_info.id = channels.id`，`book_chapter.source_book_id → book_info.id`，`book_chapter_body.book_chapter_id → book_chapter.id`；跨源映射走规范 §4.1/§4.2 的业务键。
3. **标注层引用目标**：可链接码由 `ext_annotation_markers.link_type` 决定——`$f{}` 方剂（1,585 次 / 1,343 行）→ `fang_yao`（`fang_name` + `source_book_legacy_id`）；`$u{}` 中药（旧源 57 次 / 24 行）→ `zhong_yao`（`zhong_yao_name`）。`$a{}` 是按语（264 次，`link_type=0`），不参与解析。

## 决策

1. **前台站点整体切换真源，`channels`/`items` 从前台彻底退场，包括站点外壳**（用户裁决）。分类读 `settings.book_groups`，书读 `book_info`，卷章读 `book_chapter`，正文读 `book_chapter_body`，标注层引用目标读 `fang_yao`/`zhong_yao`，中药/名词条目页读 `zhong_yao`/`ming_ci`，站点级配置（站名/图标/描述/语言/版权/出版方/隐藏策略）直查 `settings`（后 4 个键由决策 14 的 `data` 迁移写入）。**前台不再调用 `loadPublishedFeed`/`loadFeed`，不再构造 `publicFeed`，不再走 mustache 主题渲染**——`publicFeed` 本身就是 `channels` + `items` 的组装结果，留着它等于留一条隐式旧真源依赖。前台页面改用 Astro 布局与组件渲染，视觉按 `themes/feed-zh/` 现版移植（决策 14）；页面结构与地址保持不变，卷/条文/条目的地址见决策 11。

2. **分类落地路由复用 `/category/[值]/`，值语义换成 `book_groups.key`**（用户裁决）。实测 `book_groups.key`（`shanghan`/`neijing`/`bencao`）与旧 `ext_category.slug` 逐字相同。切换后头部导航由前台组件直接遍历 `listGroups()` 生成 `/category/<key>/` 链接，不再经 `publicFeed.category_nav`。**解析只认 `book_groups.key`**：未命中即 404，不回查 `ext_category`——回查会让前台重新依赖旧分类表，违背零耦合不变式。旧 `/category/<ext_category.id>/`（3 个）直接 404（决策 11），不做地址映射。

3. **只改站点页面，公开 API 不动**（用户裁决）。`/api/v1/content/*`（`content-read.ts`）继续读 `ext_category`/`channels`，OpenAPI 契约不变。书的 ID 两侧相同，但**卷与条文的 ID 两侧完全不相交**（0/445、0/8,066），所以 API 与站点在「同一本书的卷章」上会返回不同的 id；内容文本一致，地址不同。**接受暂时的双源**（站点读独立模块、API 读 `ext_category`/`channels`），将来收敛 API 再单独做。

4. **首页书架一并切到 `book_info`**（用户裁决）。首页 `listPublishedBookSamples`（读 `channels`）改为读 `book_info`。书页「相关书目」同理。书页的**「附：方剂」块**（`getTcmBookFang`，`items WHERE tcm_kind='fang'` 按 `_microfeed.sourceBookId`，5 本书共 804 首）不删、只换源：改为 `fang_yao WHERE source_book_legacy_id = book_info.book_no`（与决策 6 同一条链），排序沿用 `fang_no`。这是在复核时补上的——原方案只写了「移除 `getTcmBook*`」，若照此实施会静默丢掉一块当前可见的内容。

5. **砍掉字数 / 章节数 / 「最近更新」整块**（用户裁决）。书页头部只保留作者 + 「开始阅读」+ 卷目录；字数、章节数、最近更新标题与日期全部不显示。连带 `ext_book_stats` 物化表 + `items` 触发器 + 懒自举**在前台失去最后消费者**（后台仍用，不动）。这避免为 44.6 万字符的小库重建一套聚合缓存——实测单本最多 545 行 / 3 千字符，物化是过度设计。

6. **标注层（可点标记浮层）全迁到独立模块**（用户裁决）。`markerPopover.ts` 的跨引用解析改读独立表：
   - `$f{}` 方剂引用 → `fang_yao`（按 `fang_name` + 书源组），过滤只加 `deleted_at IS NULL`；
   - `$u{}` 中药引用 → `zhong_yao`（按 `zhong_yao_name`），过滤只加 `deleted_at IS NULL`。
   方剂按书解析链：`book_info.id` → `book_info.book_no` → `fang_yao.source_book_legacy_id`。实测 5 组逐字相同（`10001`/`10002`/`1001000`/`9040000`/`9050000`），无需书名做中介，也不建外键（ADR-0065 零共享外键）。**`items` 的方剂/中药行不再是前台标注层的引用来源，运行时零 `items` 查询**。
   解析回归实测（验收基线一律按决策 9 的分流语料）：方剂旧 1,535/1,585 → 新 1,534/1,585（唯一回归为名称差异 `滑石乱发白鱼散` ↔ `滑石白鱼散`）。中药旧 44/57 → 新 44/57，零回归——本草 21 条中药标记写在 `section_note` 里，只有按 `bencao_yao_name` 分流拼接后才会进入渲染文本；**只读 `section_text` 会退到 36/57（断 21 次），统一拼接则会到 48/57 并把讲义内容带进人纪两本**。所以报告任何 `$u` 覆盖率都必须同时写明语料口径，单看次数无意义。浮层「组成」行按 `show_name` 匹配，覆盖 1,930/2,025 = 95.3%（分母是组成行数，与正文 1,585 次引用无关），余 95 行不生成链接。
   匹配范围限定在**当前书**，不做跨书回落（用户裁决 D5-A）。现网按书分组查方剂，实测比全局名表少解析 27 次跨书引用（1,534 vs 1,561），全部是人纪版正文引用登记在宋版/桂林古本下的方剂。跨书回落虽然能多解析 27 次，但同名方剂在宋版与桂林古本各有独立行（`桂枝汤` 在 `10001`/`10002` 各一条），跨书命中必须再定一条「落到哪本书的哪一行」的规则，等于把旧 `sourceBookId` 那套书本语义重新引回标注层；这 27 次是现网既有缺陷，保持按书不构成回归，因此不采纳。`refs.ts` 的方剂查询必须带 `source_book_legacy_id = ?`，禁止无边界的全表按名匹配。

7. **中药/方剂/名词引用与条目页全部走各自模块的前台路由**（用户裁决）。前台新增三条只读路由：`/zhongyao/[id]/`、`/fang-yao/[id]/`、`/ming-ci/[id]/`，取数分别只来自 `zhong_yao`、`fang_yao`(+`fang_yao_body`)、`ming_ci`。`$u{}` 浮层链接指向 `/zhongyao/<zhong_yao.id>/`，`$f{}` 指向 `/fang-yao/<fang_yao.id>/`，名词指向 `/ming-ci/<ming_ci.id>/`。方剂页的「所属书」按 `book_no` 反查 `book_info.book_name`（实测 5/5 与 `source_book_name` 逐字相同，见核准报告 §F.4），不读导入派生的 `source_book_name`，也不展示 `source_fang_legacy_id`。旧 `/i/[slug]/`（读 `items` + `channels`）整体退场，不在切换后的前台保留任何 `items` 取数路径。

8. **前台可见性一律用 `deleted_at IS NULL`，`is_enable` 不作为发布口径**（数据核准新增）。按 `is_enable=1` 过滤会丢 7,136/8,066 行正文（88.5%）、102/445 卷（22.9%）、743/1,585 次方剂引用（46.9%）——该列在独立模块里承载导入期语义（本草条目标记、方剂是否有组成、来源卷状态），与「是否发布」无关。书级另加 `hot_book = 0` 判据（决策 12 修订），只对 `book_info` 行生效，卷/正文/条目仍只看 `deleted_at`。

9. **正文渲染按 `bencao_yao_name` 分流**（数据核准新增）。`bencao_yao_name` 非空的 930 行（= `is_enable=1` 的全部行）渲染 `section_text + section_note`，其余 7,136 行只渲染 `section_text`。依据：旧正文去掉空白后 100% 是两列拼接的子串（8,066/8,066）；只读 `section_text` 保留率 52.3%（本草两本 18.1%/6.7%）；统一拼接会让「伤寒论・人纪」「金匮要略・人纪」多出 720.8%/1,346.9% 的讲义内容（约 23.6 万字符）。

10. **字数统计若保留则剥标记**（用户裁决 6-a-2 选 A）：任何仍需计数的场景，须先用 `markersToPlainText()`（`TcmMarkers.ts`）剥掉 `$x{内容}` 标记外壳再计数，使口径与前台渲染的纯文本一致。正文实测 1,468/8,066 行含标记、几乎无 HTML/Markdown。

11. **旧地址不做兼容，直接失效**（用户裁决 D1-A）。受影响：分类 3、卷页 445、页内锚点 8,066、条目页 993（方剂 804 + 中药 172 + 名词 17），合计 1,441 个页面地址 + 8,066 个锚点。被否掉的三种做法：
    - **路由兼容层读 `items` 反查**：前台保留一条 `items` 只读路径。
    - **一次性迁移补 `legacy_item_id`**：`legacy_item_id` 就是 `items.id` 换个列名存进新表，新模块从此长期携带旧表的 ID 语义，数据迁移、快照、种子脚本都要维护这一列，属于把耦合从「运行时查询」降级为「表结构依赖」，与「新模块与 `items` 无任何关系」相悖。
    - **手工维护的重定向表**：把 1,441 条 `旧 id → 新 id` 写进一张新表或一份静态清单，虽然不读 `items`，但数据来源仍是 `items.id`，且切换后再无真源可复核，会变成一份永久需要人工跟进的死数据。
    采纳 A：旧卷页/旧条目页/旧锚点一律 404，不写 301、不建映射表、不给任何新表加 `legacy_item_id` 这类以 `items.id` 为内容的列。分类的 3 个旧地址同理（`/category/<ext_category.id>/` 直接 404，不回查 `ext_category`）。代价是外部链接与书签失效，已知并接受：这个库的内容没有外部收录依赖，且地址稳定后不再变动。

12. **可见性 = 各模块自己的 `deleted_at IS NULL`，不引入 `channels.status` / `ext_book_status` 任何字段；书级另加 `book_info.hot_book = 0` 判据**（2026-11-07 会话修订）。`channels.status` 属于旧链路，不进入新引擎的判据（原「两本宋版书是否上前台」的裁决作废）。`hot_book` 是 `book_info` 自带的状态列（迁移 0173，`0 公开 / 1 隐藏 / 2 会员`），与旧频道状态无耦合，直接用作书级发布判据；只对 `book_info` 行生效，卷/正文/条目仍只看 `deleted_at`（**sitemap 卷页枚举是例外**：为不产出隐藏书卷的 404 URL，卷查询的 `book_info` EXISTS 子查询额外过滤 `hot_book = 0`，见决策 14）。现网非软删 10 本中公开 6 本（`5IGM9t76quT` 桂林古本、`OsOP62cyp3j` 神农本草经疏、`ydyQltIuQv6` 金匮宋版、`tZYk25WiJ0R` 难经、`ghBqURJwurj` 灵枢、`drsRImTi5tv` 素问），隐藏 1 本（`q6u5siNb2hT` 伤寒金匮宋版），会员 3 本（人纪三本 `XNK0VFX39Xv`/`ZhuBd0Vj7kl`/`Kcb7X2K5LTh`）；两行容器书（`4KbG9bDqdz3` 中药、`tcmterm0001` 名词）已软删。前台只列这 6 本公开书。

13. **中药/名词容器书不恢复、不建聚合入口**（用户裁决）。`book_info` 里「中药」（`4KbG9bDqdz3`）、「名词」（`tcmterm0001`）两行已软删（2026-11-06），不再出现在分类与首页。中药 172 条只在 `/zhongyao/[id]/` 单条可达，名词 17 条只在 `/ming-ci/[id]/` 单条可达；不再有「中药」「名词」两本书页。`zhong_yao` 无归属字段，不再造一个。

14. **站点外壳整体弃用旧链路，前台改由 Astro 布局与组件渲染**（用户裁决「全部去掉，旧 channels 体系」）。此前把「站点壳仍读 `channels`」当作不变式的例外，是错的：`loadPublishedFeed`（`src/server/feed/feed.ts:85`）经 `getPublicJsonData` 读主频道 `channels` 与 `items` 窗口，四个前台页面每页都调用它，字面上就不满足零耦合。切换后：
    - **删掉前台对 `loadPublishedFeed`/`loadFeed` 的全部调用**，不再构造 `publicFeed`，不再 `new Theme(publicFeed)`、不再 `themeContext`/`renderThemeTemplate`。主题的 mustache 契约本身就是 `publicFeed` 的形状，留一条 `publicFeed` 就等于留一条旧真源。
    - **中间件本次不改**（用户裁决「后端 / admin 不需要改动」）。`src/middleware.ts:485` 仍对每个非 `/api/AppBookRequest/`、非 `/api/app/` 的请求跑 `loadFeed` 并注入 `locals.feedContent`/`feedDb`/`feedCrud`。前台页面不再消费这份注入（取数走 `catalog/*` + `env.FEED_DB`），但每次请求仍会触发一次 `channels` + `settings` 的点查。这是**已知口径例外**，不写成「零读」：解耦体现在取数路径，不体现在中间件的开销上。
    - **站点级配置直查 `settings` 表**：`webGlobalSettings`（站名/图标/publicBucketUrl）与 `access`（站点隐藏策略）各一次点查，用一个 `loadFrontSite()`（`src/server/catalog/site.ts`）统一出口。`settings` 是通用配置表，`book_groups`/`book_info_statuses` 已在此表，不属 `channels`/`items` 体系，也不经过 `loadFeed`。
    - **站点外壳 4 个字段搬进 `settings`（复核补正 + 裁决 ③）**：`description`/`language`/`copyright`/`publisher` 的真源是主频道 `channels.data`——实测 `settings` 全库 13 个分类里没有任何一个含这 4 个键，`webGlobalSettings` 实际只有 `publicBucketUrl`/`favicon`/`itemsOrder`/`itemsSort`/`itemsPerPage`/`siteTitle` 六项。三条路（接受显示变化 / 让 `site.ts` 读主频道 1 行 / 搬进 `settings`）里**用户裁决 ③**：写一条 `data` 类型迁移，按实例从主频道复制这 4 个键进 `settings.webGlobalSettings`，并把 `favicon` 改写成现网生效值（当前 `settings.favicon` 等于 `LEGACY_DEFAULT_FAVICON_URL`，真实图标来自 `channel.image`）。迁移只用 `json_set`，不建表不加列，带 `-- rollback:`；`description` 存原文（读取时 `htmlToPlainText`）、`copyright` 存 `©{{current_year}}`（读取时 `resolveBuiltInTemplateVariables`），业务转换留在代码里。**代价三条**：① 本次唯一的库改动，破了「零迁移」；② 这 4 个键在 `/admin` 站点设置表单里没有编辑入口，写入后只能改库，补表单属独立工作；③ `settings.favicon` 的语义从「用户上传的图标」扩成「站点图标」，后台卡片会显示为已有自定义图标（前台输出不变）。收益是站壳零读 `channels` 且显示逐字不变——①② 各有一项做不到。
    - **视觉按 `themes/feed-zh/` 现版移植**：`web-header.mustache` 的三块 `<style>`（设计令牌 / novel 样式 / 编译后 Tailwind）与 `web-home.mustache` 的一块首页专属 `.mf-home-*` `<style>`，合计四块按原顺序原样提出为一份前台 CSS（实施时核准补入：只搬三块会丢首页书架样式）；`web-body-end.mustache` 的主题切换、图片懒加载、导航溢出脚本原样提出为前台脚本；`web-body-start`/`web-body-end` 的 header/footer 结构与 `web-home`/`web-category`/`web-feed`/`web-item` 的正文结构改写为 Astro 组件，**class 名与 DOM 层级不改**，视觉零回归。
    - **主题系统本身保留、但对前台失效**：后台的主题上传/切换/预览页与 `themes/` 目录不动，属于后台功能；前台不再受主题影响。这是明确接受的产品语义变化。
    - **站点文件端点与自定义页一并收口**：`sitemap.xml` 改由 `catalog/sitemap` 生成（首页 + 3 个分类 + 6 本公开书 + 对应公开书的卷 + 993 条目，书级只列 `deleted_at IS NULL` 且 `hot_book = 0`），不再经 `publicSiteFileResponse` 读 `publicFeed`/`listPages`；`rss`（含 `i/[slug]/rss`）、**`json`（`/json` 与 `i/[slug]/json` 两条，与 rss 同属公开订阅输出，`subscribe_methods` 里两者并列）** 与 `llms.txt`/`llms-full.txt`/`api/llms*` 下线；`[...path].astro`（自定义页）删除；`404.astro` 去掉 `loadPublicPageRoute` 的自定义 404 查询，只渲染通用标题。`server/site-files/public.ts` 与 `middleware.ts` 不动——前者仍服务 `robots.txt` 与运行时站点文件覆盖，`robots.txt` 因此每请求仍走一次 `loadPublishedFeed`（带 items 窗口），写成第二处已知例外。
    - **站点隐藏（`hidePublicWeb`）语义保留、来源换掉**：仍读 `settings.access.currentPolicy`，但经 `loadFrontSite()` 直查，不经 `channels`。行为不变（`headless`/`offline` 时前台 404）。

15. **浮层里「引用此方剂 / 引用此中药的条文」这一块在前台砍掉，不建新表**（用户裁决「换不了的砍掉不要了」+「后端 / admin 不需要改动」）。现状是前台写路径：卷页渲染 → `ensureMarkerCitations` → 整本 `SELECT ... FROM items WHERE book_id=? AND tcm_kind IN ('section','chapter')` → 扫 `$f{}`/`$u{}` → `INSERT OR REPLACE INTO ext_marker_citations`。索引的每一列都带旧体系语义（`section_id` 是 `items.id`、`section_seq` 是 items 的 rowid），必须换掉；而换成新模块要同时做三件事：
    - 建两张索引表（schema 变更）；
    - 后台保存正文后按书重算（改后台写入链）；
    - 后台方剂编辑器的反向引用视图改读新表（`ajax/tcm/fang-references`）。

    后两件都在「后端 / admin」里，与本次「只改前端主题」冲突。因此前台直接停止提供这一块：`buildTcmMarkerLayer` 不再调用 `ensureMarkerCitations`，浮层不再有 `references` 分组，其余内容（药名、方名、组成、按语样式）不变。**实施补正**：`ajax/tcm/fang-references.ts` 仍导入该函数，整段删除会让后台编译失败，所以函数与它对 `items` / `ext_marker_citations` 的读写保留在 `markerPopover.ts` 末尾的 `front-decoupling:ignore-start/end` 区段，只服务后台视图；静态解耦检查精确跳过该区段，前台取数链零读零写。`ext_marker_citations` 与 `ext_marker_citation_state` 原地冻结，不删表、不写迁移；后台那个视图继续读它，数据停在切换时刻，属已知遗留。
    显示影响仅限于此：条目浮层少一段反向引用列表，其余显示零变化。

16. **标记字典 `ext_annotation_markers` 保留，定位为「标记语法字典」**（用户裁决「这个保留，它给的是转换 `$u{}` 这些符号的」）。该表 15 行，列为 `code`/`title`/`color`/`small_font`/`link_type`/`sort_order`，不含任何 `items`/`channels` 引用——它描述的是正文里 `$x{}` 语法怎么显示、哪类可链接（`link_type`：`0` 不链接、`1` 中药、`2` 方剂、`3` 名词），属于跨内容引擎共享的语法与样式目录，不是旧内容体系的据点。前台允许读这一张 `ext_*` 表，且**只允许这一张**。
    - 更好的归并方案（不在本次范围）：把它搬进 `settings.marker_styles`，与 `book_groups` 同构，让 `ext_*` 表在前台彻底消失。代价是 15 行迁移 + 后台 CRUD + App 端 `GetTipsStyleConfig` 的 `version` 语义重建，收益只是命名洁癖，因此不做。将来若要做，必须保留 `link_type` 的三个取值语义。

## 零耦合不变式（实施与评审的硬判据）

**作用域 = 前台对外输出**：首页、分类页、书页、卷页、三条条目页，以及它们调用的 `catalog/*`、`markerPopover.ts`，加 `sitemap.xml`。`rss`、`json`（`/json` 与 `/i/<id>/json` 两条）与 `llms*` 下线、`[...path].astro` 删除后，前台不再有别的输出口。

**不在作用域内、但仍会读旧表的两处**（判据是「页面取数路径」，不是「全仓零读」）：① `src/middleware.ts` 的 `loadFeed` 注入（决策 14）；② `robots.txt` 经 `publicSiteFileResponse` 走一次 `loadPublishedFeed`。另外两个不重构的模块——`src/server/feed/siteNav.ts` 与 `src/server/site-files/public.ts`——本身读旧表，但它们的消费者是后台与站点文件端点，不在前台取数链上。以上静态检查都不扫。

在这个作用域内，**任何一条 SQL 都不得出现** `items`、`channels`、`ext_category`、`ext_book_stats`、`ext_book_status`。取数只允许来自这十处：

| 用途 | 唯一来源 |
| --- | --- |
| 题材分类 | `settings` 的 `book_groups`（经 `@/server/book-info/groups`） |
| 站点配置（站名/图标/描述/语言/版权/出版方/隐藏策略） | `settings` 的 `webGlobalSettings` + `access`（经 `catalog/site.ts`）；后 4 个键由决策 14 的 `data` 迁移写入 |
| 导航固定页 | `pages` 表（复用 `@/server/pages/service` 的 `navigationPages()`，不含任何旧内容语义） |
| 书 | `book_info` |
| 卷 | `book_chapter` |
| 正文 | `book_chapter_body` |
| 方剂（条目 + 引用目标 + 组成） | `fang_yao` + `fang_yao_body` |
| 中药（条目 + 引用目标） | `zhong_yao` |
| 名词（条目） | `ming_ci` |
| 标记语法与样式 | `ext_annotation_markers`（唯一允许的 `ext_*` 表，决策 16） |

六条推论：

1. **可见性** = 各表 `deleted_at IS NULL`，书级另加 `book_info.hot_book = 0`（决策 12 修订）；不看 `is_enable`（决策 8）、不看 `channels.status`（决策 12）。
2. **旧地址不做任何兼容**（决策 11）：不写 301、不建映射表、不给新表加 `legacy_item_id` 之类以 `items.id` 为内容的列。
3. **分类解析**不得回查 `ext_category`（决策 2）。
4. **带 `legacy` 字样的列不是旧表依赖**：`book_info.book_no`、`fang_yao.source_book_legacy_id`（源书号 `10001` 等）、`source_book_name` 都是新表自己的列，前台读它们只做「按书作用域过滤」与回显，两侧逐字相同故可直连，不经 `channels`、不建外键；`book_chapter.source_chapter_legacy_id`、`fang_yao.source_fang_legacy_id` 只服务导入脚本与后台维护，前台 SQL 不读，也不参与任何 URL 解析。
5. **方剂引用解析不出书**（决策 6）：`refs.ts` 里查 `fang_yao` 必须带 `source_book_legacy_id = ?`，禁止无边界的按名全表匹配。运行态行为靠测试断言守（给某一书的正文注入一个只存在于别书的方名，须降级为纯文本）；静态检查另锁住 SQL 里的书作用域字面量，防的是有人把该条件删掉。
6. **站点外壳不豁免**（决策 14）：上述作用域内不得出现 `loadPublishedFeed`、`loadFeed`、`getPublicJsonData`、`publicFeed`、`new Theme`、`themeContext`、`renderThemeTemplate`。这条比表名禁令更能抓住隐性耦合——`publicFeed` 是 `channels`+`items` 的组装结果，出现它等于出现旧真源。中间件与 `robots.txt` 两处不在此列：前者继续为全站注入 `loadFeed` 结果、后者经 `publicSiteFileResponse` 读一次 `loadPublishedFeed`，都属已知例外（决策 14），静态检查不扫。

静态检查 `scripts/check-front-site-decoupling.ts` 只查表名与符号：`src/server/catalog/**`、四条前台页面（`index`/`category`/`book`/`book/v`）、三条条目路由、`markerPopover.ts`、`sitemap.xml.ts` 的源码里，上述五个旧表名与推论 6 的七个符号出现即失败（注释与后台专用 `front-decoupling:ignore-*` 区段除外）；`legacy_item_id`、`ensureMarkerCitations`、`ext_marker_citations` 同样纳入禁用词。另有两条正向规则：内容表查询必须带 `deleted_at IS NULL`，方剂解析必须带 `source_book_legacy_id = ?`（推论 5 的运行态跨书降级仍靠测试断言守）。扫描范围明确不含 `src/middleware.ts`、`src/pages/robots.txt.ts`、`src/server/site-files/public.ts`、`src/server/feed/siteNav.ts`。门禁手动触发，不并入 `yarn check` 与 `microfeed-gate-subset`。

## 范围之外

- **本次零 DDL，但有一条 `data` 迁移**：`book_info`/`book_chapter`/`book_chapter_body`/`fang_yao`/`zhong_yao`/`ming_ci`/`settings` 沿用既有 schema，不加列、不建表。唯一例外是决策 14 的 `0189_data_front_site_settings.sql`（0188 之后的下一个空位，届时若被占用则顺延）——只 `json_set` `settings` 行（写站点外壳 4 个键 + 改写 `favicon`），带 `-- rollback:`，且独立于页面改造可先跑。反向引用块砍掉之后（决策 15），原计划的 `ext_citation_index` 两张表不再需要。
- **不动后端与 `/admin`**：所有后台页面、ajax 端点（含 `ajax/tcm/fang-references` 的反向引用视图与 `extBook.ts` 的删书清理）、权限码、写入链、`loadFeed` 为后台提供的注入，全部保持原样。前台只读新模块的表。
- **不动公开 API**：`/api/v1/content/*` 端点签名、OpenAPI 契约、`content-read.ts` 取数逻辑全部不变（决策 3）。
- **不动中药/名词的后台模块与二期规划**：`zhong_yao`/`ming_ci` 的后台 CRUD、`yao_alia` 联结等维持 ADR-0061 现状。
- **不物理删除任何旧表**：`channels`/`items`/`ext_category`/`ext_book_stats`/`ext_marker_citations` 全部原地保留。前四张仍是后台与公开 API 的真源；`ext_marker_citations` 冻结在切换时刻，供后台视图与回滚使用。
- **中间件不动**：`src/middleware.ts` 的 `loadFeed` 注入与站点文件覆盖逻辑保持原样；由此产生的「前台每请求仍读一次 `channels`」是已知例外，不属本次目标。
- **`src/server/site-files/public.ts` 不重构**：`robots.txt` 与中间件的运行时站点文件覆盖仍在调用它，只把 `sitemap.xml` 路由改为直连 `catalog/sitemap`；`llmsContent`/`sitemapContent` 分支保留为未用路径，不在本次清理。因此 `robots.txt` 每请求仍跑一次 `loadPublishedFeed`（带 items 窗口），与中间件并列为**第二处已知例外**，不宣称「前台零读」。
- **不删主题系统**：`themes/`、`Theme` 类、后台主题页保留，只是前台不再使用（决策 14）。
- **不写 `docs/` 散文断言测试**；文档校验走 `yarn docs:check`（执行时机归 AGENTS.md「最高指令」）。

## 后果

- **前台主题层彻底摆脱 `channels`/`items`，包括站点外壳**：分类、书、卷章、正文、标注层引用、中药/名词条目、站点外壳七层全切，站点配置改走 `settings`，`loadPublishedFeed`/`publicFeed`/主题渲染从前台页面退场。这是「解耦」诉求的实现结果——前台不再被 `tcm_kind`/`tcm_parent_id`/`genre`/`book_id` 的层层叠加绑架，也不再被「主频道 + 主题上下文」这层壳间接绑架。
- **URL 体系会断一层，且不补救**：书页地址不变（`book_info.id = channels.id`），分类地址由 `ext_category.id` 变 `book_groups.key`，卷页 445、条文锚点 8,066、条目页 993 的 id 全部换新。按决策 11，旧地址一律 404，不写 301、不建映射表、不加 `legacy_item_id`——这是「新模块与 `items` 零关系」的直接代价，已知并接受。站内导航、书页卷目录、标记浮层都按新 id 生成，切换后站内不再产出任何旧地址。
- **出现短暂的双源窗口**：站点读独立模块、公开 API 读 `ext_category`/`channels`（决策 3）。书的 ID 相同、卷与条文的 ID 不同，两边内容一致但地址不同。将来若要收敛 API，须再做一次「API 切独立模块」的独立工作。
- **`ext_book_stats` 前台失 consumer**：字数/章节数砍掉后，前台不再读它（决策 5）。后台字数统计照旧，表与触发器不动。
- **标注层引用来源从 `items` 换到 `fang_yao`/`zhong_yao`**（决策 6）。`markerPopover.ts` 的 `loadFangBySourceBook`/`queryYaoByPureName` 两条 SQL 改写。
- **浮层少了「引用此方剂 / 中药的条文」一段**（决策 15）：该块的数据源是前台自己写的旧索引表，换成新模块要动 schema 与后台写入链，本次按「换不了的砍掉」直接停止提供。其余浮层内容（药名、方名、组成、按语配色）与点击跳转全部保留。
- **主题系统对前台失效**（决策 14）：后台换主题不再改变前台外观。前台外观的唯一来源是 `src/styles/front-site.css` 与前台组件，改版式要改代码，主题配置不再影响前台。这是把「站点外观」从可配置主题改成受版本控制的组件，视觉按现版 `feed-zh` 一比一移植。
- **中间件不改，代价是每请求仍读一次 `channels`**（决策 14）：`src/middleware.ts` 的 `loadFeed` 注入原样保留，前台页面只是不再消费它。这条写成已知例外，不宣称「前台零读」——真正的判据是页面取数路径里没有旧表。
- **站点文件收口**（决策 14）：`sitemap.xml` 改由新模块生成，`rss`、`json`（两条）与 `llms*` 下线，`[...path].astro` 删除，`404.astro` 去掉自定义 404 查询。被删的 `[...path].astro` 原还承担后台路径 404 渲染，该分支整段迁入 `404.astro`；公共路径与后台路径分开渲染，后台注入缺失时沿用旧路由的就地抛错语义。前台对外的口子只剩新模块的取数，外加 `robots.txt` 这一处已知例外（仍经 `publicSiteFileResponse` 读一次旧真源）。
- **站点外壳无显示变化，但多一条迁移与一个后台缺口**（决策 14，裁决 ③）：4 个缺失键由 `data` 迁移从主频道复制进 `settings`，`favicon` 改写成现网生效值，所以 `<html lang>` 仍 `en-us`、版权仍 `©2026`、图标仍 `channel-image.png`。连带两件事：`settings.favicon` 的语义扩成「站点图标」（后台卡片显示为已有自定义图标，前台输出不变）；这 4 个键在 `/admin` 站点设置表单里没有编辑入口，改它们只能直接改库——补表单是独立工作，不在本次。
- **书页「附：方剂」块保留**（决策 4）：5 本书共 804 首，改按 `book_info.book_no = source_book_legacy_id` 取，显示不变。
- **标记渲染链不变**：`renderTcmMarkers`/`markersToPlainText`（`TcmMarkers.ts`）是纯函数，`section_text`/`zhong_yao_text`/`ming_ci_text` 原样存标记，渲染期处理。卷页新增一步「拼 `section_note`（仅本草）+ 转义 + 包 `<p>`」，因为旧站渲染的是 `items.description` 的 HTML。
- **前台只列公开书**：书级判据 = `book_info.hot_book = 0`（决策 12 修订）。现网 12 行里非软删 10 本，公开 6 本（桂林古本、神农本草经疏、金匮宋版、难经、灵枢、素问）；`伤寒金匮・宋版`（`hot_book=1` 隐藏）与人纪三本（`hot_book=2` 会员）不再出现在分类与首页。旧链路里金匮宋版按 `channels.status=10`（会员）本不显示，现因 `hot_book=0` 公开而出现——这是「不读 `channels`」加上「书级公开判据」的共同结果，且是可接受的：金匮宋版在 `book_info` 里就是一行公开的正常书。
- **前台少了两个书页**：「中药」「名词」两行在 `book_info` 已软删（2026-11-06），按 `deleted_at IS NULL` 列书不再出现（决策 13）。172 条中药、17 条名词改为单条可达，聚合入口取消；书页目录也不再列名词（正文 `$g` 标记仍链接名词详情页，见决策 7），名词仅经正文标记单条可达。
- **书卡字段来源变化**：封面取 `book_info.image_url`、作者取 `book_info.author`（10 本中 5 本有值）、简介取 `book_info.comment`、分类名取 `case_division` 对应的分组 label。字数标签消失（决策 5），连载状态不再显示（旧值取自 `_microfeed.serialStatus`，新模块无对应列）。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 只切分类导航、书/正文仍读 `channels`/`items`（档位 1） | 用户明确「因为耦合才切换掉 channels/items」，半切不解决根因 |
| 卷章目录切 `book_chapter`、正文仍读 `items`（档位 2） | 正文是耦合最重的一层，留着等于没切干净 |
| 标注层降级为不可点纯文本 | 丢失方剂/中药点击跳转，显示能力退化，违背「显示不变」 |
| 标注层继续读 `items` 解引用 | `items` 无法从前台退场，与「彻底脱离」矛盾 |
| 路由层反查 `items` 把旧地址 301 到新地址（D1 原 B） | 前台保留一条运行时 `items` 查询，零耦合不变式被打破 |
| 一次性迁移补 `legacy_item_id` 做旧地址 301（D1 原 C） | 该列内容就是 `items.id`，耦合从运行时查询转为表结构依赖，新模块长期携带旧表 ID 语义，与「与 `items` 无任何关系」相悖（用户裁决 D1-A） |
| 手工维护 1,441 条 `旧 id → 新 id` 的重定向表/静态清单 | 数据来源仍是 `items.id`，切换后无真源可复核，成为永久人工维护的死数据 |
| 方剂引用本书优先 + 全局跨书回落（D5 原 B） | 多解析 27 次，但同名方剂在宋版/桂林古本各有独立行，跨书命中要再定书本优先级规则，等于把旧书本语义带回标注层；27 次属现网既有缺陷（用户裁决 D5-A） |
| 用 `channels.status` / `ext_book_status` 判前台可见性（D4 原 B） | 把旧链路的会员/隐藏语义带进新引擎，正是要摆脱的耦合；且 `book_info` 侧无对应列，会形成双源判据 |
| 恢复「中药」「名词」两行容器书做聚合入口 | 与 `book_info` 现有 `deleted_at` 状态相反，且要为无归属字段的 `zhong_yao` 造一个归属 |
| 中药/名词条目页留二期 | 用户裁决这次全切，避免 `items` 在前台残留据点 |
| 为字数重建 `book_chapter_body` 聚合缓存 | 44.6 万字符小库上物化收益趋近于零，是过度设计；且用户直接砍掉该功能 |
| 换新路由 `/genre/[key]/` | 改变用户可见地址，违背「显示不变」 |
| 分类页跳带 `?group=key` 的书架页 | 改变页面结构，同上 |
| 用 `is_enable=1` 当前台发布口径 | 实测丢 88.5% 正文、22.9% 卷、46.9% 引用；该列是导入期语义（决策 8） |
| 统一渲染 `section_text + section_note` | 人纪两本页面膨胀 720.8% / 1,346.9%（约 23.6 万字符讲义），显示方式改变（决策 9） |
| 只渲染 `section_text` | 本草两本正文只剩条目名，保留率 18.1% / 6.7%，930 条正文丢失（决策 9） |
| 站点外壳保留读 `channels`，只切内容层（D6 原 A） | 四个前台页面每页都调 `loadPublishedFeed`，它读主频道 `channels` 与 `items` 窗口；把这层当「例外」等于声明一个自己都不成立的零耦合（用户裁决：全部去掉） |
| 站壳 4 个字段用硬编码默认值（P1 方案 ①） | `<html lang>` 由 `en-us` 变 `zh-CN`，`language` 从配置项退化成常量；与「显示方式不变」相悖 |
| 让 `site.ts` 读主频道 1 行（P1 方案 ②） | 零耦合例外从 2 处（中间件 + `robots.txt`）扩到 3 处，且要给 `site.ts` 在静态检查里开白名单——每开一个口子都要额外解释「为什么这行不算」 |
| 改中间件加前台白名单跳过 `loadFeed` | 能让前台每请求少读一次 `channels`，但用户裁决后端不改，属范围外的优化；留作后续性能项（决策 14） |
| 保留 mustache 主题，把新模块数据组装成 `publicFeed` 形状喂给模板 | 只是把 `channels`+`items` 的 JSON 形状复制一份到新引擎，主题字段（`_microfeed.volume`/`chapterNo`/`web_url`/`wordCount`）全要伪造，耦合从「读旧表」变成「假装还是旧表」；且模板消费的 `items.0.title` 与新源字段对不上（决策 14） |
| 反向引用继续用 `ext_marker_citations`，只把 `section_id` 换成新 id | `section_seq` 仍是 items 的 rowid，索引里同时存两套 id 体系；且写入路径仍要整本扫 `items` 才能重算（决策 15） |
| 建 `ext_citation_index` 两张新表、从 `book_chapter_body` 重算反向引用 | 需要建表迁移 + 后台保存正文重算 + 后台方剂编辑器改读新表，后两件在后端/admin 里，越出「只改前端主题」；用户裁决「后端 / admin 不需要改动」（决策 15） |
| 把 `ext_annotation_markers` 迁进 `settings.marker_styles` 让 `ext_*` 在前台消失 | 15 行纯配置，迁移要同时改后台 CRUD 与 App 端 `GetTipsStyleConfig` 的 `version` 语义，收益只是命名洁癖；保留并明确其定位即可（决策 16） |
| 用 `source_chapter_legacy_id` 做卷的跨源映射 | 只对上 26/445；正确键是 `chapter_section`（规范 §4.1） |
