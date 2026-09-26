# ADR-0010: 公开站三页统一到设计 token，并删除 localStorage 书架

- 状态：Accepted（全部决定已由用户确认）
- 日期：2026-09-25
- 决策人：用户

## 背景

`themes/feed-zh/` 的三个公开页面各自长出一套样式，互不知道对方存在：

| | 首页 | 详情页 | 阅读页 |
|---|---|---|---|
| CSS 位置 | `web-home.mustache` 自带 `<style>` | `web-header.mustache`（详情段） | `web-header.mustache`（阅读段） |
| 引用 `--mf-*` token | **0 处** | 结构用了，颜色硬编码 | 几乎全硬编码 |
| 页面底色 | 白（继承 `body`） | `#f5f6f8` | `#f2f2f2` |
| 移动端断点 | `600px`（+`900px`） | `50rem` / `42rem` / `25rem` | **无** |

根因是一处**命名事故**：`--mf-background` 同时被当作「页面底色」和「卡片底色」用
（`html` / `body` 拿它当画布，`.mf-detail-card` / `.fq-header` 也拿它当浮层），
于是任何一页想让自己的画布变灰，只能硬编码——否则会把所有卡片一起染灰。

同源症状：

- 主按钮两套 hover：`.mf-btn--primary` 用 `filter: brightness()`，`.mf-detail-btn--primary` 硬编码 `#e65c00`；
- `.mf-detail-icon-btn` 是 2.5rem 圆形，两个汉字挤在里面；
- 详情页 / 分类页残留 `margin: -2em -1em -4em`——那是为抵消共享样式表的 `html` padding 写的，
  而 `html:has(.fq-header)` 早已把该 padding 归零，负 margin 只剩副作用（把面包屑拖到 sticky header 底下）；
- 阅读页工具条 `position: fixed` 贴右边缘，窄屏直接压在正文上；
- sepia（米黄）按钮**几乎无效**：它只换 token，而阅读页底色是硬编码的 `#fff`。

## 决策

1. **新增一层「画布」token，拆开命名事故**：`--mf-page-bg`（页面画布）与
   `--mf-background`（浮层 / 卡片 / header）。两者语义自此互不重叠。
2. **扩充语义 token 并全量迁移**：三页与共用类的硬编码色全部换成 token。新增
   `--mf-on-accent`、`--mf-novel-hover`、`--mf-brand`、`--mf-brand-dot`、
   `--mf-warning{,-bg,-text}`、三个渐变（`--mf-cover-gradient` / `-soft` / `--mf-avatar-gradient`）、
   `--mf-radius-{card,control,pill}`、`--mf-shadow-card{,-hover}`。
3. **三页统一到 `#f5f6f8` 灰底 + 白卡片**：首页卡片由「无底色」升为白卡片，
   与详情页 / 分类页的 `.mf-detail-card` 同一种表面。
4. **按钮收敛**：主按钮共用一套圆角（`--mf-radius-pill`）与同一 hover；
   `.mf-detail-icon-btn` 由圆形改为同高 pill。
5. **移动端断点统一到 768px**：rem 断点全部换成 px；阅读页补上断点（工具条转到底部横排）。
6. **删除 localStorage 书架**（详见下节）。
7. **本次只做浅色**。暗色（`.dark`）与阅读页夜间（`html[data-mf-reader-night]`）**不进范围**，
   但新 token 必须补齐暗色取值——否则浅色值会漏进暗色模式。

## 理由（trade-off）

- **为什么是 token 化而不是重设计**：三页版式是原型定的。重设计会同时动版式与配色，
  出问题时无法判断回归来自哪一侧。token 化把改动限制在「同一个值换个名字」，可用 grep 验收。
- **为什么保留 `--mf-background` 这个容易误解的名字**：它已被编译产物
  （`#microfeed-compiled-styles` 的 `--color-mf-background`）与 sepia 块引用，改名要同时动两处且无收益；
  改用注释 + 新 token 表达区分。
- **为什么强调色没有合并**：站内并存三种——`--mf-accent`（蓝，链接）、`--mf-novel`（橙，主操作）、
  `--mf-brand`（红，header hover/active + logo）。合并它们是**可见的重设计**，超出本次范围，
  故只做 token 化并在此备案。
- **为什么 sepia 会「顺便」生效**：sepia 本来就是靠换 token 实现的，阅读页底色一旦接上 token 就自动跟随。
  这是 token 化的自然结果，不是额外功能。
- **为什么删除书架而不是隐藏**：它是纯前端 localStorage 功能（无账号、无服务端状态、无路由、无测试引用）。
  只删一半（例如留入口）会产生「能看不能加」的半残状态；要么完整保留，要么完整删除。

## 上游影响

- **本次改动全部落在 `themes/feed-zh/`**（该目录在 fork 点 `b510bb2` 的 `main` 上**不存在**）
  ⇒ **零合并冲突面**；`local.feed-zh` 也不在 `BundledThemeCatalog.ts` 里。
- ⚠️ **但这是漂移成本，不是零成本**：`themes/feed-zh/web-header.mustache` 是上游
  `themes/default/web-header.mustache` 的**副本**（diff = 1 删 / 1393 增）。
  上游改 default 主题时**不会**自动同步过来，本主题需**人工判断是否跟改**。
  本次 token 化**加剧**了这层分叉（新增了上游没有的 token 名）
  ⇒ **合并上游时必须人工复核 default 主题的样式变更**。
- **不改 `src/`**：`src/pages/i/[slug]/index.astro` 仍向模板传 `current_chapter_id`（原为书架按钮准备）。
  它现在**无人消费**，但删除它需要 `manage deploy`（而非仅 `theme install`），且会碰到上游文件，
  故本次**只记录不处理**（见「未处理项」）。
- **主题管理面**：磁盘 `themes/feed-zh/*` 是创作源、D1 是运行源。`manage theme install` 只
  **INSERT 新行**（`UNIQUE(package_id,version)`）、**从不 UPDATE**，装完**必然 inactive**，需再 `activate`。
  两侧**无分歧检测**——在 Admin 的 `ThemeBundleEditor` 里改出来的主题会与磁盘包**静默分叉**。
  ⇒ 本主题的**唯一事实来源是磁盘**，不要用 Admin 编辑器改它。

## 删除 localStorage 书架（本次一并执行）

删掉的 5 处：

1. `web-body-start.mustache` 头部「我的书架」入口（含计数徽标）——删后导航自动收紧；
2. `web-feed.mustache` 详情页「加入书架」按钮；
3. `web-item.mustache` 阅读页「加入书架」按钮（连带 `{{#book.id}}` 包裹块）；
4. `web-header.mustache` 的 `#microfeed-bookshelf-styles` 整块（29 行）；
5. `web-body-end.mustache` 末尾的书架 `<script>`（215 行，含只服务书架的
   `rememberChapter()` / `resumeUrl()` / `describe()`）。

- **不清理**浏览器里已存在的 `microfeed:bookshelf` 残留：无人再读取它，无害；
  清理反而要再挂一段一次性脚本。
- 影响面已实测：`src/`、`tests/`、`migrations/` 对书架**零功能引用**
  （命中的 `shelf` 全是「书库 / 首页」的同义词），无 i18n 键，无路由。

## 影响 / 实施项

1. `web-header.mustache`：token 块扩充 + 三页硬编码色迁移 + 按钮收敛 + 断点统一 +
   阅读页移动端布局 + 删书架 CSS 块。
2. `web-home.mustache`：token 化 + 卡片升为白卡 + 断点 `600px` → `768px`。
3. `web-body-start.mustache` / `web-feed.mustache` / `web-item.mustache` / `web-body-end.mustache`：删书架。
4. `microfeed-theme.json`：`0.1.25` → `0.1.26`（`install` 拒绝同 `packageId@version`）。
5. 生效路径：**只需 `manage theme install` + `activate`，不需要 `manage deploy`**（未动 `src/`）。
6. 验收：静态 grep（三页模板与 CSS 中，除 token 定义与阅读页夜间块外无硬编码色）
   + CDP 实测（三页 `body` 计算背景色 == `rgb(245, 246, 248)`、按钮几何一致、无横向溢出）。

## 验收结果（2026-09-25，线上 `local.feed-zh@0.1.27`）

静态（grep 三页模板与 CSS）：除 token 定义块、编译产物块、阅读页夜间块外，**无硬编码色残留**；
`web-home.mustache` 为 0；断点只剩 px（`480 / 768 / 800 / 900`）。

动态（CDP 直连线上，桌面 1264px 与窄屏 484px 各一轮）：

| 断言 | 首页 | 详情页 | 阅读页 |
|---|---|---|---|
| `body` 计算背景色 == `rgb(245, 246, 248)` | ✅ | ✅ | ✅ |
| 卡片表面为白 + 圆角 12px | ✅ | ✅ | —（阅读页壳本身即白） |
| 书架节点数 == 0 | ✅ | ✅ | ✅ |
| 无横向溢出 | ✅（桌面） | ✅（桌面） | ✅（两档） |
| 面包屑不被 sticky header 遮挡 | — | ✅（65 / 89） | — |

- 详情页三个操作按钮几何一致：`h=40`、`border-radius: 999px`、`font-weight: 600`。
- 窄屏 484px：首页网格塌为 **单列**；阅读页工具条 `flex-direction: row`（底部横排），且不覆盖正文。
- **sepia 由死变活**：`body` 背景 `rgb(245,246,248)` → `rgb(236,226,205)`；
  再叠加夜间时 `rgb(32,32,32)`、正文 `rgb(233,233,233)` ⇒ **夜间仍压过 sepia，优先级未被破坏**。

## 未处理项（已知缺口，留给后续）

| 项 | 原因 |
|---|---|
| ⚠️ **共享导航栏 `.fq-*` 在窄屏横向溢出** | 实测 484px 视口下 `scrollWidth = 876`：`.fq-header-right` 宽 381px 被 `.fq-header-left` 推到 x=495。`.fq-*` 无移动端档位且子项是 `!important` 固定宽度（搜索框 240px、间距 32/40px）、不换行。**改动前即存在**（删掉头部书架按钮反而让右侧窄了约 90px）。修它需要先定「移动端搜索框 / 登录注册 / 导航三项如何取舍」——属设计决定，未擅自改 |
| 暗色（`.dark`）视觉验收 | 本次只做浅色；新 token 已补暗色取值，但未逐页核对 |
| 阅读页 `html[data-mf-reader-night]` 硬编码夜间色 | 按决定原样保留；已实测**优先级仍高于 token**，未被覆盖 |
| `--mf-accent` / `--mf-novel` / `--mf-brand` 是否合并 | 属可见重设计，另议 |
| `themes/feed-zh/rss-stylesheet.xsl` 的 17 处硬编码色 | RSS 样式表是独立产物，自带一份**不含 `--mf-novel`** 的 token 副本、拿不到站点 token；不在三页范围内 |
| `src/pages/i/[slug]/index.astro` 的 `current_chapter_id` 死上下文 | 需 `manage deploy`，另开一次 |
| 分类页 / 搜索页 | 按决定只做对齐（二者本就零硬编码色，自动继承新画布），不重设计 |
| ⚠️ **登录态管理员 UI 端到端验证** | 本机只有 Worker 密钥、**无管理员明文凭证**。`/admin/*` 的改动只能靠「服务端代码静态核对 + 组件渲染测试 + D1 直写后的实时渲染探针」证明，真正的「管理员点一次保存」未做（第五轮站点标题迁移即属此类） |

## 补充：按钮收敛为单一样式（2026-09-25 第二轮，`0.1.27` → `0.1.29`）

### 做了什么

1. **删掉第二套按钮**：`.mf-btn` / `.mf-btn:hover` / `.mf-btn--primary` / `.mf-btn--primary:hover`
   与 `.mf-book-actions` 在 `themes/`、`src/`、`tests/` **零引用**（grep 计数 0），是上一轮漏掉的死代码。
   上一轮只统一了它们的 hover 取值，等于把死代码维护成了「看起来还活着」的样子。
2. **`<button>` 并入同一套**：详情页「分享」由 `class="mf-detail-icon-btn"` 改为
   `class="mf-detail-btn mf-detail-btn--secondary"`，`.mf-detail-icon-btn` 整个删除
   （名字也已失真——它早已不是图标按钮，而是文字 pill）。
3. **几何只在基类声明一次**：`.mf-detail-btn` 补 `border: 0` / `cursor: pointer` /
   `font-family: inherit` / `text-decoration: none`，字号 `.875rem` 落到基类。

### 为什么（两个真 bug，本身就是「统一」的理由）

- **字号不一致**：`.mf-detail-icon-btn` 复制了圆角 / 高度 / 内距 / 字重，**唯独漏了字号**。
  `<button>` 于是回落到 UA 默认 `13.3333px`，与相邻 `<a>` 的 `14px` 并列；内距用 `em`
  又把它一起放大成 `16.67px` vs `21px`。实测：`13.3333px / 0 16.6667px` 对比 `14px / 0 21px`。
  **改动后三者统一为 `14px / 0 21px`。**
- **`:visited` 劫持主按钮颜色**：编译产物末尾是
  `a, a:visited { color: var(--mf-accent) }`（特异度 `0,1,1`），
  而 `.mf-detail-btn--primary` 只有 `0,1,0` ⇒ 读者**读过第一章再回详情页**时，
  「开始阅读」的标签会从白色变成强调蓝，压在橙色 pill 上。

### 怎么证明的（`:visited` 无法用常规手段观测）

`getComputedStyle` 出于隐私**不反映 `:visited`**，静态读数永远是白的；无头环境历史库为空，
真实访问也触发不了。唯一可靠路径是 **CDP `CSS.forcePseudoState(nodeId, ["visited"])` + 像素采样**：

| 样本 | 强制前 | 强制后 |
|---|---|---|
| 修复前 `[data-mf-detail-start]` | `accent_blue = 0`、`white = 5683` | `accent_blue = 2544`、`white = 3149` |
| 修复后 `[data-mf-detail-start]` | `accent_blue = 0`、`white = 5683` | **`accent_blue = 0`、`white = 5683`（逐像素相同）** |

对照实验（同页注入两个同类锚点）确认这不是采样噪声：单类选择器 `(0,1,0)` 被 `:visited`
染成 accent 蓝；而自带 `:visited` 伴生规则的 `.mf-footer-link` 保持 `#19b7fa` 不变。

### 修法

`.mf-detail-btn.mf-detail-btn--primary` / `--secondary` —— **重复类名取 `(0,2,0)`**。

选它而不是「补一条 `:visited` 伴生选择器」，是因为伴生写法只与 `a:visited` **打平**在 `(0,1,1)`，
要靠 tie-break 才赢。实测本主题的 `.mf-footer-link:visited` 确实赢了，但那是一个**尚未解释清楚**
的行为（源码顺序上 `a:visited` 更靠后，按常规层叠应当它赢）；按钮不该依赖这种运气。
`(0,2,0)` 与源码顺序无关，稳定胜出。

### 验收（线上 `local.feed-zh@0.1.29`，CDP 直连，全新 profile）

| 断言 | 结果 |
|---|---|
| 三个操作按钮字号 / 内距 / 高度 / 字重 / 圆角一致 | ✅ `14px` / `0 21px` / `40` / `600` / `999px` |
| `.mf-btn` 全族实例数 == 0 | ✅ |
| `.mf-btn` / `.mf-book-actions` / `.mf-detail-icon-btn` 全仓残留 | ✅ 0 处 |
| 强制 `:visited` 后主按钮仍为白字 | ✅ 逐像素不变 |
| 三页 `body` 背景 / 卡片圆角 / 无横向溢出 / 书架节点 0 | ✅ 与上一轮一致，无回退 |

### 仍未处理（补充）

| 项 | 原因 |
|---|---|
| 其它「单类着色」锚点仍有同类风险 | 凡是没有 `:visited` 伴生规则、又自己设 `color` 的锚点组件，都可能被 `a:visited` 劫持。本轮只修了详情页按钮（用户点名范围）。`.mf-footer-link` 实测安全（自带伴生规则）；`.mf-site-brand` / `.mf-nav-*` / `.mf-site-search` / `.mf-theme-*` 是**压缩块里的上游遗留 CSS**，本主题模板 0 引用，属死 CSS，另议 |

## 暗色验收（2026-09-25，`0.1.29` → `0.1.30`）

上一轮的「未处理项」把「暗色（`.dark`）视觉验收」留了下来。补做后发现一处**由本轮 token 化引入的回归**，已修。

### 方法

线上站点的主题偏好存在 `localStorage["microfeed-public-theme"]`，脚本在加载时把它映射成
`<html class="dark">` + `data-theme-preference`。所以 CDP 驱动先在该 origin 写入 `dark`，
再逐页导航 → 读计算值 + 抓整页截图。（直接导航只会渲染浅色，看起来「暗色没生效」。）

### 结果（`local.feed-zh@0.1.30`，CDP 直连，全新 profile）

| 断言 | 首页 | 详情页 | 阅读页 |
|---|---|---|---|
| `html.dark` 生效、`colorMode == dark` | ✅ | ✅ | ✅ |
| `body` 背景 == `--mf-page-bg` `#010409` | ✅ | ✅ | ✅ |
| 卡片 == `--mf-background` `#0d1117`、圆角 12px | ✅ | ✅ | ✅（阅读页壳即此色） |
| 正文色 == `--mf-text` `#f0f3f6` | — | ✅ | ✅ |
| 三个按钮 `h=40 / 999px / 600` 一致 | — | ✅ | — |
| 主按钮 `#ff8a3d` 橙底 + 白字 | — | ✅ | — |
| 次级按钮 `#161b22` 底 + `#f0f3f6` 字 | — | ✅ | — |
| 无横向溢出 / 书架节点 0 | ✅ | ✅ | ✅ |

**暗色分层方向正确**：`--mf-page-bg #010409` 比 `--mf-background #0d1117` 更深，
与浅色（画布 `#f5f6f8` 比卡片 `#ffffff` 更深）方向一致。

### 顺带修掉一处回归：夜间开关在暗色下反向变亮

阅读页的 `html[data-mf-reader-night]` 把背景硬编码成 `#202020`。这个值是在阅读页底色还是
硬编码 `#fff` 的时候定的。本轮把阅读页底色接上 token 后，暗色下底色变成 `#0d1117` ——
于是**按「夜间」反而把页面照亮**（`#0d1117` → `#202020`）。

顺带说明：**同一处 token 化也修好了一个更严重的老问题**——改动前阅读页底色是硬编码 `#fff`，
所以**暗色模式下阅读页整页是白的**。

修法：新增 `--mf-reader-night-bg`（浅色 `#202020` / 暗色 `#000000`），夜间块改用它。
要守住的不变式是「**夜间必须比当前画布更深**」，token 化让它在两种模式下都成立。

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 浅色 + 夜间 | `rgb(32,32,32)` | `rgb(32,32,32)`（不变） |
| 暗色 + 夜间 | `rgb(32,32,32)`（**比底色 `#0d1117` 更亮**） | `rgb(0,0,0)` |

### 仍未处理（暗色）

| 项 | 原因 |
|---|---|
| 暗色下「夜间」开关是否还有存在意义 | 暗色本身已是夜间环境，该按钮只是把页面再压暗一点（`#0d1117` → `#000`）。**是否在暗色下隐藏或改名它是 UX 决定**，未擅自改 |
| 分类页 / 搜索页 / RSS 的暗色 | 未逐页核对（分类页零硬编码色，应自动继承新画布） |

## 补充：详情页三个按钮拉平（2026-09-25 第三轮，`0.1.30` → `0.1.31`）

### 决定

详情页「开始阅读 / 查看目录 / 分享」三个按钮的**背景统一为 `--mf-surface`**
（浅色 `#f6f8fa` / 暗色 `#161b22`），文字统一为 `--mf-text`。
`.mf-detail-btn--primary` 与 `.mf-detail-btn--secondary` **一并删除** ——
两者取值相同之后已无区分作用，留着就是死代码（与上一轮删掉 `.mf-btn` 全族同一个理由）。

代价（用户已知情选择）：**主操作不再突出**，整排按钮在白色卡片上很淡
（`#f6f8fa` vs 卡片 `#ffffff` 只差 9 级）。若要恢复层次，重新加一条 modifier 即可。

原先 `.mf-detail-btn--primary` 是橙底白字药丸、`--secondary` 是近白底深字，
并列时视觉权重差得太多，这是拉平的直接原因。

### 修法

几何留在基类；颜色规则仍**重复类名**（`.mf-detail-btn.mf-detail-btn`，`(0,2,0)`）——
这不是美观选择，是必须的：见上文「编译产物最后一条规则劫持 `<a>`」，
单类 `(0,1,0)` 会在 `:visited` 态被 `a, a:visited`（`(0,1,1)`）压过。
模板三处 `class` 简化为 `mf-detail-btn`。

### 验收（CDP 直连线上，全新 profile）

| 断言 | 浅色 | 暗色 |
|---|---|---|
| 三按钮 `background` | `rgb(246,248,250)` 全同 | `rgb(22,27,34)` 全同 |
| 三按钮 `color` | `rgb(36,41,47)` 全同 | `rgb(240,243,246)` 全同 |
| 几何 `h40 / 14px / 0 21px / 600 / 999px / border 0` | 全同 | 全同 |

**`:visited` 回归验证**（`CSS.forcePseudoState` + 像素计数，`[data-mf-detail-start]`，3× 缩放）：

| 态 | 直方图 |
|---|---|
| plain | `#f6f8fa` 26488 px · `#ffffff` 4596 px · `#24292f` 2188 px |
| forced `:visited` | **逐像素完全相同** |

即重复类名在 `:visited` 态依旧生效，标签没有被 `a, a:visited` 翻成强调蓝。

全仓 `mf-detail-btn--` 残留 **0**；六类页面均 200（首页 92078 / 详情 91181 / 分类 87734 /
阅读 88005 / 搜索 86390 / well-known 183 字节）。

## 补充：主题版本收敛为单版本（2026-09-25 第三轮）

### 决定

`local.feed-zh` 在 D1 只保留**当前 active 那一版**（`0.1.31`），其余历史版本全部删除。
0.1.0–0.1.21 此前已是软删除态；本轮再删 0.1.22–0.1.30 共 **9** 个。

代价（用户已知情选择）：**没有可回滚的上一版** —— `theme_state.previous_theme_id`
被清成 `NULL`。要回滚只能重新 `install` 一次旧源码。

### 方式：走官方 CLI，不直接 DELETE

`manage theme delete <theme-id> --confirm <theme-id>` 的行为（读 `manage-cli/theme.ts`
`deleteLocalTheme` 确认）：

- 软删除（写 `deleted_at`），不是物理 DELETE；
- 拒绝内置主题（`source_kind = 'bundled'`）；
- 拒绝当前 active 版本；
- **自动把 `theme_state.previous_theme_id` 清空**（若它指向被删的 id）——所以不会留悬空指针；
- 只有在该版本的 `asset_owner_theme_id` 不再被其他非删除主题/草稿引用时，才去删 R2 资产。

⛔ 不要用 `wrangler d1 execute … DELETE FROM themes` 绕过：物理删除不清理 R2 资产，
会留下孤儿对象，且不可恢复。

### 结果

| | 前 | 后 |
|---|---|---|
| 非删除主题行 | 16 | **8** |
| `local.feed-zh` 非删除版本 | 10（0.1.22–0.1.31） | **1（0.1.31，active）** |
| `theme_state.previous_theme_id` | `0.1.30` | `NULL` |

7 个内置主题（`microfeed.default@1.1.16` / blog / photo / podcast / video / curation /
changelog）**未动** —— 它们是后台「安装主题」列表的来源，且 CLI 本身也拒绝删除。

### 仍未处理

| 项 | 原因 |
|---|---|
| 内置主题版本堆积 | `microfeed.default` 有 `1.1.15`（已软删除）+ `1.1.16`；`manage-cli/lib/bundled-theme-pruning.ts` 是上游的清理机制，本轮未动 |
| 没有保留回滚版本 | 用户的明确选择；如后续想保留「上一版」，重新 `install` 一次即可 |

## 补充：站点标题独立成变量（2026-09-25 第四轮，`0.1.31` → `0.1.32`）

### 决定

页眉 logo 的文案不再直接吃频道标题，改由一个**独立可配置的站点标题**决定：

- 新增顶层模板变量 `site_title`，主题 `web-body-start.mustache` 的 logo 改用它；
- 取值优先级：`channel._microfeed.siteTitle`（Admin 在「频道 > 站点」填）→ 回退 `channel.title`；
- `site_title` **总是有值**，主题可以无条件写 `{{site_title}}`，不必 `{{#site_title}}` 兜底。

这样对外站点名与频道自身名解耦：频道仍叫「星河剑歌」（RSS / JSON Feed 用它），
页眉文案由「站点标题」字段单独控制。

### 落点（四处，全部是上游文件的插入级改动）

| 位置 | 改动 |
|---|---|
| `src/shared/themes/ThemeRenderer.ts` | `themeContext()` 末尾加 `site_title`；新增模块级 `resolveSiteTitle()` 读 `publicFeed._microfeed.siteTitle`（裁剪空白，类型不符或空白即回退） |
| `src/shared/themes/ThemeContract.ts` | `themeContextSchema` 加可选 `site_title`（带 `.meta({description})`）；`themeFeedExtraSchema` 加可选 `siteTitle` |
| `src/components/admin/channel/EditChannelApp/index.tsx` | 「书籍状态」卡之后追加「站点」卡，一个输入框走已有的 `onUpdateMicrofeedMeta('siteTitle', …)` |
| `themes/feed-zh/web-body-start.mustache` | logo 的 `{{title}}` → `{{site_title}}`（含 `aria-label`） |

**没有新增 DB 列**：`channels.data` 是 JSON，`_microfeed` 本来就是 `.loose()` 扩展口袋
（`genre` / `tags` / `serialStatus` / `signStatus` 都住这里），`siteTitle` 沿用同一约定。
`FeedPublicJsonBuilder._buildPublicContentMicrofeedExtra()` 开头已有 `...channelMicrofeed`，
所以服务端一行都不用改，值自动进 `publicFeed._microfeed`。

⚠️ `themeContextSchema` 被 theme-kit 消费（`packages/theme-kit/scripts/build.ts` 用
`z.toJSONSchema` 生成 context schema，`tests/unit/theme-kit.test.ts` 断言磁盘 JSON == 现算 schema），
**改完必须 `yarn theme-kit:build`**，否则该测试红。

### 验收

**代码层**（`tests/unit/theme-site-title.test.ts`，8 例）：回退 / 覆盖 / 空白与非字符串回退 /
前后空格裁剪 / 缺 `title` 时给空串；`FeedPublicJsonBuilder` 确实把 `siteTitle` 带进
`publicFeed._microfeed`；**用真实 `web-body-start.mustache` 渲染**，logo 出站点标题且不含频道名。

**线上端到端**（读实时渲染，绕过边缘缓存）：

| 步骤 | `_microfeed.siteTitle` | 实时渲染 logo |
|---|---|---|
| 部署 + 切主题后 | （未设） | `星河剑歌`（回退频道标题） |
| 写入探针 | `星河剑歌·探针` | **`星河剑歌·探针`** ✅ 证明字段真的在起作用 |
| 写入最终值 | `星河剑歌` | `星河剑歌`（探针残留 0） |

⛔ **踩坑记录**：直接改 D1 后抓首页**看不到变化** —— 公开页有 Cloudflare 边缘缓存
（`Cloudflare-CDN-Cache-Control: public, max-age=300`，见 `src/server/cache/public-cache.ts`），
浏览器侧的 `Cache-Control: no-cache` 只管浏览器。
要读实时渲染，用**不合法的分页 query**（如 `/?probe=1`）：`validPaginationQuery()` 返回 false →
`Cloudflare-CDN-Cache-Control: no-store`，直接回源。该响应的 `Cache-Control` 是
`private, no-store`，正好可用来区分是否绕过了缓存。

### 版本收敛

按第三轮定下的规矩（只留最新版 + 上一版）install `0.1.32` 并 activate：
线上 `local.feed-zh` 非删除版本 = `0.1.32`（active）+ `0.1.31`（回滚点），正好两个，无需再删。

## 补充：站点标题迁到设置页（2026-09-26 第五轮，`0.1.32` → `0.1.33`）

### 决定

上一轮把站点标题挂在「频道 > 站点」，本轮**整体迁到设置页**：Admin 在
`/admin/settings/` 的「站点标题」卡片里填，值存 `settings.webGlobalSettings.siteTitle`。

- 入口：`/admin/settings/` 新增 section `site`（侧栏图标 `globe`）；
  `/admin/channels/primary/` 上那张「站点」卡**删掉**；
- 存储：`channel._microfeed.siteTitle` → `settings.webGlobalSettings.siteTitle`；
- 模板变量 `site_title` 与回退语义**完全不变**，主题一个字都不用改。
- 侧栏项与卡片标题显示为**「站点标题」**（用户当日追加要求）。两者共用 `settings.site`
  这一个键，所以改值即同时生效；section 的 `id` 仍是 `site`（锚点/深链不变）。
- 卡内输入框的 label 收窄为**「标题」**（`settings.siteTitle`），**不再与卡片标题同名**。
  上游约定是「卡片标题 = 类别，字段 label = 更窄的字段名」：条目设置 → 排序 / 每页条目数、
  媒体文件存储 → R2 公开存储桶 URL。改名后站点卡一度两处都叫「站点标题」，是全页唯一违反
  该约定的卡（用户拍板：保留上游约定，只改自研的这一侧）。保留 label 而不是删掉，是因为
  `AdminInput` 靠 `<label>` 包裹提供 accessible name，占位符替代不了。

理由是归属：站点标题是**站点级**身份，不是频道级属性。它跟 favicon 是同一类东西
（favicon 本来就住在 `settings.webGlobalSettings`），却要为了改一行页眉文案去动频道数据、
还得先有频道管理权限，明显不合理。迁移后站点身份与频道彻底解耦。

### 落点

| 位置 | 改动 |
|---|---|
| `src/components/admin/settings/SiteSettingsApp/index.tsx` | **新建**（自研）。照 `ItemsSettingsApp` 的模板写：`AdminInput` + `SettingsBase` 右上「更新」，`onSubmit(event, SETTINGS_CATEGORIES.WEB_GLOBAL_SETTINGS, {siteTitle}, [], SITE_TITLE_SUBMIT_KEY)` |
| `src/shared/AdminSettingsNavigation.ts` | `ADMIN_SETTINGS_SECTIONS` 追加 `{icon: "globe", id: "site", nameKey: "settings.site"}` |
| `src/components/admin/settings/AdminSettingsSidebar.tsx` | import `GlobeIcon`；`sectionIcons` 加 `globe: GlobeIcon`（`icon` 是字面量联合类型，两处缺一即 typecheck 红） |
| `src/components/admin/settings/SettingsApp.tsx` | import `SiteSettingsApp`；favicon section 之后加 `<section id="site">` |
| `src/server/feed/FeedPublicJsonBuilder.ts` | `_buildPublicContentMicrofeedExtra()` 里**显式** set / delete `siteTitle`（见下） |
| `src/components/admin/channel/EditChannelApp/index.tsx` | 删掉上一轮加的「站点」卡，文件回到 HEAD 状态 |
| `src/shared/i18n/{en,zh-CN}.ts` | 删 `channel.siteTitleSection/Intro/siteTitle/siteTitlePlaceholder`；加 `settings.site/siteTitle/siteTitlePlaceholder/siteIntro` |
| `src/shared/themes/ThemeContract.ts` | `siteTitle` / `site_title` 的 `.meta({description})` 由「Channel > Site title」改为「Settings > Site」（描述会进生成物 `theme-context.schema.json`，是给主题作者的文档） |
| `themes/feed-zh/web-body-start.mustache` | 只改注释（`Channel > Site title` → `Settings > Site`），标记仍无变化 |

**仍然没有新增 DB 列**：`settings` 也是 JSON，`webGlobalSettings` 本来就是 `.loose()` 口袋
（favicon / itemsPerPage / publicBucketUrl 都住这里），`siteTitle` 沿用同一约定。

⚠️ **显式 set / delete，而不是「有条件赋值」**：`_buildPublicContentMicrofeedExtra()` 开头
就 `...channelMicrofeed` 了，所以如果只在 settings 有值时赋值，那么一旦 Admin 把字段清空，
`channel._microfeed.siteTitle` 这个**遗留口袋值就会通过 spread 复活**，页眉又变回旧文案。
所以改成：

```ts
const settingsSiteTitle = this.webGlobalSettings.siteTitle;
if (typeof settingsSiteTitle === 'string') {
  (microfeedExtra as any)['siteTitle'] = settingsSiteTitle;
} else {
  delete (microfeedExtra as any)['siteTitle'];
}
```

空串走第一条分支 → `themeContext` 裁空白后回退频道标题；settings 里根本没有这个键 →
走 `delete` → 旧口袋被物理摘掉。两条路都不会复活。

### 数据迁移

`channels.data._microfeed.siteTitle`（上一轮写入的 `星河剑歌`）**摘除**，
同时写入 `settings.webGlobalSettings.siteTitle = '星河剑歌'`。两边都做，不留半截状态。

### 验收

**代码层**（`tests/unit/theme-site-title.test.ts`，13 例）：保留上一轮的 5 例上下文解析，
链路部分改为锁 settings 源 —— settings 有值 → 下发；空串 → 原样下发交给 `themeContext` 回退；
未配置 → **不下发**该键；旧 `channel._microfeed.siteTitle` 被 settings 压制；
**清空设置项后旧口袋不得复活**；`channel._microfeed` 的其他键（`serialStatus`）不受影响；
最后两例仍用**真实 `web-body-start.mustache`** 渲染，logo 出站点标题且不含频道名。

**线上端到端**（读实时渲染，`/?probe=N` 绕边缘缓存）：

| 步骤 | 结果 |
|---|---|
| 迁移后首页实时渲染 logo | `星河剑歌`（第十一轮的探针残留 `星河剑歌2` 出现 **0** 次） |
| `/json/` | `_microfeed.siteTitle = '星河剑歌'`；`serialStatus = 'serializing'` 等键完好 |
| 写设置探针 `星河剑歌·设置探针` | logo 立刻变 `星河剑歌·设置探针` ✅ 设置项确实在驱动页眉 |
| 注入「设置项清空 + 频道旧口袋 = 旧口袋复活测试」 | logo 回退到频道标题 `星河剑歌`，旧值出现 **0** 次 ✅ 旧口袋不会复活 |
| 还原 | `settings = 星河剑歌`、口袋已摘除，logo = `星河剑歌` |

⚠️ 迁移前的真实状态值得记一笔：`settings` 里**没有** `siteTitle`，而频道口袋是 **`星河剑歌2`**
（第十一轮的探针没写回干净），也就是说迁移前线上页眉一直显示 `星河剑歌2`。本轮顺手修掉了。

**构建产物静态核对**：`dist/client/_astro/` 含 `siteTitlePlaceholder`（i18n 与 SettingsApp 两个 chunk），
**不含** `siteTitleSection` 或 `channel.siteTitle`。

**写路径（无登录态下的可证部分）**：`src/pages/[adminPath]/ajax/feed.ts` 把整个 `FeedContent` 交给
`FeedDb.putContent()`，后者对 `settings` 里出现的每个 category 调
`_updateOrAddSettingStatement()` → `JSON.stringify(settings[category])` 原样写入 `settings.data`，
**没有键白名单**（favicon / itemsPerPage 走的就是这条路）。
客户端侧由 `SettingsApp.onSubmit` 做 `{...feed.settings[cat], ...bundle}` 浅合并，
所以只发 `{siteTitle}` 不会抹掉同 category 的其他键 —— 这一点由新增的组件测试锁住。

⚠️ **仍未做的**：真正的「登录管理员点一次保存」端到端。本机没有管理员明文凭证（只有 Worker 密钥），
所以写路径是「服务端代码静态核对 + 组件渲染测试」证明的，不是点击证明的。这是长期缺口，见文末未处理项。

**全站 10 端点回归**全 200：`/` 92032、`/json/` 17457、`/rss/` 9854、`/book/J1jGJjUWeCz/` 91150、
`/category/伤寒/` 86014、`/category/本草/` 85999、`/search/?q=%E4%BC%A4%E5%AF%92` 86365、
`/.well-known/microfeed.json` 183、`/robots.txt` 68、`/sitemap.xml` 5043。

⛔ 小坑：curl 里中文 query 不百分号编码会吃 **400**（0 字节），别误判成站点回归。

### 版本收敛

`0.1.33` install + activate；线上 `local.feed-zh` 非删除版本收敛为
`0.1.33`（active）+ `0.1.32`（回滚点）。

