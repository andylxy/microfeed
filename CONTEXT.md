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

**反向白名单**：
App 命名空间的安全模型（实为 fail-open）：「未登记进集成清单即视为匿名」。名称「反向」仅指登记方向与常规白名单相反；其风险是新增敏感端点若漏登记会静默公开，以回归测试约束，不翻转为 fail-closed。
_Avoid_: 白名单（方向相反）

## 数据层（D1）

**全表扫描**：
查询无法用索引定位行、必须读整表（或整个索引）再逐行判断。在 D1 上表现为读放大与延迟，是本语境要消除的主要缺陷。

**派生真实列**：
把 `data` JSON 里被高频过滤或排序的字段提升为表上的真实列并建索引（如 `items.book_id`、`items.tcm_parent_id`），使查询走索引，不必在 SQL 里算 `json_extract` 表达式。
_Avoid_: 冗余列（它服务于查询，不是冗余）

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
