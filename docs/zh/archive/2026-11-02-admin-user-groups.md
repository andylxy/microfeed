# 后台用户页「分组 / 注册来源」落地现状（2026-11-02）

> 本文档按**实际已落地的代码与迁移**记录，不是最初那个被否决的 ADR-0058「条件分组」方案。
> 用户在第 7 轮明确否决了条件分组方案，要求参考 `microfeed2` 的「注册来源列表」实现重做，
> 并在随后的多轮评审里逐步收敛。本文档为该重做后的最终状态。

---

## 1. 一句话结论

后台 `/admin/users/` 左侧分组 = **注册来源分组**。来源列表存 `settings` 的 `signup_sources`
（`[{value, label}]`），可在「新建分组」弹层里增删改名。账号归属靠 `auth_user.signup_source`
这一列实时分桶，不存成员名单。另有一个**系统分组「已封禁账号」**，由 `auth_user.banned`
实时过滤，不进 `signup_sources`。所有新建账号默认授予只读角色 `readonly (r_readonly)`。

---

## 2. 需求演进（关键决策时间线）

| 轮次 | 用户诉求 | 落地决策 |
|---|---|---|
| 1 | 左侧「新建分组」动态维护，存 settings KV，树叶子按库动态加载；参考 microfeed2 | 来源列表 = `signup_sources` 配置，左树按配置 + 库里实际值渲染；下拉换 `AdminSelect` |
| 2 | 删「其他」分组、所有注册链路显式来源、账号默认只读 | 加两道保存闸门（内建不可删 / 在用不可删）；六条建号链路均显式写来源 + 授 `r_readonly` |
| 3 | 按 code-review 清单逐项修 | 抽出 `src/shared/SignupSource.ts` 共享层；服务端瘦身；授权语句统一 `grant.ts`；0169 数据补齐 + 快照重算 |
| 4 | 加「已封禁账号」分组；`back` 是手工添加的；封禁即入组；账号只封禁无重启用 | `BANNED_GROUP_VALUE = "__banned__"` 系统分组；封禁 = `banned=1`，左树实时过滤；解封沿用严格语义（凭据不恢复） |
| 5 | 复审执行 + 三个决定 | `back` 登记进配置（不抹数据）；0169 用 `json_each` 保序合并；加 0170 索引；弹层换 `AdminDialog`；`matchesSignupCategory` 互斥；`signupSourceOf` 修 trim |
| 6 | `back` 是不是没填值？空分组空态？ | `back` 值不空，缺的是显示名（三处补成「手工添加」→ 见第 7 轮修正）；空分组补 `rbac.userGroupEmpty` 空态 |
| 7 | 把线上「现在的数据」烤成默认值，重部署即得 | 默认值对齐线上实跑值 `admin→管理员 / email→邮箱注册 / qq→QQ 登录 / back→后台创建`（见 §4） |
| — | 第 1 个条件分组方案（ADR-0058）被否决 | 全量 `git restore` 还原，按 microfeed2 重做（见 §9 备注） |

---

## 3. 数据模型与存储

- **`settings` 表**：`category = 'signup_sources'`，单行 JSON 数组 `[{value, label}]`。
  键长 `signup_sources`（14）< `category` 的 VARCHAR(20)，无需担心长度。
- **`auth_user.signup_source`**：`TEXT NOT NULL DEFAULT 'email'`（迁移 0157）。**列上无 CHECK 约束**，
  可写值由后台配置决定，不由 schema 决定。后台详情页可把账号重新归类到任一已配置分组。
- **`auth_user.banned`**：封禁标志（0/1）。「已封禁账号」分组的数据源，**不**写入 `signup_sources`。

### 读路径（SSR 每次读）
`getSignupSources(database)`：读 `settings` → 若合法配置则用配置，否则回落 `DEFAULT_SIGNUP_SOURCES`
→ 再 `SELECT DISTINCT signup_source FROM auth_user` 把库里实际出现但配置没有的来源补成
**临时分组**（label=value，不写库）。补全项等第一次「保存分组」才转正。

> 读路径不回写：与 `mail-config.ts` 口径一致，避免每个 GET 都带一次写。

---

## 4. 默认值决策（第 7 轮，线上实跑值）

查证本地运行实例 `ctwh-881019-xyz` 的 `settings.signup_sources` 真实值：

```
admin → 管理员
email → 邮箱注册
qq    → QQ 登录
back  → 后台创建
```

此前第六轮拍板的是 `admin→后台创建 / back→手工添加`，**与线上实跑不一致**。第 7 轮把默认值
烤成线上值，使「重新部署（无配置行）经 0169 branch-1 直接种入这 4 档」即得到与线上一致的数据；
线上实例已存在同值配置行，0169 幂等跳过、不改其数据。

`DEFAULT_SIGNUP_SOURCES`（`src/shared/SignupSource.ts`）：

```ts
export const DEFAULT_SIGNUP_SOURCES: readonly SignupSourceOption[] = [
  {value: "admin", label: "管理员"},
  {value: "email", label: "邮箱注册"},
  {value: "qq",    label: "QQ 登录"},
  {value: "back",  label: "后台创建"},
];
```

**标签仍是裸中文字符串，不是 i18n 键**（沿用第 5 轮「分组名硬编码中文」决定——避免让内建分组的
「改名」能力失效）。

---

## 5. 分组语义

- **来源分组**：左栏按 `signup_sources` 的 value 渲染，「全部用户」为根（列全部）。
- **系统分组「已封禁账号」**：`BANNED_GROUP_VALUE = "__banned__"`，左栏固定追加在末尾，
  不可改名、不可删除。成员 = `auth_user.banned = 1`。
- **互斥规则**（`matchesSignupCategory`，shared 层，可单测）：
  - `category === "__banned__"` → 只收 `banned` 账号；
  - 否则 → 收「未封禁 且 `signup_source === category`」的账号。
  - 一个账号同一时刻只属于一个分组（「全部用户」根仍列全部）。
- **封禁即入组**：封禁/解封后 `UsersApp` 重新拉 board，账号在来源分组里消失、在「已封禁账号」出现，
  不写任何分组变更语句。

---

## 6. 建号链路与默认只读

六条写 `signup_source` 的链路，均显式写来源 + 同批授 `r_readonly` + 重算权限快照
（`refreshUserSnapshotStatements`，ADR-0053 重算点）：

| 链路 | 来源字面量 | 角色 | 授权方式 |
|---|---|---|---|
| `bootstrap.ts`（安装引导） | `admin` | super_admin + readonly | 直写 + snapshot |
| `password-setup.ts`（初始所有者） | `admin` | super_admin（必要例外） | 直写 + snapshot |
| `rbac-handlers.createAdminRbacUser`（后台建号） | `admin` | 指定角色 / 默认 readonly | `grantRoleStatements` |
| `email-signup.ts`（邮箱注册） | `email` | readonly | `grantDefaultRoleStatements` |
| `tcm/app-third-party.ts`（QQ 首登） | `qq` | readonly | `grantDefaultRoleStatements` |
| `manage-cli/lib/auth.ts`（CLI 建号） | `admin` | — | 直写 |

授权语句统一在 `src/server/rbac/grant.ts`：
- `grantRoleStatements(db, userId, codes)` → `INSERT OR IGNORE ... SELECT id FROM auth_user WHERE id = ?` + 重算快照。
- `grantDefaultRoleStatements(db, userId)` → 用 `DEFAULT_USER_ROLE`（= `"readonly"`，经 `roleId()` 映射为 `r_readonly`）。
- 对「同一批里刚被 `INSERT OR IGNORE` 忽略掉的账号」（QQ 并发首登、重名）天然空操作，不污染复用账号。

---

## 7. 保存闸门（`PUT /admin/ajax/signup-sources`）

端点只挂 `system:user:manage`（`pc-interfaces.ts:146` 登记）。两道闸门（`classifyRemovedSources`）：

1. **内建不可删**：`BUILTIN_SIGNUP_SOURCES = ["admin","email","qq"]` 是三条建号路径写死的值，
   删了下次注册就会写进列表外的值（即「未知来源」之源）。返回 400 `builtinSignupSourceRequired`。
2. **在用不可删**：`removedSources(current, next)` 算出的被删项里，若还有账号在用
   （`countAccountsBySource` 计数），返回 409 `signupSourceInUse`（带 count/value），先让账号改到别的来源。

`back` **不在**内建集合，没人用时可以删。

详情页改账号来源也受约束：`updateAdminRbacUserProfile` 第 1639–1646 行用 `hasSignupSource`
校验「新值必须在配置列表内」，否则 400 `invalidSignupSource`。

---

## 8. 关键文件清单（本轮改动）

**新增**
- `src/shared/SignupSource.ts` — 形状、默认值、校验、互斥、移除分类（浏览器+服务端共用）。
- `src/server/auth/signup-source.ts` — IO 层（`getSignupSources` / `setSignupSources` / `countAccountsBySource`）。
- `src/server/admin/signup-sources-handler.ts` — PUT 策略与闸门。
- `src/server/rbac/grant.ts` — 授权语句统一。
- `src/pages/[adminPath]/ajax/signup-sources/index.ts` — 薄路由（仅再导出 handler）。
- `migrations/0169_data_signup_source_register_and_default_role.sql` — 登记缺失来源 + 补只读 + 重算快照。
- `migrations/0170_index_auth_user_signup_source.sql` — `ix_auth_user_signup_source` 覆盖索引。
- 测试：`tests/unit/signup-source.test.ts`、`tests/unit/migrations-0169.test.ts`、`tests/unit/migrations-0170.test.ts`、`tests/worker/signup-sources-api.test.ts`。

**改写**
- `src/components/admin/rbac/UsersApp/index.tsx` — 左树抽成 `settings` 派生、下拉换 `AdminSelect`、弹层换 `AdminDialog`、空态 `userGroupEmpty`、已封禁分组渲染。
- `src/server/admin/rbac-handlers.ts` — `signupSourceOf`（返回 trim 后值）、`updateAdminRbacUserBan`（封禁/解封 + 审计）、`updateAdminRbacUserProfile` 接受并通过校验的 `signupSource`。
- `src/server/auth/email-signup.ts`、`src/server/tcm/app-third-party.ts` — 显式写来源 + `grantDefaultRoleStatements`。
- `src/shared/Rbac.ts` — 删 `SignupSource` 联合死类型；`DEFAULT_USER_ROLE = "readonly"`。
- `src/shared/Constants.ts` — `SETTINGS_CATEGORIES.SIGNUP_SOURCES`、`ADMIN_URLS.ajaxSignupSources`。
- `src/server/admin/pc-interfaces.ts` — 登记 `PUT /admin/ajax/signup-sources`。
- i18n — 新增 ~26 `rbac.*` 键（`userGroup*` / `signupSource*` / `userGroupBanned` / `userGroupEmpty` / `userGroupBannedNote` 等）+ 错误键；删除 `userCategoryFixedTip`、`userCategoryEmail/Qq/Admin` 死键。
- `docs/zh/12-user-system-schema.md` §1/§6.2/§7/§8 同步（含「与 ADR-0014 I12 差异」留痕）。

---

## 9. 历史 bug 与修复（评审中暴露）

| # | 问题 | 修复 |
|---|---|---|
| A | 0169 用 `UNION` 按值排序，打乱管理员排好的分组顺序 | 改用「数组下标占位 + `ORDER BY pos LIMIT -1`」防优化 |
| B | 0169 只插 `ext_user_roles` 未重算快照，读侧缺行=无权限 | 末尾追加快照聚合回填（`FILTER (WHERE p.code IS NOT NULL)`） |
| C | 0169 未校验格式，坏值毒化整份配置 → 回落默认 → 自建分组隐形 | 用 `GLOB` 过滤合法值，坏值留库不登记 |
| D | `signupSourceOf` 只 trim 判空却返回未 trim 原值，`" qq "` 找不到分组 | 返回 trim 后的值 |
| E | `getSignupSources` 的 `SELECT DISTINCT` 全表 + 临时 B-tree | 0170 加索引，计划变 `COVERING INDEX` |
| F | `removed` 算两遍（handler 与校验各算） | 抽出 `removedSources()` 共用 |
| G | 手写弹层遮罩无焦点陷阱/Esc/aria-modal | 换 `AdminDialog` |
| H | 空分组无渲染，像点了没反应 | 补 `rbac.userGroupEmpty` 空态 |
| I | `back` 显示名缺（裸 value） | 三处补默认标签（第 7 轮改为「后台创建」） |

---

## 10. 未决 / 遗留（刻意未做，非遗漏）

- **门禁 / 测试未跑、未 `git commit`、未对本地库 `apply` 迁移**（项目红线：测试只写不跑，门禁由用户手动触发）。`git diff --check` 通过。
- **分组名硬编码中文**（非 i18n 键）：沿用第 5 轮决定，避免内建分组「改名」失效。英文界面左栏仍显示中文。
- **客户端 `UsersApp` 仍手写部分即时预检**（label 空 / 重复 / `__banned__`），未全用 shared 函数——规则已共用同一常量，仅省往返。
- **来源写死散落 5+ 处**（bootstrap / password-setup / rbac-handlers / email-signup / app-third-party / manage-cli），靠测试对齐。
- **`tests/unit/migrations-0169.test.ts` 用正则断言 SQL 文本**（复述实现），非行为级。
- **`rbac-handlers.ts` 注释漂移**（旧「四个字段」已扩为五列），待顺手清理。
- **`countAccountsBySource` 未量化写索引/扫描行数**（注释已述计划，缺具体行数数字）。

---

## 11. 验证状态

- 只读探针（本地 D1）：`EXPLAIN QUERY PLAN` 确认 0170 索引生效（无 `TEMP B-TREE`）。
- 临时验证脚本 `.agent-tmp/verify-0169.py` 跑过五种情形，验完已删。
- 测试文件已写（只写不跑），覆盖：403 / 删内建 400 / 删在用 409 且不落库 / 正常保存 / 非法列表 / 改名 / 拒绝 `__banned__` / 手工来源补临时分组未写库 / 保序 / 幂等 / 坏配置不动 / 只读回填。
- 运行态端到端、门禁量化、提交动作**待用户手动执行**。

---

## 备注：被否决的 ADR-0058 条件分组方案

最初实现的是「分组 = 保存的过滤条件（signupSource / banned / role）」，产出 ADR-0058 +
9 张工单 + 8 个源文件。用户在第 7 轮判定其「搞错了、搞复杂了」，全量还原后按 microfeed2 的
「注册来源列表」参考重做，即本文档所述最终方案。ADR-0058 相关文件（`.tasks`、`tickets`、新增
组件/端点/模块）在还原时已一并删除，本仓库当前无 ADR-0058 痕迹。
