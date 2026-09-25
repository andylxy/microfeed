# 用户 / 角色 / 权限 体系：问题盘点与改善方案问题清单

> **场景**：重新分析「多用户多角色」授权体系的问题与改善方案。
> **硬约束**：**不影响上游升级**。
> **来源**：事实由 AI 查证（Explore 子代理 + 迁移/代码核对，2026-09-23）；**决策待你确认**。
> **勾法**：每条给选项与推荐；回「Q1 B，Q2 B…」或「按推荐」即可。

---

## 一、事实基线

### 表

| 层 | 表 | 说明 |
| --- | --- | --- |
| 身份（上游 Better Auth） | `auth_user` / `auth_session` / `auth_account` | `auth_user` 带 `role`（取值仅 `admin` / `user`）与 `banned` |
| RBAC 策略（本地 `ext_*`） | `ext_roles`、`ext_permissions`、`ext_user_roles`、`ext_role_permissions` | 角色、权限码（35 个）、用户↔角色、角色↔权限 |
| 账号闸门（与授权正交） | `ext_user_security`（`must_change_password`）、`ext_user_devices`、`ext_login_credentials`、`ext_login_credential_attempts` | 吊销设备 / 强制改密 / 第二登录方式 |
| UI 结构 | `ext_menu`、`ext_menu_permissions` | 菜单是数据；**故意无 FK**（菜单永不授权） |
| 审计（仅 API 调用） | `ext_api_access_log` | 只增；**不覆盖 RBAC 变更** |

### 授权决策链（`src/server/rbac/guard.ts`）

```
401 未登录 → 401 banned → 401 设备吊销 → 428 强制改密
  → 含 * → ALLOW
  → legacy auth_user.role === 'admin' → ALLOW
  → code ∈ 已解析权限 → ALLOW
  → 403
```

### 上游分叉面（决定「不影响升级」的可行边界）

- 上游基线 = 最后一个上游提交 `b510bb2`（2026-09-11）；其后 **116 个 fork 提交**。
- **迁移**：上游 `0001–0022`；本地新增 **`0023–0052`**，**未改动任何既有上游迁移**（纯增量 ⇒ 升级友好）。
- **被修改的上游文件（= 合并冲突面）**：`src/server/auth/better-auth.ts`、`src/middleware.ts`、
  `src/shared/Api.ts`、`src/shared/AdminCredentials.ts`、`src/shared/Constants.ts`、
  `src/server/api/{access,api-keys,handlers}.ts`、`src/server/auth/{bootstrap,admin-owner}.ts`、
  `src/server/feed/*`、`manage-cli/**`、`tests/**`、`themes/**`、`AGENTS.md`。
- 纯本地新增（**零冲突**）：全部 `ext_*` 迁移、`src/server/rbac/*`、`src/server/admin/rbac-handlers.ts`、
  `menu.ts`、`src/shared/{Rbac,LoginCredential,api-signing}.ts`、`src/components/admin/rbac/*`、`.scratch/*`。

---

## 二、问题盘点（8 条）

| # | 问题 | 证据 |
| --- | --- | --- |
| **P1** | **两套角色系统并存**，可互相矛盾 | `auth_user.role`（`admin`/`user`）与 `ext_user_roles` 并列；guard 第 6 步是 legacy 旁路 |
| **P2** | **legacy admin 是隐形超管** | `role='admin'` 直接 ALLOW；但管理页对它显示 `roles: []` —— UI 里既看不到也改不了这个身份 |
| **P3** | **legacy 旁路压过 RBAC** | 同一账号既有 `role='admin'` 又有普通 RBAC 角色时，旁路先生效，角色形同虚设 |
| **P4** | **没有 per-user 授权** | `0045` 建过 `ext_user_permissions`（`grant`/`deny`），`0046` 删除，**无替代**；今日 = 多角色并集 |
| **P5** | **没有 deny，也没有层级/继承** | 只能加权限不能减；角色扁平，无继承 |
| **P6** | **RBAC 变更零审计** | `rbac-handlers.ts` 改角色/权限/用户不写任何日志；只有 API 调用有 `ext_api_access_log` |
| **P7** | **API key 权限双轨** | legacy bearer 用 `api_keys.scopes`（`content:read/write`）；签名调用/登录凭证改用 RBAC `api:*` 且**忽略 scopes** ⇒ `scopes` 对用户凭证是死列 |
| **P8** | **关键值硬编码** | `super_admin` / `*` / `admin` 散在 `guard.ts`、`rbac-handlers.ts`（`SUPER_ADMIN`/`RESERVED_ROLES`/`CODE_LOCKED_ROLES`）、`seed.ts`、迁移 `0031/0035/0040/0043` |

### 术语冲突（需先统一，否则方案会歧义）

`CONTEXT.md` 把**「角色」**定义为「一组命名的权限集合，可分配给账号」（= `ext_roles`）。
但代码里 `auth_user.role` **也叫 role**，却是 Better Auth 的字符串（`admin`/`user`），**不是权限集合**。
⇒ 建议术语：**「角色」**专指 `ext_roles`；`auth_user.role` 一律叫**「Better Auth 角色」**（或「legacy 角色」）。

---

## 三、Round 1（frontier）

- [ ] **Q1 本次产出是什么？**
      → A. 只要问题清单 ｜ B. **问题清单 + 方案定稿（写 ADR）** ｜ C. 定稿后直接实施
      ↩ 选：
- [ ] **Q2 「不影响上游升级」的红线画在哪？**
      → A. 只碰纯本地新增，**不改上游文件**（但 `better-auth.ts` 已因 username 插件改过，A 已不成立）
      → B. **允许改上游文件，但只做插入级最小 diff**（不改既有结构、不重排、不动既有语义）
      → C. 只保证「不改既有上游迁移」
      ↩ 选：
- [ ] **Q3 两套角色系统怎么收敛？（P1/P2/P3）**
      → A. **RBAC 成为唯一授权来源**：`auth_user.role` 降级为 Better Auth 内部字段；legacy `admin` 用
           **一次性迁移**收编为 `super_admin` 角色，guard 去掉旁路
      → B. 保留旁路但**显性化**（用户页明确标出「此账号绕过 RBAC」）
      → C. 维持现状
      ↩ 选：
- [ ] **Q4 要不要恢复 per-user 授权 / 引入 deny？（P4/P5）**
      → A. 恢复 per-user `grant`/`deny`（新表 + UI + 守卫）
      → B. **维持 role-only 并集**（`0046` 刚删掉，视为有意为之）
      ↩ 选：
- [ ] **Q5 优先级：先治哪一类？（P1–P8）**
      → A. **安全/越权**（P1/P2/P3/P5）
      → B. 可维护性（P6/P8）
      → C. 易用性（P4/P7）
      ↩ 选：

> 回完这轮我再算下一轮 frontier（会包含：legacy 收编的具体迁移方式、guard 决策链重排、
> 审计表设计、API key 双轨如何收敛 —— 它们都挂在 Q2/Q3/Q4 的答案后面）。

---

# 四、补充：问题不是并列的，是一条因果链

## 4.1 三个根因

| 根因 | 内容 |
| --- | --- |
| **R1 授权来源不唯一** | `auth_user.role` 与 `ext_user_roles` 并列；`api_keys.scopes` 与 RBAC `api:*` 并列 |
| **R2 权限代数太弱** | 只有并集：无 deny、无继承、无 per-user |
| **R3 变更不可追溯** | RBAC 改动不写任何日志 |

## 4.2 传导关系

```
R1 ─→ P1（两套角色）─→ P2（隐形超管）
                    └─→ P3（旁路压过 RBAC）
   ├─→ P7（API key 双轨）        ← R1 的第二个面
   └─→ P8（关键值硬编码）        ← R1 的第三个面：没有一等概念，只能写字面量
R2 ─→ P4（无 per-user）、P5（无 deny/继承）
R3 ─→ P6（零审计）
```

**即 P2/P3 不是独立缺陷，是 P1 的必然后果**；P7/P8 与 P1 同源（都属「授权来源不唯一」）。
所以「分别修 P1–P8」是错的做法，**治根因才收敛**。

## 4.3 复合风险（这才是「体系问题」）

R1 + R2 + R3 叠加 = **一个看不见、查不到、也减不掉的超级管理员通道**：

- 看不见（P2）：legacy `admin` 在用户页显示 `roles: []`，UI 里既看不到也改不了；
- 查不到（P6）：它的动作不留痕；
- 减不掉（P5）：权限代数不支持 deny，即使知道它在，也无法只收掉它某一项能力。

## 4.4 一条被验证的关键事实（决定 F1 风险）

- `migrations/0031_ext_rbac_seed.sql:58` **已回填**：
  `INSERT OR IGNORE INTO ext_user_roles SELECT id, 'r_super_admin' FROM auth_user WHERE role = 'admin'`。
- `src/server/auth/bootstrap.ts:101` 对新 owner 也发 `r_super_admin`。
- ⚠️ **但 `src/server/auth/password-setup.ts:279`（`purpose='initial'`，即第一个 owner）
  只写 `role='admin'`，不发 RBAC 角色** —— 这条路径**目前完全依赖 legacy 旁路**。

⇒ 结论：**F1 不能只「删旁路」**，必须同时补上 password-setup 的角色授予；
而 `password-setup.ts` 是**上游拥有的文件**（⇒ 触碰 F1 的上游红线）。

---

# 五、改善方案（按依赖顺序）

## F1 收编 legacy（治 R1 → 消 P1/P2/P3，顺带 P8）

1. **迁移**（本地 `ext_*` 编号继续往后）：把 `role='admin'` 且**无** RBAC 角色的账号补授 `r_super_admin`（幂等）。
2. **`password-setup.ts`**：初始 owner 建号时同批发 `r_super_admin`（**改上游文件，插入级 diff**）。
3. **`guard.ts`**（本地）：删掉第 6 步 legacy 旁路。
4. **过渡可见性**：用户页把 `auth_user.role='admin'` 明确标为「Better Auth 角色（不参与授权）」。

> ⚠️ **顺序即安全**：漏掉 1/2 就删 3 ⇒ **初始 owner 会失去访问**。必须 1、2 先落地并验证，再删 3。

## F2 统一 API key 授权（治 R1 第二面 → 消 P7）

二选一：让签名调用/登录凭证也尊重 `api_keys.scopes`；或明确废弃 `scopes`、全部走 RBAC `api:*`。
**推荐废弃 `scopes`**（它已是死列），并在文档里写明。

## F3 RBAC 审计（治 R3 → 消 P6）

新表 `ext_rbac_audit`（actor / action / target / before / after / at），在 `rbac-handlers.ts` 写路径落一行。
**全本地，零上游冲突。**

## F2′ 权限代数（治 R2 → 消 P4/P5）—— **暂缓**

只在出现真实场景时再做（`0046` 刚删掉 per-user 表，说明当前不需要）。

---

# 六、Round 1′（请逐条回）

- [ ] **Q1 因果链对不对？** R1→P1→{P2,P3}、R1→{P7,P8}、R2→{P4,P5}、R3→P6
      ↩ 改：
- [ ] **Q2 复合风险的判断认不认？**（隐形 + 无痕 + 减不掉）
      ↩ 改：
- [ ] **Q3 改善顺序认不认？** 先 F1 的 1、2 步 → 再删旁路 → F3 → F2 → F2′ 暂缓
      ↩ 改：
- [ ] **Q4 上游红线**：F1 第 2 步**必须改 `password-setup.ts`（上游文件）**，接受「插入级最小 diff」吗？
      → A. 接受 ｜ B. 换方案：不改上游文件，改为在别处补授角色（多一次写入，但零上游 diff）
      ↩ 选：
- [ ] **Q5 是否现在实施？** → A. 是，按 F1 → F3 ｜ B. 先只做 F1 ｜ C. 先不动
      ↩ 选：

---

# 七、执行记录（2026-09-23 21:40）—— F1 + F3 已落地

## 已实施

| 项 | 文件 | 内容 |
| --- | --- | --- |
| F1① | `migrations/0053_backfill_admin_super_admin.sql` | `role='admin'` 且**无 `super_admin` 角色**的账号补授（幂等） |
| F1② | `src/server/auth/password-setup.ts` | 初始 owner 建号 batch 内同批发 `r_super_admin`（**插入级；上游文件**） |
| F1③ | `src/server/rbac/guard.ts` | **删掉第 6 步 legacy 旁路**；决策链改为 `*` → code → 403 |
| F1④ | `src/components/admin/rbac/UsersApp/index.tsx` + i18n | 用户页标注「Better Auth 角色不参与授权」 |
| F3 | `migrations/0054_ext_rbac_audit.sql`、`src/server/rbac/audit.ts`、`src/server/admin/rbac-handlers.ts` | 新审计表 + **11 个写路径**落痕（`role.create/rename/renameCode/delete`、`role.permissions`、`user.create/roles/ban/unban/delete`、`device.revoke/restore`） |
| F3 | `manage-cli/lib/snapshot.ts` | `ext_rbac_audit` 登记进 durable |
| F2 | `src/shared/Api.ts` | 注释写明 `scopes` 只管 legacy bearer 路径 |

## ⚠️ 一处**分析更正**（上一轮我说错了）

Round 1′ 里我把 `api_keys.scopes` 称为「**死列**」——**这是错的**。
`src/server/api/access.ts:156` 的 legacy bearer 路径**确实在读它**（`grant.scopes.has(requiredScope)`）。

真实情况：**legacy bearer 用 `scopes`；签名调用 / 登录凭证用 RBAC `api:*`；两条路各读各的**。
所以 F2 **不是「删死列」，而是一个需要决策的收敛问题** —— 本轮只加了说明性注释，**未改行为**。

## 测试与门禁

- 两个 worker 测试**断言的是旧旁路行为**，已按新语义更新：
  - `admin-menu.test.ts`：legacy admin 无授权 ⇒ **只剩首页**；被收编（持 `super_admin`）⇒ 全部。
  - `rbac.test.ts`：`role='admin'` 单独不再授权 ⇒ **403**；持 `*` ⇒ 放行。
- 新增审计测试：改角色权限后 `ext_rbac_audit` 落一行（actor / action / target / detail）。
- 门禁：typecheck **0/678**；unit **979 passed**（+1 skipped）；worker **278 passed**；i18n **2004/2004**。
