# ADR-0018: ADR 采用单一编号空间

**状态**: 已接受
**日期**: 2026-10-12
**背景**: D1 读路径全表扫描审计（见 `docs/novel-cms/adr/` 目录下历史条目与 `.workbuddy/memory/2026-10-09.md`）
**关联**: `0017` `0023`

## 背景

历史上有 3 套 ADR 编号空间各自编号：

- `docs/novel-cms/adr/`（生产 ADR，0001–0017，`0002` 重复占用）
- `.scratch/microfeed-rbac/adr/`（RBAC 草稿空间，0001–0011）
- `.scratch/microfeed-db/adr/`（数据库草稿空间）

代码注释按裸编号书写（如 `ADR-0002 版本门`），读者按 `docs/novel-cms/adr/` 目录去查会查错：

- `ADR-0002` 在 `docs/` 是「作者隔离」，在 `.scratch/` 是「版本强制整数码」
- `ADR-0005` 在 `docs/` 是「可选 webcategory 主题槽」，在 `.scratch/` 是「版本门作用域」
- `ADR-0006` 在 `docs/` 是「内容读 API」，在 `.scratch/` 是「App 路径与设备接线」
- 8 处登录日志引用 `ADR-0002 登录时间日志` 指向不存在的编号（无任何 ADR 文件）
- `src/server/rbac/guard.ts:4` 写 `ADR-001 D-010`，`src/server/admin/rbac-handlers.ts:318` 写 `ADR D-010 step 3`，`.scratch/microfeed-rbac/rbac-change-review-2026-09-23.md:22` 明确写着「所引 ADR 不在本仓，无法核对」

`src/` + `migrations/` 内共 81 行注释含 `ADR-00NN` 类引用，全部需要归属判定与改写。

## 决策

### 1. 单一编号空间

`docs/novel-cms/adr/` 是唯一编号空间。`.scratch/*/adr/` 是草稿，编号可任意（草稿可反复重写），但**不得被 `src/` 与 `migrations/` 按裸编号引用**。

### 2. 引用格式

代码注释用裸编号 `ADR-NNNN` 引用即可。门禁（`scripts/check-adr.ts`）只强制两件事：

- 该编号必须在 `docs/novel-cms/adr/` 下有对应文件（规则 ADR-003）；
- 不得写成 `.scratch/<目录>/adr/*.md` 路径（规则 ADR-004）。

第 1 条（编号唯一）已经保证裸编号不会指错，因此不要求每条注释都补全路径——`src/` 与 `migrations/` 现有 81 行注释含裸编号引用，逐个补路径会让注释长度翻倍而信息量不增。

仓外 ADR 引用（`ADR-001 D-010` / `D-011`，本仓不存）由门禁豁免名单放行，保留原样。

### 3. `.scratch/` 中已被代码引用的决策

- `.scratch/microfeed-rbac/adr/0002-version-enforcement-integer-code.md` → 提升为 `docs/novel-cms/adr/0019-version-enforcement-integer-code.md`
- `.scratch/microfeed-rbac/adr/0005-version-gate-scope.md` → 提升为 `docs/novel-cms/adr/0020-version-gate-scope.md`
- `.scratch/microfeed-rbac/adr/0008-backward-compat-policy.md` → 提升为 `docs/novel-cms/adr/0021-backward-compat-policy.md`
- `.scratch/microfeed-rbac/adr/0009-gate-floor-vs-prompt.md` → 提升为 `docs/novel-cms/adr/0022-gate-floor-vs-prompt.md`

`.scratch/` 原文保留不动，docs 版本为规范副本。

### 4. 无源 ADR 的补齐

`ADR-0023 应用端登录日志` 无任何源 ADR，从 `migrations/0084` `migrations/0085` 与代码事实重写。

## 后果

- 正：`src/` `migrations/` 中任一 `ADR-00NN` 引用都能唯一对应 `docs/novel-cms/adr/` 目录下的一个文件
- 正：`.scratch/` 可自由重写，不影响生产引用
- 正：门禁 `scripts/check-adr.ts` 可强校验「引用编号在 docs 目录下存在」
- 负：一次性改写 97 处引用编号（详见 `.scratch/adr-cleanup/ref-index.md`）
- 负：仓外 ADR（`ADR-001 D-010/D-011`）永久悬空，门禁需豁免

## 替代方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| 采纳：单一编号空间，注释用裸编号 | 编号唯一、门禁可强校验、注释短 | 一次性 81 行改写 |
| 分目录：`docs/adr/rbac/` `docs/adr/db/` | 主题清晰 | 门禁需按目录前缀匹配，复杂度上升 |
| 保留多空间：代码注释写全路径 | 无需改写现有引用 | 单行 60+ 字符，可读性下降；且 `.scratch/` 可反复重写，路径会失效 |
