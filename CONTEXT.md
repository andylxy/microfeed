# microfeed 管理后台授权语境

本语境描述管理后台如何用角色、权限与菜单表达用户可执行的管理能力。它只统一领域语言，不规定界面或存储方式。

## Language

**账号**：
能够登录管理后台并被分配一个或多个角色的身份主体。
_Avoid_: 用户角色、登录角色

**角色**：
一组命名的权限集合，可分配给账号。同一账号可以持有多个角色。**授权只认角色。**
_Avoid_: 菜单组、Better Auth role

**Better Auth 角色**：
`auth_user.role` 上的字符串（`admin` / `user`），由 Better Auth 自己维护，**不参与授权**。
_Avoid_: 角色（两者不是一回事）

**权限码**：
可授予角色的最小授权单位，表示对某类资源执行某个动作的能力。
_Avoid_: 菜单权限、页面权限

**菜单分组**：
管理后台用于组织相关页面的导航分类；当前分为内容、审核、站点、集成与账户。
_Avoid_: 权限模块、角色分组

**权限树**：
角色维护时，按照当前菜单分组组织权限码的管理视图。它呈现授权结构，但不取代权限码本身。
_Avoid_: 菜单树、权限模块树

**级联选择**：
在权限树中通过父节点批量选择或取消其后代权限码的编辑动作。
_Avoid_: 权限继承、自动授权

**半选**：
父节点的一部分后代权限码已选中时的状态；它描述选择情况，本身不是可授予权限。
_Avoid_: 部分权限码

**通配权限**：
代表全部管理能力的特殊权限，只属于超级管理员角色，不能授予普通角色。
_Avoid_: 全选、根权限

**账号闸门**：
先于权限判定生效的账号级准入条件——未登录、封禁、设备吊销、待改密。它与授权正交：持有通配权限也不能绕过。
_Avoid_: 权限检查、角色校验

**权限判定**：
给定一个权限集合与一个权限码，判断是否放行的规则：集合含该权限码，或含通配权限，即放行。它只看权限集合，不看账号状态。
_Avoid_: 鉴权（易与账号闸门混淆）

**菜单可见性码**：
菜单页绑定的至多一个权限码，决定该入口对谁可见。它只决定「看不看得到」，不授予任何能力。
_Avoid_: 菜单权限（易与权限码混淆）

**权限树宿主**：
角色编辑器里承接某个菜单页的那组可分配权限码。一个菜单页可承接多个码；它只组织界面，与可见性无关。
_Avoid_: 页面权限、菜单权限

## App 移动端通道

**移动端登录凭证（mflc_）**：
复用 better-auth 校验口令后签发的、绑定该用户的登录凭证（区别于设备级密钥与 OAuth API Key）。App 带其作为 Bearer，服务端经 `credential-bearer` → 用户 → 角色 → `app:mobile:access` 授权。
_Avoid_: 设备密钥、AccessKey、content:read API Key（旧后端体系，本仓未移植）

**App 内容端点（集成路径）**：
`/api/AppBookRequest/*` 中需登录的 8 个内容接口（GetNav / GetBookChapter / GetChapterContent / GetBookIdFang / GetAllZhongYao / GetAliaZhongYao / GetAllMingCi / GetTipsStyleConfig），由 `APP_BOOK_REQUEST_CONTENT_SUFFIXES` 登记，匿名不可达。
_Avoid_: 私有端点

**App pre-auth 端点（匿名）**：
`/api/AppBookRequest/*` 中无需登录的接口（login / replaceToken / getPicCaptcha / GetProjectInfo / GetLoginInfo / getAboutInfo），刻意匿名，等同旧后端行为。
_Avoid_: 公开端点（易与站点公开资源混淆）

**App 能力端点（`/api/app/*`）**：
App 自身的四个非内容端点 —— `version`（升级描述符）、`announcements`（运营公告）、`search-permission`、`mingci-permission`。**四个都要登录凭证**，各按一个 App 能力权限码判定：`app:version:read` / `app:announcement:read` / `app:search:global`+`app:search:book` / `app:mingci:view`；在 middleware 里登记为 `integration`，因此同样受限流、账号封禁、设备吊销与访问日志约束。
注意它们**不属于** `/api/AppBookRequest/*`（那套走三张登记表），也不走 `{code,data,msg}` 信封。
_Avoid_: 「App 匿名端点」—— version 与 announcements 在 2026-10-16 之前确实匿名，现在不是；也不存在「没有凭证的客户端」（全新安装的 App 带 `SecurityConfig.getApiKey()` 内置凭证）。

**反向白名单**：
App 命名空间的安全模型（实为 fail-open）：「未登记进集成清单即视为匿名」。名称「反向」仅指登记方向与常规白名单相反；其风险是新增敏感端点若漏登记会静默公开，以回归测试约束，不翻转为 fail-closed。
_Avoid_: 白名单（方向相反）

## 标注标记（行内语义）

**标注标记**：
中医正文里的行内语义外壳，写法 `$<code>{内容}`（如 `$f{桂枝汤}`），`<code>` 为 1–10 个字母。
目录存在 `ext_annotation_markers`，由后台 `/admin/annotation-markers/` 维护；**码不可改** —— 它已经烘进正文。
_Avoid_: 富文本标签、注释（本仓的「修改留痕 / 审计留痕」是另一套东西）

**linkType**：
标记的链接语义，样式目录里的一列：`0` = 无链接（纯样式）、`1` = 中药、`2` = 方剂、`3` = 名词。
**两端口径不同**（[ADR-0028](docs/novel-cms/adr/0028-annotation-marker-parity-and-app-config-chain.md)）：
web 公开页只对 `1`/`2` 生成链接与弹层，`3` 只上色不链接；App 端则 `linkType ≠ 0` 一律可点击，`3` 打开名词弹窗。
_Avoid_: 类型、kind —— `fang` / `yao` 是引用表按 linkType 归并后的分桶名，不是 linkType 本身

**样式目录**：
`ext_annotation_markers` 这张表本身：每个码的颜色 / 是否缩小 / 缩小比例 / linkType。
web 渲染器与 App 都**按码**查它。`title` 只是后台表格与编辑器按钮的显示名，**不参与渲染**。
_Avoid_: 配置、主题（主题是另一套，见「书的结构」之外的 theme 体系）

**引用表**：
`ext_marker_citations`（迁移 0111）—— 物化的「哪些条文引用了某个方剂 / 中药」反向索引，
按 `(book_id, marker_code, marker_name, section_id)` 存。`marker_code` 是**按 linkType 归并后的分桶**（`f` / `u`），
不是原始码 —— 所以第二个中药类的码会和 `$u` 共用同一个桶。
_Avoid_: 索引（易与 D1 的索引混淆）

**样式目录版本号**：
`ext_annotation_markers` 的 `MAX(updated_at_ms)`，即「目录最后一次被**新增或编辑**的时间」，随 `GetTipsStyleConfig` 下发；
App 把它连同本地缓存一起落盘，用来判断手里的配置是否最新。
**注意**：请求参数里那个 `version` **不是**它 —— 那是 App 本地的自增计数器，服务端既不读也不回。
**也注意**：**删除**一个标记不会推高这个版本号（`DELETE` 不碰任何行的 `updated_at_ms`）⇒ 删除在 App 端不可见，只有新增/编辑才会触发客户端刷新。
_Avoid_: 配置版本、configVersion（App 内部那个计数器叫这个名字，是个不同且无意义的数）

## 书的结构（典籍与小说）

**卷**：
一本书的阅读单位。本仓库有两种来源，**必须分清**：TCM 典籍里卷是数据库里的一行（见「篇章」）；小说类书里卷只是每章 `_microfeed.volume` 上的一个字符串标签，没有独立实体。自 [ADR-0025](docs/novel-cms/adr/0025-volume-as-reading-unit.md) 起卷还是一级阅读单位，有自己的 URL（`/book/<bookId>/v/<篇章 id>/`）。
_Avoid_: 分卷、册、目录章节（都不是本语境的单位）

**卷键**：
一个卷在接口上被指认的方式，两种书共用同一个 `key` 字段，所以前端不需要分辨书的种类：TCM 典籍是那行篇章的 11 字符 id，小说类书是 `_microfeed.volume` 里的卷名本身。卷改名不断链靠的是「卷键 = 篇章 id」这一条；小说类书没有篇章行，卷名就是它唯一的键，所以改卷名会让带着旧卷名的地址查不到卷（看板按「这本书没有这一卷」处理）。见 [ADR-0027](docs/novel-cms/adr/0027-admin-volume-board-on-demand-reads.md)。
_Avoid_: 卷 id（小说类书没有 id）、卷序号（序号会随中间插入新卷指错卷）

**卷看板**：
后台按书整理卷与条目的那一页（`/[adminPath]/volumes/`）：选书 → 列这本书的卷 → 展开一卷读它的条目。它的展开态（书 + 卷键）存在地址里，所以刷新、后退、把链接发给同事都回到同一卷；条目编辑页的返回目标也由它报出（[ADR-0036](docs/novel-cms/adr/0036-admin-editor-return-target.md)）。读取口径见 [ADR-0027](docs/novel-cms/adr/0027-admin-volume-board-on-demand-reads.md)。
_Avoid_: 目录（读者侧的「目录」指书页目录，是另一件事）、章节管理（页面名是「卷章管理」）

**篇章**：
TCM 典籍里承载卷的那一行 `items`（`tcm_kind = 'chapter'`）。它是实体、有 11 字符 id，卷名就是它的 `title`；条文靠 `tcm_parent_id` 挂在它下面。
_Avoid_: 卷（在 TCM 书里二者同指，但「篇章」强调的是数据库里的那一行）

**条文**：
TCM 典籍里的最小阅读单位（`tcm_kind = 'section'`）。它才是 `$f{方剂}` / `$u{中药}` 标注标记的宿主，也是阅读页 `/i/<slug>` 的粒度。
_Avoid_: 章节、小节、条目

**附注**：
条文正文之外的补充说明文字，存 `_microfeed.note`（源字段 `BookBody.SectionNote`）。内容形态是纯文本：`\n` 分段，可原样携带 `$<code>{}` 标注标记。只有 App 章节接口输出它，公开阅读页不渲染。它不参与条文签名（`signature = md5(text)`），所以修改附注不会让移动端把该条文判为过期。
_Avoid_: 注释、笔记、解说（「解说」在样式目录里是标记码 `n` 的显示名，指行内标记）；与「标注标记」是两回事

**扁平条目**：
没有篇章层的 TCM 书（中药 / 名词）里的条目（`tcm_kind` 为 `yao` / `term`），直接按 `items.book_id` 归属。这类书**没有卷页**，书页保持平铺目录；它们各有一行根篇章，`tcm_parent_id` 为空、`title` 就是书名，条目挂在它下面——所以后台卷看板把它们列成一卷，逐卷计数与写入守卫都要把 `yao` / `term` 算进所属卷，只认 `section` 会把整批条目漏在写入口之外。
_Avoid_: 无卷书、平铺书（都指同一件事，但「扁平条目」强调条目本身没有父层）

**未归类桶**：
分组键不指向本书任何一行篇章的那些条文（`tcm_parent_id` 为空、指向别的书、或指向已不存在的行），在看板上作为一个卷行展示、恒排最后，卷名是空串、键是 `UNFILED_VOLUME_KEY`（`"unfiled"`）。挂在**被软删的篇章**下的条文不算未归类：那条篇章查询刻意不带 `status` 条件，被删篇章的 id 仍是合法分组键。未归类只数 `section`——方剂（`fang`）带着本书的 `book_id` 却没有父项，属于独立的方剂目录，混进来会凭空造出一个几百条的桶。小说类书里未归类就是 `_microfeed.volume` 为空的那些章。见 [ADR-0027](docs/novel-cms/adr/0027-admin-volume-board-on-demand-reads.md)。
_Avoid_: 孤儿条文（读不出「还没归档」这层意思）、散章

## 数据层（D1）

**全表扫描**：
查询无法用索引定位行、必须读整表（或整个索引）再逐行判断。在 D1 上表现为读放大与延迟，是本语境要消除的主要缺陷。2026-10-12 全量审计确认 `items` 上已不存在（见 [ADR-0024](docs/novel-cms/adr/0024-d1-read-cost-baseline-no-full-scans.md)）。

**整本读取**：
一次页面加载读取某本书的全部条目——阅读页标注层、以及引用表**脏标记后的那一次懒自举重算**都如此（书页目录自 [ADR-0025](docs/novel-cms/adr/0025-volume-as-reading-unit.md) 起不再如此，后台卷看板自 [ADR-0027](docs/novel-cms/adr/0027-admin-volume-board-on-demand-reads.md) 起不再如此，都改为按需读取）。它的上界由**书的大小**决定，与表大小无关；是全表扫描被消除后剩余的主要读代价来源，靠边缘缓存兜底。判断它贵不贵同样看 `rows_read`（实测素问书页 ≈3,045，整本 2,964 行 / 1,233,002 字节）。小说类书的卷列表仍是整本读取：卷名在 `data` 里，没有可用索引，这条分支不加派生真实列。见 [ADR-0024](docs/novel-cms/adr/0024-d1-read-cost-baseline-no-full-scans.md)。

**按需读取**：
一次请求只读当前要展示的那一段范围——点书读那本书的卷（含逐卷条数，走覆盖索引，不回表读正文），点卷只读那一卷的条目；写操作的归属判定同样按提交的每条 id 各做一次主键点查，而不是读全书攒集合。判据是行读随**所选范围**增长而不是随书的大小增长，客户端切片不产生任何行读，所以按需读取与分页控件没有关系。见 [ADR-0025](docs/novel-cms/adr/0025-volume-as-reading-unit.md)、[ADR-0027](docs/novel-cms/adr/0027-admin-volume-board-on-demand-reads.md)。
_Avoid_: 懒加载（那是前端渲染时机，不指行读）、分页（分页控件既可能省行读也可能一行都不省）

**派生真实列**：
把 `data` JSON 里被高频过滤或排序的字段提升为表上的真实列并建索引（如 `items.book_id`、`items.tcm_parent_id`），使查询走索引，不必在 SQL 里算 `json_extract` 表达式。
_Avoid_: 冗余列（它服务于查询，不是冗余）

**行读（rows_read）**：
D1 的代价与计费计量单位，按查询**步进过的行数**计，**不是返回行数**。判断一次查询贵不贵看它，不看「有没有走索引」——走索引的查询也可能步进整表。
_Avoid_: 扫描行数（易与返回行数混淆）

**步进式分页**：
用 `LIMIT ? OFFSET ?` 取第 N 页。D1 上每页都从头步进 `N × 页大小` 行，总代价随页数**二次方**增长（实测：读 9,506 行的表，20 页累计 104,506 行读 = 11 倍放大）。大型列表禁用。
_Avoid_: OFFSET 分页（同一个东西，但没点出代价）

**keyset 分页**：
用「上一页末行的排序键」作游标取下一页（`WHERE (排序键, id) < (...)`）。公共与大型列表一律用它。
_Avoid_: 游标分页（游标可能指别的东西）

**batch 原子写**：
把多条语句放进一次 `env.FEED_DB.batch(...)`，D1 在单事务内全成或全回滚。它是本项目唯一的原子性原语（无 `BEGIN/COMMIT`）。

**搜索同步触发器**：
`items`/`pages` 写入后自动维护 `site_search_documents` 与两张 FTS5 表的数据库触发器。运行时不重建索引，搜索同步 100% 依赖它——触发器漏建则搜索静默不同步。

**写入放大**：
一次逻辑写入引发多于一次的物理写入（如触发器级联、逐行循环写）。它是本语境里写路径的主要成本来源。

**源序（no）**：
TCM 条目在源书里的原始序号（`_microfeed.no`），是条目 / 方剂在书页目录里的默认排序键。SQL 按 `json_extract(data,'$._microfeed.no'), id` 排序即复刻源书顺序；索引化该表达式可消除排序临时表。

**sourceBookId（源书标识）**：
TCM 条目归属的源书标识（`_microfeed.sourceBookId`），与 `items.book_id` 分属两种成员关系模型：方剂按 `sourceBookId` 过滤（真实书 book_id 或容器 `tcmfang0001`），平铺型中药 / 名词书直接按 `items.book_id` 归属。两者是 TCM 书两种不同的成员关系，对应不同的查询前置谓词。

**未命中上限**：
缓存在给定 TTL 与 POP 数下、单 URL 每日最多回源多少次——等于 `min(当日请求数 R, 86400/TTL × P)`。TTL 短到每个请求都是回源时，缓存等价于没开；判断一个 TTL 配得对不对看它，不看「有没有开缓存」。P 是服务该 URL 的 Cloudflare 数据中心/边缘节点数：CDN 缓存跨站共享但按 POP 各自判新鲜度，`caches.default`（Cache API）则是每数据中心各一份、不复制。见 [ADR-0016](docs/novel-cms/adr/0016-cache-ttl-not-cache-itself.md)。

**分层缓存边界**：
公开读路径有两层且互不借力——CDN 边缘缓存（`Cloudflare-CDN-Cache-Control` 控制，覆盖 `isPublicPagePath` 的公开 HTML）与 Worker Cache API（`caches.default`，`cachedAppResponse` 持有，供被中间件强制 `no-store` 的 `/api/*` 用）。`/api/*` 一律不可 CDN 缓存；可 Worker 缓存的前提是返回体与调用者身份无关（`GetAllMingCi` 因按权限裁剪反被排除）。Cache API 另有两个坑：`cache.put`/`match` 不支持 `stale-while-revalidate` 与 `stale-if-error`，且 `cache.put` 不兼容 tiered caching。

**写时清理完整性**：
缓存 TTL 能拉多长，取决于写路径是否把每个受影响 URL 都打上 `Cache-Tag` 并 purge——漏清理的实际后果是「编辑后最长陈旧整个 TTL 窗口」。清理点集中在 `FeedDb.putContent` 与 `purgePublicCache` 的调用处；绕过它们直接 `FEED_DB.batch()` 的写入（如卷板的四个处理器）必须自带清理。

**章节回跳锚点**：
阅读页与目录之间唯一保留的阅读导航，靠一条两侧都要遵守的约定实现：阅读页的 `toc_url` 是 `/book/<bookId>/v/<篇章 id>/#mf-toc-<条 id>`（TCM 书；扁平条目书没有篇章，退回 `/book/<bookId>#mf-toc-<条 id>`），卷页给每个条文设 `id="mf-toc-<条 id>"`。哈希不能只在一侧改——收尾脚本（`web-body-end`）会在目录重建后按 `location.hash` 补一次滚动。约定存在是为了不读整本书的章节列表。见 [ADR-0025](docs/novel-cms/adr/0025-volume-as-reading-unit.md)。

卷页那条 URL 的**尾斜杠要留着**：卷页规范路径是 `/book/{id}/v/{篇章 id}/`，`public-cache.ts` 的 `isBookScopedPath` 用 `/^\/book\/[^/]+\/(?:v\/[^/]+\/)?$/u` 认它。少一个尾斜杠，服务端只回一个 **308** 补斜杠（本地实测：有斜杠 200 `no-cache`，无斜杠 308 `private, no-store`）；重定向本身不可缓存（`isPublicCacheableResponse` 要求 200），于是每次点「返回」多付一个不可缓存的往返。片段会被浏览器带过重定向，锚点不坏；页面本身仍走边缘缓存。

## 响应式设计

**移动层**：
视口宽度 ≤768px 的页面布局，对应 `--mf-mobile` 断点。导航栏折叠、网格降级、间距收紧。见 [ADR-0013](docs/novel-cms/adr/0013-responsive-breakpoints.md)。
_Avoid_: 移动端、小屏幕、narrow viewport

**桌面层**：
视口宽度 ≥768px 的页面布局，对应 `--mf-desktop` 断点（>1280px 为增强桌面）。网格使用完整列数，间距正常。
_Avoid_: 电脑端、宽屏

**断点碎片化**：
同一主题内多个页面使用不同的 `@media` 断点值（当前 feed-zh 曾有 6 个值），导致布局不连续和决策困难。已由 ADR-0013 收敛为 1 个全局断点（768px）+ 1 个网格专属断点（1024px，仅首页 `.mf-home-grid`）。
_Avoid_: 断点不一致（碎片化更精确，含原因）

**网格专属断点**：
仅用于特定网格布局的断点值（如首页 `.mf-home-grid` 的 `1024px`），不参与全站布局决策。
_Avoid_: 局部断点（专属更精确，指归属关系）

## 管理后台的删除语义

**软删除（delete）**：
把行标记为已删而不物理移除：内容表翻 `status` 到删除态（`STATUSES.DELETED`=3；公告用自有机器的 4），配置表写 `deleted_at`。行仍在表里，从界面过滤掉即「消失」，但继续占用唯一键等约束——themes 的 `UNIQUE(package_id, version)` 因此阻止重装同版本（`errors.theme.versionReusedAfterDeletion`）。
_Avoid_: 删除（未说明硬软时禁用）；归档（UI 文案可用，术语指软删）

**物理删除（purge）**：
真正 `DELETE FROM` 移除行，且必须同时清理派生物：R2 资产（themes，复用 `cleanupAssetOwner` 的引用计数）、子表行（webhooks 的投递尝试/投递/独占事件；`webhook_daily_usage` 与 `webhook_budget_reservations` 是全局预算账本、无 endpoint_id 列，不属端点删除域，purge 不碰）、状态指针（`theme_state` 的 `active_theme_id` / `previous_theme_id`）。不可恢复。唯一合法路径是管理端点里带守卫的 purge；⛔ 禁止裸 SQL `DELETE FROM themes` 绕过（AGENTS.md:262 同此口径）。
_Avoid_: 硬删除、彻底删除（术语统一用物理删除；「永久删除」仅作 UI 文案）

**上一版主题**：
`theme_state.previous_theme_id` 指向的那一行——激活时的回滚点。全局只有一个槽：activate 时写入、rollback 时与激活槽互换、软删/物理删除该行时清空。清理旧版本（AGENTS.md:248 的固定收尾）保留的正是激活行 + 这一行。
_Avoid_: 上一个主题（指代不明时用术语）
