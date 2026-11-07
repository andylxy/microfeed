# microfeed 管理后台授权语境

本语境描述管理后台如何用角色、权限与菜单表达用户可执行的管理能力。它只统一领域语言，不规定界面或存储方式。

## Language

**账号**：
能够登录管理后台并被分配一个或多个角色的身份主体。
_Avoid_: 用户角色、登录角色

**角色**：
一组命名的权限集合，可分配给账号。同一账号可以持有多个角色，权限取并集。**授权只认角色。**
_Avoid_: 菜单组、用户角色

**角色分配**：
账号持有哪些角色这件事，只由 `ext_user_roles` 表达，是授权的单一真源。
_Avoid_: 角色归属（旧称，易被读成另一个字段）

**角色镜像**：
`auth_user.role` 上曾存在的派生值：持 `super_admin` 记 `admin`，其余记 `user`，只服务 Better Auth admin 插件。**已废止**（[ADR-0054](docs/novel-cms/adr/0054-drop-auth-admin-plugin.md) 移除插件，`0163` 清空存量；列保留但停写停读）。词条保留作历史沿革，授权从不认它。
_Avoid_: Better Auth 角色（会被读成另一个独立概念）

**权限快照**：
由角色分配与角色授权算出的结果，按账号整体记录：该账号持有哪些权限码、是否属于会员、能否进入后台。鉴权时一次读出，不再逐层展开角色与授权。它随这三者变化重算，本身不是授权来源——权威仍在角色分配与角色授权上，两侧不一致即为缺陷。
_Avoid_: 权限缓存（那是带过期时间的加速层，会自然陈旧）、角色副本（会被读成角色本身）

**权限码**：
可授予角色的最小授权单位，表示对某类资源执行某个动作的能力，写作 `module:resource:action`。
_Avoid_: 菜单权限、页面权限

**菜单分组**：
管理后台用于组织相关页面的导航分类；当前分为内容、审核、站点、集成与账户。
_Avoid_: 权限模块、角色分组

**权限树**：
角色维护时，按终端归属组织权限码的管理视图。它呈现授权结构，但不取代权限码本身。
_Avoid_: 菜单树、权限模块树

**分组树**：
管理后台页面左栏的分组导航形态：顶部一行不参与过滤的总览根，下面若干分组行——展开一个分组就列出它的成员行，分组徽章始终显示全量数、不随搜索变。分组怎么划、成员怎么过滤由各页面自己的数据决定；控件只统一展开与选中的交互。
_Avoid_: 权限树（角色维护的授权视图，另一回事）、侧栏（指整站导航，不是页内左栏）、树形控件（太泛，指不出这个两层形态）

**级联选择**：
在权限树中通过父节点批量选择或取消其后代权限码的编辑动作。
_Avoid_: 权限继承、自动授权

**半选**：
父节点的一部分后代权限码已选中时的状态；它描述选择情况，本身不是可授予权限。
_Avoid_: 部分权限码

**通配权限**：
代表全部管理能力的特殊权限，只属于超级管理员角色，不能授予普通角色。判定时它直接短路放行，不展开、也不与目录里的权限码逐条对应。
_Avoid_: 全选、根权限

**账号闸门**：
先于权限判定生效的账号级准入条件——未登录、封禁、设备吊销、待改密。它与授权正交：持有通配权限也不能绕过。
_Avoid_: 权限检查、角色校验

**权限判定**：
给定一个权限集合与一个权限码，判断是否放行的规则：集合含该权限码，或含通配权限，即放行。它只看权限集合，不看账号状态。
_Avoid_: 鉴权（易与账号闸门混淆）

**入口门码**：
页面节点绑定的至多一个权限码，决定该入口在侧栏对谁可见。它只决定「看不看得到」，不授予任何能力。
_Avoid_: 菜单权限、菜单可见性码（旧称，易与权限码混淆）

**侧栏数据源**：
侧栏行集来自 `ext_permission_nodes`（ADR-0041 / 0042 D6），不是 `ext_menu`；`ext_menu` 是历史兼容表（0041 起菜单变数据，0127 权限树自持（ADR-0038）、0133 侧栏改读节点（ADR-0041 / 0042），`ext_menu_permissions` 0164 物理删除）。新增/改守卫码的**发现入口**是 `src/shared/AdminPageGuards.ts` 的 `ADMIN_PAGE_GUARDS` 静态目录。
_Avoid_: 菜单表、`ext_menu`（读成现行侧栏来源）、页面守卫码（那是页面的运行时权威，不是侧栏可见性）

**权限树宿主**：
角色编辑器里承接某个页面节点的那组可分配权限码。一个页面节点可承接多个码；它只组织界面，与可见性无关。
_Avoid_: 页面权限、菜单权限

**节点种子单向性**：
`ext_permission_nodes` 的行由迁移播种，但迁移只是**初始种子**：后台「角色管理」页改的是数据库行，已部署实例以数据库为准立即生效，迁移文件不跟着变。后果是全新安装的实例跑完迁移只拿到种子结构，没有后台改过的东西——这是接受的固有形态（管理后台跑在 Worker 内，Worker 无法写 git 仓库，反向生成迁移在生产物理不可行）。回写通道是权限树的「导出 SQL」按钮：把当前节点表状态导成一份 `NNNN_data_*.sql` 交用户自行提交。页面行的 `path` 与 `entry_code` 开放编辑，「入口门码非空 ⇒ 路径非空」由触发器兜底，「菜单可见 ⇔ 页面可达」由 `admin-page-guards` 与 `admin-menu` 两条对齐测试守住，都不会被后台操作打破。
_Avoid_: 节点配置持久化（迁移不承担这个职责）、双写（不存在反向通道）

## 授权控制台（PC 端 / App 端）

**PC 端管理**：
管理后台里管内容、系统、媒体等后台页面权限的控制台；面向运营与管理员。
_Avoid_: 前台、Web 端、桌面端（易与响应式「桌面层」混淆）

**App 端管理**：
管理后台里管移动 App 能力权限与 App 接口清单的控制台。
_Avoid_: 手机端、移动端（易与响应式「移动层」混淆）

**终端归属**：
一个权限码或权限节点归属的控制台，取 `desktop`（PC 端）或 `app`（App 端）。它决定该码在哪个控制台可见、可授，是两端互不可见的依据。
_Avoid_: 平台、端类型

**App 接口清单**：
App 端管理里把 App 对外接口（含匿名接口）按路径、鉴权级与门码集中列出的只读视图。
_Avoid_: API 文档、接口权限表

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

**登录方式**：
App 用户完成身份认证的途径（账号密码 / 短信 / 微信 / QQ），由后台「登录管理」页逐一开关（[ADR-0050](docs/novel-cms/adr/0050-app-login-methods-config.md)，其修订节记录 QQ 已于 2026-10-30 接通）。
_Avoid_: 与正交的「账号闸门」（后台账号封禁 / 设备吊销）混淆

**第三方绑定**：
一个 openid 与一个账号的关联关系，由 `auth_account` 按 `providerId` 分流表达（QQ 为 `providerId='qq'` 行，见 [ADR-0055](docs/novel-cms/adr/0055-unify-third-party-binding-into-auth-account.md)）。一个 openid 只绑一个账号，一个账号可绑多个提供方；它不是登录凭据——凭据走登录凭证。
_Avoid_: openid 表、OAuth 绑定表（旧 `ext_user_oauth` 已退役）、第三方登录凭据

**前端入口显隐 / 后端受理**：
一个登录方式的两个独立可控面：显隐 = App 登录页是否渲染该入口（`getLoginMethods` 响应）；受理 = `appLogin` 是否接受该方式的提交（硬门，关时返回「该登录方式已停用」）。两者同源一份配置，各自独立生效。
_Avoid_: 把显隐当安全边界——受理判定才是硬门

**登录管理配置**：
驱动上述开关的单一全局配置：`settings` 表 category=`app_login_methods` 的单行 JSON，经 `caches.default` 2h read-through 供读、保存路径本地清缓存（跨机房生效窗口 ≤2h，已接受）。
_Avoid_: 登录设置（与 better-auth 自身配置混淆）

**会员角色**：
带 `is_member` 标记的角色（`ext_roles.is_member`，迁移 0144）。账号持任一会员角色即视为会员；它只决定 App 端内容档，不授予任何后台权限。
_Avoid_: 用户状态、是否会员用户、会员账号

**会员书**：
状态为「会员」（书籍状态字典 code 10）的书。只对会员档请求收录与放行，不进公开站。
_Avoid_: 会员内容、VIP 书

**会员档**：
单次 App 请求按「账号是否持会员角色」分出的档位（`member` / `public`），鉴权时由一趟查询算出（`locals.appMember`，与权限码同查）。GetNav 的收录范围、会员书的访问门、以及章节附注 / 视频讲解的下发都按它分流（[ADR-0044](docs/novel-cms/adr/0044-app-member-tier.md)）。
_Avoid_: 会员等级、用户档位

**视频讲解**：
条目的视频讲解地址，存 `_microfeed.videoMemo`（wire 字段名 `sectionvideo`）。与「附注」并列的会员权益字段，只对会员档经 App 章节接口下发。
_Avoid_: sectionvideo（wire 字段名，不是术语）、解说视频

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
条文正文之外的补充说明文字，存 `_microfeed.note`（源字段 `BookBody.SectionNote`）。内容形态是纯文本：`\n` 分段，可原样携带 `$<code>{}` 标注标记。只有 App 章节接口输出它（且只对会员档，公开档置空，见「会员档」与 [ADR-0044](docs/novel-cms/adr/0044-app-member-tier.md)），公开阅读页不渲染。它不参与条文签名（`signature = md5(text)`），所以修改附注不会让移动端把该条文判为过期。
_Avoid_: 注释、笔记、解说（「解说」在样式目录里是标记码 `n` 的显示名，指行内标记）；与「标注标记」是两回事

**扁平条目**：
没有篇章层的 TCM 书（中药 / 名词）里的条目（`tcm_kind` 为 `yao` / `term`），直接按 `items.book_id` 归属。这类书**没有卷页**，书页保持平铺目录；它们各有一行根篇章，`tcm_parent_id` 为空、`title` 就是书名，条目挂在它下面——所以后台卷看板把它们列成一卷，逐卷计数与写入守卫都要把 `yao` / `term` 算进所属卷，只认 `section` 会把整批条目漏在写入口之外。
_Avoid_: 无卷书、平铺书（都指同一件事，但「扁平条目」强调条目本身没有父层）

**未归类桶**：
分组键不指向本书任何一行篇章的那些条文（`tcm_parent_id` 为空、指向别的书、或指向已不存在的行），在看板上作为一个卷行展示、恒排最后，卷名是空串、键是 `UNFILED_VOLUME_KEY`（`"unfiled"`）。挂在**被软删的篇章**下的条文不算未归类：那条篇章查询刻意不带 `status` 条件，被删篇章的 id 仍是合法分组键。未归类只数 `section`——方剂（`fang`）带着本书的 `book_id` 却没有父项，属于独立的方剂目录，混进来会凭空造出一个几百条的桶。小说类书里未归类就是 `_microfeed.volume` 为空的那些章。见 [ADR-0027](docs/novel-cms/adr/0027-admin-volume-board-on-demand-reads.md)。
_Avoid_: 孤儿条文（读不出「还没归档」这层意思）、散章

**题材分类**：
前台站点组织书的一级分类，读者在头部导航点它进入分类页、看该分类下的书。它的真源是书本分组的 `key`（见「书本分组」），分类页地址 `/category/<key>/` 里的段就是这个 `key`。它与后台 `/admin/categories/` 管的旧「分类」不是同一套数据。
_Avoid_: 分类（泛指时会和旧 `ext_category` 混淆）、书籍分类（那是后台 `case_division` 字段名）

**书本信息**：
一本书在前台的完整描述：书名、作者、封面、成书时间、题材分类归属、编号等。真源是 `book_info` 表一行。它与 `channels` 行是两个概念——`channels` 是旧 novel-cms 的书，`book_info` 是前台站点现在读的书；两者靠相同的主键值对应，但前台只认 `book_info`。
_Avoid_: 书（泛指时不分 `channels`/`book_info`）、频道、channel

**书本分组**：
书的归类清单，存一份可编辑的 `key`/显示名/顺序列表（真源 `settings.book_groups`）。`key` 是稳定 slug、书靠它归属题材分类；改名只动显示名、不动 `key`，所以书的归属不会因改名而断。清单由 `/admin/book-info/` 维护，前台只读。
_Avoid_: 分组（泛指时会和别的分组混淆）、分类清单

**独立内容引擎**：
前台站点渲染「站点外壳 → 题材分类 → 书 → 卷 → 正文 → 标注引用 → 中药/名词条目」所依赖的那套数据真源：书本分组 + 书本信息 + 卷章 + 正文 + 方剂/中药引用目标 + 中药/名词条目 + 站点配置，各自落在独立模块的表与 `settings` 里。前台站点只读这套，不再读旧 novel-cms 的 `channels`/`items`，也不再用 `publicFeed` 与 mustache 主题渲染。见 [ADR-0066](docs/novel-cms/adr/0066-front-site-standalone-module-engine.md)。
_Avoid_: 内容引擎（泛指时不分新旧）、前台数据源

**站点外壳**：
前台每页共用的部分：站名/描述/语言/图标/版权/导航固定页 + 头部、页脚、主题切换脚本 + CSS。旧实现里它由 `loadPublishedFeed` 把主频道 `channels` 行与 `items` 窗口组装成 `publicFeed`、再交给 mustache 主题渲染；切换后它由 `catalog/site.ts` 只读 `settings`（`webGlobalSettings` 的站名/图标/描述/语言/版权/出版方 + `access`）+ `pages` 表取导航固定页，外观由 `FrontLayout` 与 `components/front/*` 加 `front-site.css` 承担。其中描述/语言/版权/出版方四个键原本只存在于主频道，由一条 `data` 迁移复制进 `settings`（裁决 ③），因此站壳既不读 `channels` 也不改显示，代价是这四个键暂无后台编辑入口。主题系统仍在，但只作用于后台预览，不影响前台。
_Avoid_: 公共布局（会和 `PublicLayout` 混淆）、主题（那只管外观，不含站点配置与导航）

**零耦合不变式**：
前台**对外输出**（首页、分类页、书页、卷页、三条条目页，含站点外壳与 `sitemap.xml`）的硬判据：任何一条 SQL 不得出现 `items`、`channels`、`ext_category`、`ext_book_stats`、`ext_book_status`；源码不得出现 `loadPublishedFeed`、`loadFeed`、`getPublicJsonData`、`publicFeed`、`new Theme`、`themeContext`、`renderThemeTemplate`。取数只允许 `settings`（`book_groups`/`webGlobalSettings`/`access`）+ `book_info` + `book_chapter` + `book_chapter_body` + `fang_yao`(+`fang_yao_body`) + `zhong_yao` + `ming_ci` + `pages`（导航固定页），以及唯一被允许的 `ext_annotation_markers`（标记语法字典）。站点外壳不豁免——`publicFeed` 本身就是旧真源的组装结果。`sitemap.xml` 同属此列（改由新模块生成）；`rss`/`json`/`llms*` 与 `[...path].astro` 直接下线。**两处例外**：中间件 `loadFeed` 的注入本次不动，前台每请求仍读一次 `channels`；`robots.txt` 仍经 `publicSiteFileResponse` 走一次 `loadPublishedFeed`。这两条都不写成「零读」。
_Avoid_: 解耦（泛指）、无耦合（不指明范围时无意义）

**反向引用索引**：
「哪些条文引用了这个方剂/中药」的物化表 `ext_marker_citations`。由旧前台在卷页渲染时整本扫 `items` 写入，`section_id` 是 `items.id`、`section_seq` 是 items 的 rowid、`book_id` 是 `channels.id`。切换后前台不再读也不再写，表与数据原地冻结，后台方剂编辑器的反向引用视图继续读它。条目浮层里对应的「引用此方剂 / 引用此中药的条文」一段随之取消——换新表要动 schema 与后台写入链，越出「只改前端主题」。
_Avoid_: 引用索引（不说正/反向时含糊）、citation 表（英文混写，书面统一用「反向引用索引」）

**前台可见口径**：
前台判断一行「读者能不能看到」的唯一条件：`deleted_at IS NULL`。独立模块表上的 `is_enable` 不参与这个判断——它在 `book_chapter_body` 上是本草条目标记（930 行）、在 `book_chapter` 上是来源卷状态（102 卷为 0）、在 `fang_yao` 上是方剂组成状态（438 行为 0）。按 `is_enable=1` 过滤会丢 88.5% 正文、22.9% 卷、46.9% 的方剂引用。同样不引入旧链路的 `channels.status` / `ext_book_status`（会员、隐藏等语义），也不把 `book_info.hot_book` 当判据（当前 10 本真实书全是「隐藏」，按它判会让前台空站）。见 [数据完整性核准报告](docs/front-site-catalog-switch-data-audit.md)。
_Avoid_: 启用状态（会和 `is_enable` 的字面意思混淆）、发布状态、会员可见

**正文分流**：
同一个「正文」字段在两类书里存的东西不同：本草条目（`bencao_yao_name` 非空，930 行）的 `section_text` 只有条目名，正文在 `section_note`；其余书（7,136 行）的正文就在 `section_text`、`section_note` 是额外讲义。渲染时按 `bencao_yao_name` 分流拼接，才能还原旧站正文且不让讲义内容混进正文。
_Avoid_: 正文（不分列时以为 `section_text` 就是全部正文）

**容器书**：
旧 novel-cms 体系里承载中药、名词条目的两本「假书」（`4KbG9bDqdz3` 中药、`tcmterm0001` 名词），条目靠 `items.book_id` 挂上去。它们在 `book_info` 里两行已于 2026-11-06 软删，前台按 `deleted_at IS NULL` 不再出现；中药 172 条、名词 17 条改为各自单条路由可达（`/zhongyao/<id>/`、`/ming-ci/<id>/`），不再有聚合书页。`CONTAINER_CHANNEL_IDS` 与 `isTcmContainerChannel` 一并退场。
_Avoid_: 空书、占位书（都不点明它承载的是条目而不是内容）

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
公开读路径有两层且互不借力——CDN 边缘缓存（`Cloudflare-CDN-Cache-Control` 控制，覆盖 `isPublicPagePath` 的公开 HTML）与 Worker Cache API（`caches.default`，`cachedAppResponse` 持有，供被中间件强制 `no-store` 的 `/api/*` 用）。`/api/*` 一律不可 CDN 缓存；可 Worker 缓存的前提是返回体与调用者身份无关（`GetAllMingCi` 因按权限裁剪反被排除；身份只到「会员/公开」粒度的端点按 tier 分桶——ADR-0044 的 GetNav/GetBookChapter 与 ADR-0048 的 GetChapterContent/GetBookIdFang 都是这一形态，tier 进键、写路径显式清桶）。Cache API 另有两个坑：`cache.put`/`match` 不支持 `stale-while-revalidate` 与 `stale-if-error`，且 `cache.put` 不兼容 tiered caching。

**写时清理完整性**：
缓存 TTL 能拉多长，取决于写路径是否把每个受影响 URL 都打上 `Cache-Tag` 并 purge——漏清理的实际后果是「编辑后最长陈旧整个 TTL 窗口」。清理点集中在 `FeedDb.putContent` 与 `purgePublicCache` 的调用处；绕过它们直接 `FEED_DB.batch()` 的写入（如卷板的四个处理器）必须自带清理。App 侧章节正文与方剂两桶（ADR-0048 D2）的清理路径有三条合并覆盖：`FeedCrudManager` 写后按 `tcm_kind` 分派、卷板四处理器按书全量清正文桶、书的写函数在状态变更（含软删/物理删）时按书清两桶。中药目录与别名两桶（ADR-0049 D2）由 tcm-entry 的 yao 写、别名板写与 `FeedCrudManager` 的 section 分派清理。

**章节回跳锚点**：
阅读页与目录之间唯一保留的阅读导航，靠一条两侧都要遵守的约定实现：阅读页的 `toc_url` 是 `/book/<bookId>/v/<篇章 id>/#mf-toc-<条 id>`（TCM 书；扁平条目书没有篇章，退回 `/book/<bookId>#mf-toc-<条 id>`），卷页给每个条文设 `id="mf-toc-<条 id>"`。哈希不能只在一侧改——收尾脚本（`web-body-end`）会在目录重建后按 `location.hash` 补一次滚动。约定存在是为了不读整本书的章节列表。见 [ADR-0025](docs/novel-cms/adr/0025-volume-as-reading-unit.md)。

卷页那条 URL 的**尾斜杠要留着**：卷页规范路径是 `/book/{id}/v/{篇章 id}/`，`public-cache.ts` 的 `isBookScopedPath` 用 `/^\/book\/[^/]+\/(?:v\/[^/]+\/)?$/u` 认它。少一个尾斜杠，服务端只回一个 **308** 补斜杠（本地实测：有斜杠 200 `no-cache`，无斜杠 308 `private, no-store`）；重定向本身不可缓存（`isPublicCacheableResponse` 要求 200），于是每次点「返回」多付一个不可缓存的往返。片段会被浏览器带过重定向，锚点不坏；页面本身仍走边缘缓存。

## 限流与一次性台账

**限流**：
对同一调用方在一段时间窗口内的请求次数设上限，超限请求在业务逻辑之前被拒。上限与窗口长度是分类的属性，不由调用方各自另写一份。
_Avoid_: 节流、频率控制、频控

**窗口**：
限流的计数周期。窗口结束后计数从头起算，不依赖清理任务。
_Avoid_: 周期、时间片

**配额**：
窗口更长、上限更大的一种限流（App 内容端点是 24 小时 / 10,000 次 / 每把登录凭证），用尽后整窗拒绝。
_Avoid_: 额度、流量包

**一次性台账**：
记录「某个一次性凭据已经被用过」的行，不计数、没有窗口重置，只在保留期内判重。防重放 nonce 与图形验证码的记账属于这一类，不属于限流。
_Avoid_: nonce 表、防重放表

**分类**：
限流与台账行的分类标识，决定该行按哪个窗口计数、或按哪个保留期判重。分类是结构的一部分，不是键名里的字符串前缀。
_Avoid_: 类型、命名空间

## 前台主题轨道

前台站点（`front-site.css`）的颜色由一组语义令牌（`--mf-*`）驱动，但存在**两条独立的明暗轨道**，改色前必须分清一条颜色归哪条轨道管。

**语义令牌轨道**：
`front-site.css` 顶部 `:root` 与 `.dark` 定义的 `--mf-background/surface/text/muted/border/accent/brand/novel` 等语义色令牌。全站组件只准吃令牌，不准硬编码色值——这是「各页深浅一致」的前提。绕过令牌的硬编码色（旧 `.fq-*` 顶栏、旧阅读页 sepia、一次性散值）是本次要消除的「乱搭」根源。
_Avoid_: CSS 变量（泛指，不含「语义色」这层约束）、design token（英文混写）

**全站明暗轨道**：
首页/分类页/书页/卷页共用的白天↔墨夜切换。由 `<html class="dark">` 驱动 `.dark` 令牌块，偏好存 `microfeed-public-theme`（`system/light/dark` 三态，跟随系统/浅色/深色下拉）。它管不到阅读页——阅读页自成一条轨道（见「阅读页主题岛」）。
_Avoid_: 全局主题（易被读成连阅读页一起管）、站点主题

**阅读页主题岛**：
阅读/条目页自成的一套配色，与全站明暗轨道解耦。进阅读页由 JS 在 `<html>` 上设 `data-mf-reader-theme=day|night|warm`，CSS 在 `html[data-mf-reader-theme=X]` 重定义那批语义令牌，整页（含全站顶栏 `.fq-header`，因顶栏在 `.mf-reader-page` 之外、靠根层令牌继承换装）一起切换；出阅读页移除属性即回落全站轨道。属性选择器 (0,1,1) 高于 `.dark` (0,1,0)，故阅读页白天态能盖过全站墨夜。
_Avoid_: 阅读主题（未点明「岛」的解耦边界）、sepia 模式（旧称，现在是三态之一）

**阅读页三态**：
阅读页主题岛取的三个值——`day`（白天，与全站浅色同值）、`night`（墨夜，与全站深色同值）、`warm`（暖色/羊皮纸，阅读页独有的第三态）。三态各自是**一整组配套色**（底色+字色+muted+边框+accent+brand/novel），切态时整组一起换；每组字色都按对应底色校过 WCAG 对比度（正文 ≥10:1、muted ≥4.5:1、accent/brand/novel ≥4:1），不会出现暖纸配冷白字这类错配。
_Avoid_: 背景（旧「米黄」纸色开关的叫法，已被三态取代）、配色方案

**首次跟随全局**：
阅读页主题岛的默认取值规则：读者手动选过则用其独立存储键 `microfeed-reader-theme`，从未选过则跟随全站偏好（`microfeed-public-theme` 为 `dark` ⇒ 起步 `night`，否则 `day`）。让阅读页第一次到访就贴合读者已有的明暗习惯，又不反向牵动全站轨道。
_Avoid_: 同步主题（易读成双向绑定，实为单向初值）

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
