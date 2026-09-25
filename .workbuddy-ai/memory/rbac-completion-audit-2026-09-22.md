# RBAC 真实完成度审计（对照设计规范 + 16 张工单）

- 审计日期：2026-09-22
- 审计方法：**不采信工单 `done` 标记**，逐文件源码级核验 + 全量 worker 测试复跑
- 一句话结论：**基础设施层 100% 落地、测试全绿；但两条安全分支（强制改密 428、设备吊销 401-revoked）在生产中不可达——因其上游“状态写入者”从未实现。**

## 一、验证方式

1. 逐票读取 `.scratch/microfeed-rbac/issues/T-*.md` 的 Definition of Done。
2. 逐文件核对 `src/server/rbac/{resolve,guard,replay,seed}.ts`、`src/middleware.ts`、`migrations/0028~0031`、`src/server/auth/bootstrap.ts`、`src/pages/[adminPath]/ajax/*`、`src/server/admin/rbac-handlers.ts`、两个 React 组件、两个 `.astro` 页。
3. 决定性 grep：全仓库 `must_change_password` / `status='revoked'` 的**写入点**。
4. 复跑：`yarn vitest run --config vitest.worker.config.ts` → **209 passed (209), 18 files**。

## 二、逐票核对矩阵

| 工单 | DoD 要点 | 真实落地位置（文件:行） | 结论 | 备注 |
|---|---|---|---|---|
| T-01 | 建 `0028` 五张 `ext_` 表 | `migrations/0028_ext_rbac.sql` | ✅ 真完成 | 表/索引/级联/加性命名，与 §7 逐字一致 |
| T-02 | 建 `0029` 设备表 | `migrations/0029_ext_user_devices.sql` | ✅ 真完成 | PK(user_id,device_id)，status default active；revoked 值无写入者→见 Gap E |
| T-03 | `env.d.ts` 加 `rbacPermissions` | `src/env.d.ts:75-78`（4 字段） | ✅ 真完成 | 仅追加，升级安全 |
| T-04 | `resolveUserPermissions` 三表 JOIN + 通配注入 | `src/server/rbac/resolve.ts:14-34` | ✅ 真完成 | super_admin→`['*']` |
| T-05 | `requirePermission` 8 步 + `requireAppVersion` | `src/server/rbac/guard.ts:40-100`（device→401:77-79，must_change→428:81-83，legacy admin→90-93） | ⚠️ 代码完整，步骤 2/3 生产不可达 | 见 Gap D / Gap E；对“安全意图”标记 done 名不副实 |
| T-06 | `checkReplay` ±5min + nonce 去重 | `src/server/rbac/replay.ts` | ✅ 真完成 | 仅对带 `X-Nonce`/`X-Timestamp` 的请求生效，web 无头放行符合设计 |
| T-07 | 取消（不建 hooks.ts） | — | ✅ cancelled-by-design | D-009 |
| T-08 | 取消（不碰 better-auth.ts） | — | ✅ cancelled-by-design | 升级安全红线 |
| T-09 | middleware：解析+版本门禁+设备 upsert active | `src/middleware.ts:232`（版本门禁）、`313-323`（写 locals）、`resolve.ts:80-101`（upsert active 幂等） | ⚠️ 字面 DoD 完成 | 但 T-05 步骤 2 所需的“吊销”动作不存在 → 设备管理不完整 |
| T-10 | 首批端点加 guard + 敏感写 checkReplay + 改密清除 | `src/pages/[adminPath]/ajax/{books,categories,volumes,feed,account}/*`、`feed.ts:140-154`（content:article:delete 分流）、`password.ts:34`（clearMustChangePassword） | ✅ 真完成 | §8.1 端点逐条对上；读操作不加 guard 符合 D-11 |
| T-11 | 种子 super_admin/editor + 21 条权限目录 + bootstrap 回填 super_admin | `src/server/rbac/seed.ts`（RBAC_PERMISSIONS 21 含 `*`，RBAC_ROLES）、`bootstrap.ts:9,69`、`migrations/0031` | ✅ 真完成 | 双源一致（`p_*` 非 `p_wildcard`）；但 DESIGN §8/§11 要求的 `must_change_password=true` 未做 → Gap D 根因 |
| T-12 | 启动自检权限码格式/存在性 | 偏离：worker 测试 `rbac.test.ts:324-327` 断言“SQL 种子 code 集合 == 代码目录” | 🔁 偏离实现（§16.2 已记录） | 非缺陷，但非 DoD 字面要求的“启动自检” |
| T-13 | worker 单测覆盖 D-010/D-011 全分支 | `tests/worker/rbac.test.ts`（58 例） | ✅ 真完成 | 428/401-device 靠测试内**手工 INSERT** 触发 → 绿证但生产不可达（正是 Gap D/E 根因） |
| T-14 | 本地 D1 迁移验证 | 由 209/209 worker 测试经 `readD1Migrations` 应用到内存 D1 建表+级联实质覆盖 | ✅ 完成 | 未单独跑 `wrangler d1 migrations apply --local`，但等价 |
| T-15 | typecheck + vitest 全绿 | worker 209/209 | ✅ 完成 | 真实门禁是 `yarn typecheck`（=types+astro check+tsc），非裸 `tsc --noEmit` |
| T-16 | 文档回填 DESIGN §11 + memory | `DESIGN.md §11`（真实存在，§11.3/11.4/11.5/11.6） | ✅ 真完成 | 与 ADR/计划一致 |

## 三、两条真实缺口（标记 done 但运行时不完整）

### Gap D — 强制改密（428）不可达

- **规范来源**：`DESIGN.md:40` “`must_change_password`：种子**或重置密码后置 true**，登录后必须先改密”；`DESIGN.md:169` “admin 用户 → super_admin…`must_change_password=true`”；`DESIGN.md:160` 强制改密 428 拦截；`T-05 DoD 步骤 3` 要求 428。
- **已就位**：`guard.ts:81-83` 实现 428 分支；`resolve.ts:69-78` 读取标志；`guard.ts:131-141` `clearMustChangePassword` 只置 `0`。
- **缺口**：全仓库（grep `src/**`）**没有任何代码将 `must_change_password` 置 `1`**。`bootstrap.ts` 只 seed 角色 + 回填 `super_admin`，不置该标志；管理员“创建/重置用户”（`rbac-handlers.ts`）也不置。
- **后果**：生产中 428 分支永远不触发；只有测试经手工 `INSERT must_change_password=1`（`rbac.test.ts:350`）伪造成真。
- **修复方向（待用户拍板）**：bootstrap 对初始管理员置 `=1`（符合 `DESIGN:169`）；管理员“重置密码”流程置 `=1`；或新增“强制改密”管理操作。guard/UI 已就绪，仅需 producer。

### Gap E — 设备吊销（401-revoked）不可达

- **规范来源**：`DESIGN.md:41` device_id “用于单设备吊销”；`DESIGN §11.3` 决策优先级含“设备 revoked → 401”；`T-05 DoD 步骤 2` 要求 401。
- **已就位**：`guard.ts:77-79` 实现 device→401；`resolve.ts:80-91` 读 `status==='revoked'`（注意：`resolve.ts:93-100` 的 upsert `ON CONFLICT` 仅更新 `last_seen_at`，**不动 `status`**——所以一旦被置 revoked 会保持，不会被覆盖回 active）。
- **缺口**：全仓库**没有任何代码写 `ext_user_devices.status='revoked'`**。middleware/resolve 只 upsert `'active'`；无任何“吊销设备”端点/UI/管理操作。
- **后果**：device-revoked 分支在生产不可达（除非运维手动 `UPDATE` D1）。
- **修复方向（待用户拍板，影响面最大）**：新增“吊销设备”操作（管理端点 + UI），写入 `status='revoked'`；`status` 列与 guard 已就绪，仅需 producer。

## 四、设计权衡（非缺陷）

- **Gap F（刻意旁路，维持现状）**：`guard.ts:90-93` legacy `role==='admin'` → ALLOW。这是 ADR-001 D-010 第 6 步刻意的升级安全旁路（`DESIGN §11.4` 双保险），确保 rebase/首部署后既有管理员不失权。非缺陷，不修。
- **Gap G（轻微，非缺陷）**：`editor` 角色在 `seed.ts:58-70` 实际含 **7** 条（book read/update/create + category read/update + volume read/update），T-11 枚举只列了 6 条（漏 `volume:read`）。但符合 `DESIGN §8.1` “editor = 创建/查看/编辑，不含删除”；editor 仍无 delete/manage，最小权限成立。仅票据措辞不准，无需改代码。

## 五、绿证（测试全绿，但“绿”≠“生产可达”）

- worker 全套 **209 passed (209)** / 18 文件（含 rbac 58 例、CRUD 集成、bootstrap-admin 5 例）。
- `source-architecture.test.ts` 18/18（分层边界：浏览器组件禁从 `@/server/` 导入）。
- i18n `yarn i18n:check` 1926/1926（en/zh-CN 数量相等）。
- `yarn typecheck` 0 errors（真实门禁）。

## 六、结论与建议

- **基础设施层**（表/种子/解析/决策链/中间件接入/端点闸门/防重放/文档）**真实完成、测试全绿**，与票据 `done` 一致。
- **“完成”二字对两条安全能力不成立**：强制改密（428）与设备吊销（401-revoked）的 enforcement 已就位且经测试，却因缺少“状态写入者”而在生产中永不触发。这是**设计/实现的真缺口**，不是标记错误，也不是测试遗漏。
- **建议**：合并前或下一迭代补齐 Gap D（bootstrap/重置置 `must_change_password=1`）与 Gap E（吊销设备端点）。二者工作量小（guard/表已就绪），但属安全功能完整性。Gap F 维持现状。

**总判定**：14 个 done 中，T-05 / T-09 的 “done” 对“安全意图”需打折；T-12 为偏离实现（已记录）；其余名副其实。两条生产不可达缺口（D/E）需用户拍板是否修。
