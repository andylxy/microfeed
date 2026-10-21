# ADR-0039: 权限管理分成 PC 端与 App 端两个控制台

- 状态：Accepted
- 日期：2026-10-20
- 决策人：用户 + grill-with-docs 三轮追问拍板 + 两轴 code-review 两轮回灌
- 关联：方案 `.tasks/2026-10-20-rbac-desktop-app-split.md`；迁移 `0128_schema_permission_nodes_audience.sql` / `0129_data_regroup_app_permission_nodes.sql` / `0130_seed_app_capability_console.sql`；上游 ADR-0038（权限树自持）

## 背景

`/admin/rbac/` 今天是一个页两个 tab（角色授权树 + 权限树管理），全部绑 `system:role:manage`。App 侧的能力权限码（`app:mobile:access` / `app:version:read` / `app:announcement:read` / `app:mingci:view` / `app:search:*`）虽然已在授权树里，却分散在 PC 分组（集成、运营、会员功能）的合成页下；6 个匿名接口（login / replaceToken / getPicCaptcha / GetProjectInfo / GetLoginInfo / getAboutInfo）在权限体系里完全无条目；App 接口清单本身没有统一登记处（散在 `access.ts` 三张表、`api-permissions.ts` 的 `DOMAIN_RULES`、各 handler 内部码）。同时 `replaceRolePermissions` 是整份替换（`DELETE FROM ext_role_permissions WHERE role_id = ?` + 逐条 `INSERT`），若只按端分开界面而不改保存口径，一端保存会清掉另一端的授权。

## 决策

### D1｜终端归属记在节点表

`ext_permission_nodes` 加 `audience`（`desktop` | `app`），是分区唯一依据；加索引 `(audience, kind)` 支撑按端读与码→端推导。`ext_permissions` 不加列，某码的归属由它那条 kind='code' 叶子的 audience 推导（0127 每个可授码恰有一条叶子）。代码侧定义共享类型 `PermissionAudience = "desktop" | "app"` 与 `audienceOf()` 单一判定入口，各判定点复用。

### D2｜两个平级控制台，互斥分区

`[adminPath]/rbac/desktop` 与 `[adminPath]/rbac/app` 两个平级子页，各自保留授权树 + 权限树，按 audience 过滤；两端互不可见——app 码只在 App 页出现、可授，desktop 码只在 PC 页。角色共享。`readRbacBoard` 的节点、角色 grants 与扁平 permissions 目录都按 audience 裁剪。

### D3｜守卫码按端分派

新增 `system:app-capability:manage`（audience=desktop，挂「角色与权限」页）；PC 页沿用 `system:role:manage`。默认只 super_admin（`*`）拥有，editor / readonly 不授予。**端点守卫按端分派**：权限树 list / save / export 与角色授权 `role-permissions` 由 `requireAudienceGuard(audience)` 选码（desktop→`system:role:manage`，app→`system:app-capability:manage`）；角色 CRUD 仍只 `system:role:manage`（角色全局，App 页只勾选 app 码、不建改删角色）。

### D4｜授权保存按端作用域

`replaceRolePermissions` 增 audience 参数，服务端校验提交的每个码都属于该端（fail-closed，不一致 400），只替换该端的 `ext_role_permissions`——因该表只有 `role_id` / `permission_id`，裁剪经 `ext_permission_nodes` 子查询（`kind='code' AND audience=?`），不能整表删。另一端原样保留；否则 **editor 与 readonly**（两者共用 `EDITOR_PERMISSIONS`，都持 2 条 app 码）会被 PC 页保存清掉。

### D5｜App 节点归拢到一个 App 根下

把 6 个 app 码从 PC 组的合成页移到新 `group_app` 根下：新建 `page_app_access`（接入）与 `page_app_search`（搜索），复用 `page_app_version_read` / `page_app_announcement_read` / `page_mingci`（改 parent 到 `group_app`）；混合页 `page_api` 保留 `system:api:manage`、`page_unmapped` 的 `media:file:manage` 迁到新 `page_media` 后删除该页，移空的 `group_other` 一并删除。父子同 audience、禁止跨端重挂，作为不变量由纯函数与测试守住。

### D6｜App 接口清单 v1 只读

App 页第三 tab 列出全部 18 个 App 接口（路径 / 方法 / 鉴权级 / 门码 / 是否匿名），来源是现有代码登记表，管理台不写它。在线改鉴权属后续演进，不在本次。

## 备选

| 备选 | 否决理由 |
| --- | --- |
| 不加列、把 app 节点搬到双根，用祖先归属分区 | 靠祖先隐式推断，脆弱、难测试；app 页将来从 PC 组搬走易漏 |
| 宽松分区（desktop 页仍显示 app 码） | 与「分离职责」初衷相悖；super_admin 本就两端可进，便利有限 |
| 接口清单直接上 DB 权威表、中间件按库判定 | 改鉴权热路径与安全姿态，风险与成本高；先用只读登记面拿到单一视图 |
| 保留整份替换、前端 union 后提交 | 违背互斥分区，desktop 管理员会间接看到 app 授权 |

## 后果

- 新增 App 能力码的登记位置从「散在 PC 组合成页」变为「App 端管理」；授权树与权限树按端独立。
- 权限保存多一个 audience 维度；漏传或跨端提交会被 400 拒绝（fail-closed）。
- 6 个匿名接口第一次在后台有可见条目（只读）。
- 读代价：节点表 87 → 约 90 行、< 24KB；按 `(audience, kind)` 索引读，PC 端约 78 行、App 端约 12 行，均 < 20KB 字节读；grants 裁剪为点查。不触大表，无全表扫描。
- **已知边界**：清单 v1 只读；留痕页不按端分；`page_unmapped` 删除、`group_other` 移空删除，`media:file:manage` 迁到 `page_media`。

## 验证口径

- 三镜像：SQL（0130）≡ `src/server/rbac/seed.ts` 的 `RBAC_PERMISSIONS` ≡ `src/shared/Constants.ts` 的 `PERMISSION_CODES`（`admin-endpoint-guards.test.ts` + `rbac.test.ts`）。
- 作用域保存：新增用例断言 PC 保存不清 App 授权、App 保存不清 PC 授权、跨端提交 400。
- 端点守卫：只持 `system:app-capability:manage` 的角色可调 App 页**四端点**（权限树 list/save/export、role-permissions），不能调 PC 专属的角色 CRUD。
- grants 裁剪：`readRbacBoard` 返回的角色 `permissions` 与扁平 `permissions` 目录都不含对端码。
- 清单完整性：18 行（8 内容 + 6 匿名 + 4 `/api/app/*`）。
- 权限树不变量：跨 audience 重挂被拒（扩展 `tests/unit/shared/permission-tree-ops.test.ts`）。
- 页守卫：`admin-page-guards.test.ts` 重放新菜单行与两个页守卫。
- 门禁由用户手动触发 `.microfeed-gate-subset`。

## 修订（2026-10-20，migration 0131：双页合并为单页）

设计评审否决了「两个平级控制台」的呈现层形态：**呈现改成一个页面内的两个分类**。D1（audience 分区）、D3（按端分派守卫）、D4（按端作用域保存）不变；呈现与入口按以下口径返工：

### R1｜单页合并

`[adminPath]/rbac/` 恢复为完整单页（守 `system:role:manage`）；`rbac/desktop`、`rbac/app` 两个子页与 `ADMIN_MENU_CODES.RBAC_APP` 退役，`rbac_app` 菜单行由 0131 删除（并治愈已应用旧 0130 的库）。树 = 合成根「角色管理」→ 合成分类层「PC 端管理 / App 端管理」（不入库，由 audience 合成）→ 各端真实结点。App 分类是否出现由服务端判定：账号持有 `system:app-capability:manage` 才读 App 板子与接口清单传入，否则传 `null` 隐藏整个分类（与 App 端四端点的守卫码一致，不留可见性破窗）。

### R2｜树上即点即存

勾选框进树行（码行勾自己的码、分组/页面行勾全部后代码、半选态由 `permissionBranchState` 算；通配角色全禁用）。一次勾选/取消 = 一次 `POST /ajax/rbac/role-permissions`（body 带 audience），前端乐观更新；右栏保留结点编辑器 + 「持有该码的角色」开关（反向视角，同一保存端点）。顶部角色条只承载角色选择（chips + 计数）与「管理角色」入口，替代旧双 tab；角色的新建与维护收进该入口的弹窗，弹窗照用户管理页的两栏语法：左列角色列表（名称 + 代码 + 授权数，底部「新建角色」展开表单），右栏选中角色的详情（显示名称与角色代码各带一个编辑入口，删除在标题右侧）。

### R3｜接口清单融进树形

接口清单不再独立成 tab：码结点下挂只读接口路径叶子（method 徽章 + 只读标记，点选右栏出明细）。App 端 18 行来源不变（`app-interfaces.ts` 推导）；新增 `pc-interfaces.ts` 静态目录覆盖后台全部 `ajax/*` 端点，由 `tests/unit/server/pc-interfaces.test.ts` 逐行防漂移（路由文件存在 + 门码被引用 + 方法确实导出，两跳本地导入扫描覆盖薄壳再导出与工厂委托）。

### R4｜App 端码按用途逐一划开（一门一用途）

`app:mobile:access` 退役，逐端点分发进 `DOMAIN_RULES`（无兜底，未登记即 fail-closed）：`app:nav:read` / `app:style:read` / `app:chapter:read` / `app:content:read` / `app:fang:read` / `app:zhongyao:read`（GetAllZhongYao + GetAliaZhongYao 共码）；GetAllMingCi 归 `app:mingci:view`；search-permission 外门为 `[app:search:global, app:search:book]` 任一双码门（`DomainRule.readAnyOf`，`requiredApiPermission` 返回 `string | readonly string[] | null`）。`credential-bearer` 用 `find(granted)` 放行并记录实际放行码。授权等价映射：持旧码的角色获 7 个新码（6 新码 + `app:mingci:view`），旧授权行删除。树形收拢：`page_app_version_read` / `page_mingci` 两页随叶子并走删除（版本 → app访问、名词 → app搜索）。

### R5｜交互不变量

- 每层手风琴：同层只展开一个（分类层、每端顶层、更深各层同规）；搜索态命中强制展开例外。
- 角色 CRUD 只有弹窗一个入口：`super_admin` / `readonly` 的代码与删除在弹窗里禁用（服务端同样拒绝），改名与改代码合成一次提交。
- 角色条 chips 计数 = desktop + app grants 之和；角色 CRUD 端点返回 desktop 板子，App 板子角色清单本地同步。App 分类隐藏（账号没有 `system:app-capability:manage`）时服务端只发 PC 板子与空接口清单，计数随之只覆盖 PC 端——那一个数不冒充两端之和。

### 验证口径增补

- `rbac.test.ts`：App 板子恰 11 码；跨端提交仍 400；editor 的 App 授权在 PC 保存后原样保留。
- `permission-tree-endpoints.test.ts`：desktop 78 行、App 15 行（1 分组 + 3 页 + 11 码）。
- `rbac-tree-equivalence.test.ts`：版本/名词叶子并页后的挂靠断言。
- `pc-interfaces.test.ts`：137 行目录逐行防漂移。
- 页守卫重放覆盖 0131 的菜单恢复语句（`rbac` 行回归 0041 基线、`rbac_app` 行删除）。
- 运维随动：`manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 补登 `ext_permission_nodes`（durable 数据，0128 起存在；缺失会让快照在装该表的库上拒绝创建）。
