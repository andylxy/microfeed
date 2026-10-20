# ADR-0038: 权限树自持于 `ext_permission_nodes`

- 状态：Accepted
- 日期：2026-10-20
- 决策人：用户 + grill-with-docs 五轮追问拍板 + 写码前两轴 code-review（结论回灌为最终方案）
- 关联：方案 `.tasks/2026-10-20-permission-tree-self-hosted.md`；迁移 `0127_seed_permission_nodes.sql`；被否备选的现状实现 `src/shared/Rbac.ts` 的 `buildPermissionTree`（本 ADR 生效后退役）

## 背景

`/admin/rbac/` 的「给角色分配权限」树此前**不存在数据库里**，是每次打开页面时用菜单的料临时搭的：

| 事实 | 位置 |
| --- | --- |
| 树的架子（分组/页面）借自菜单表 | `ext_menu`（`readRbacBoard` 第 4 条查询） |
| 「哪个页面下挂哪些权限码」存另一张映射表 | `ext_menu_permissions`（第 5 条查询，`src/` 唯一读取点 `rbac-handlers.ts`） |
| 无菜单页可承接的 App 能力权限走代码常量分流 | `OTHER_PAGE_PREFIXES`（`src/shared/Rbac.ts`） |
| 仍无去向的码进兜底组/兜底页 | `RBAC_OTHER_GROUP`(`group_other`) / `RBAC_OTHER_PAGE`(`unmapped`) |
| 权限本体没有任何 CRUD 端点 | 角色有 5 个 ajax 端点，权限码只有代码常量目录 `RBAC_PERMISSIONS`（52 条，可授 51） |

后果：权限树的层级、父级、排序全部随菜单漂移（菜单改名/重排牵动权限树）；新权限码必须先在菜单挂映射才在授权界面可见；权限树本身不能增删改移——用户要的「像菜单管理那样增删改移、移动权限对象位置」在派生模型上无解。

## 决策

### D1｜树自持：新建 `ext_permission_nodes`，一次性迁移固化当前派生结果

三类节点 `group / page / code`，各自带 `parent_code + sort`；分组/页节点冗余 `name_zh / name_en / icon / i18n_key`（页面可改），`code` 节点（叶子）冗余空、渲染时取 `ext_permissions.name` 对应目录名。迁移 `0127` 把当前派生树固化为 **87 行**（7 分组 + 29 页面 + 51 权限码），由一次性生成器产出（非手写），核对：45 条旧映射码零丢失、51 个可授码全部有挂靠点、`(sort, code)` 读序重建与派生树逐字节相等。

### D2｜此后权限树的读写只认这一张表

`readRbacBoard` 删 `ext_menu` / `ext_menu_permissions` 两条查询换一条节点表查询（5 → 4）；组装函数逐字段复刻原 `RbacPermissionGroup {code, pages: RbacPermissionPage[]}` / `RbacPermissionPage {code, codes: string[]}` 形状（含空页跳过、空组跳过），由数据不变量测试锁定——用户界面上看到的授权树与搬迁前一致。

### D3｜`/admin/rbac/` 分为两个 tab，旧派生树删除

「角色管理」tab = 现有逻辑（角色 CRUD + 勾选授权），树换成自持树；「权限树管理」tab = 左树右详情、5 种 op（`create-group / update / move / delete / reorder`）、Pointer 拖拽三段放置、搜索、展开收起、导出 SQL——形态、链路、原子性都照搬 `/admin/menu/`。守卫不变（两端点仍 `system:role:manage`）。

### D4｜收紧规则比菜单管理更严（权限码是代码常量）

`code` 节点禁止新建/删除；`update` 仅允许 `parentCode` 与 `isVisible`；`permission_code` 不可变；**允许跨 page/group 改父（reparent）**——这是「移动权限对象位置」的核心动作。`source='seed'` 行禁止删除；有子节点禁止删除。

父级按三层结构收窄：分组可挂分组（嵌套分组）或停在根层，页面只挂分组，权限码只挂页面；`parentCode: null` 只对分组行成立（页面行与权限码行失去父级后会从授权视图消失）。拖拽与下拉共用同一套判定，前端拒绝的放置位置服务端也会拒绝。

全部 op 先在纯函数层的内存快照上模拟，任一失败整批拒绝、零写库，通过才 `db.batch` 原子提交。

### D5｜旧料彻底退役（SSOT 红线）

`ext_menu_permissions` 零读零写；`OTHER_PAGE_PREFIXES`、`group_other`/`unmapped` 兜底、合成页常量整体从 `src/shared/Rbac.ts` 删除。两条真相源并存必然打架。坏处（码漏登记就不可见）由回归测试兜底：`@/shared/Rbac` 的导出面不再含已删符号（`rbac-zero-legacy-mapping`），且 `buildGrantGroupsFromNodes` 保证 51 个可授码每个至少 1 个挂靠点（`rbac-orphan-code-guard` + worker 等价测试）。

### D6｜授权树标签改由节点 name 列解析（与菜单文案解耦）

角色 tab 的授权树标签不再借菜单 i18n 键，改为读节点行的 `name_zh`/`name_en`（空则回退 `i18n_key` → `code`）。迁移 `0127` 把固化时刻的 i18n 文本写进冗余列，故标签是迁移时的快照：菜单文案后续改动不再牵动授权树（与 D4 解耦目标一致）。D2 的 `{code, codes}` 最小字段集保持不变，D6 仅在其上扩展 `nameZh`/`nameEn`/`i18nKey` 供标签解析。

## 备选

| 备选 | 否决理由 |
| --- | --- |
| 复用 `ext_menu`：权限分组/页建成 `path=''`、不可见的菜单行 | 菜单管理页读全表，权限分组会出现在菜单管理页里；两套语义混在一张表，菜单与权限互相干扰 |
| 派生 + 自建叠加层：只存管理页新建的节点，原骨架仍借菜单 | 菜单派生的组/页不能移不能删，「移动权限对象位置」只对少数节点生效，违背目标 |
| 只做移动不做增删改 | 用户明确要求「照搬菜单管理的 CRUD 方案」 |

## 后果

- 菜单与权限树解耦：菜单改名/重排不再牵动授权树；权限树可独立 CRUD 与拖拽移动。
- 新增权限码的去向从「先在菜单挂映射」变为「在节点表挂节点（迁移固化或管理页拖拽）」；`.scratch/microfeed-rbac/new-feature-menu-permission-checklist.md` 第 ③ 步随之改写。
- 读代价：节点相关读从 33 + 45 两表 78 行变为单表 87 行；管理页每开一次约读 87 + 52 + grants 行（三位数量级），对 5M 读/日、100K 写/日额度无实质压力；索引 `parent_code / (sort,code) / kind` 覆盖全部读路径，87 行小表不触 D1-scan 大表全扫规则。
- **已知边界（照搬不改）**：菜单行 `rbac_audit` 无映射、当前不在授权树中，固化后同样不在——历史缺口，非本次回归。
- **未做**：权限码本身的全量 CRUD（自建新码仍只走迁移/常量目录）、按权限节点反向授权（授权方向不变）、审计日志（权限树改动暂不单独记审计，角色授权变更的既有审计不变）。

## 验证口径

- 等价回归：`tests/worker/rbac-tree-equivalence.test.ts` 断言固化节点经 `buildGrantGroupsFromNodes` 组装出的授权树含全部 51 个可授码且均可达、组/页携带双语名（角色 tab 标签来源）。旧派生树 `buildPermissionTree` 已在票据 06 退役；迁移 `0127` 生成时即与派生树 `(sort, code)` 读序逐字节相等，运行期改以数据不变量替代「逐字节比对」作为前端零改动的证据。
- 纯函数层：`tests/unit/shared/permission-tree-ops.test.ts` 覆盖 plan 全分支（成环、seed 保护、有子拒删、code 父级拒绝、code 禁增删、code 跨页改父、ops 超限等）。
- 退役守护：`tests/unit/shared/rbac-zero-legacy-mapping.test.ts` + `tests/unit/shared/rbac-orphan-code-guard.test.ts`。

测试只写不跑，运行由用户手动触发 `.microfeed-gate-subset` 技能（`check-adr`、`check-migrations`、`check-i18n`、`check-server-layout`、`check-endpoint-registration`、`check-d1-scan`）。
