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
