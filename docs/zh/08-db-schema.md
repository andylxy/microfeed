---
title: 08 数据库规范
description: microfeed 的 Cloudflare D1 数据库规范：迁移文件、建表约定、索引、触发器、软删除。
---

# 08 数据库（D1）规范

> **用途**：新增/修改数据库表、索引、触发器，或做数据迁移时遵循本册。
> **触发词**：数据库、表结构、建表、迁移、索引、触发器、D1、schema、ALTER、D1 额度、全表扫描、查询优化、索引优化。
> **加载时机**：新增 `migrations/` 文件、改表结构、或排查数据层问题时读取本册。

- **迁移文件**：位置 `migrations/`；命名 `NNNN_snake_case.sql`，4 位零填充递增（下一个编号以 `migrations/` 里现有的最大编号为准，不在这里写具体数字）。**只追加，不改历史**。
- **应用命令**：本地 `yarn migrate:local`（`wrangler d1 migrations apply FEED_DB --local`）；部署时管理引擎自动应用。**改动 D1 后必须清相关缓存并重启 dev server**（miniflare 缓存持久化在文件里）。
- **建表约定**（照 `0001_initial.sql`、`0017_webhooks.sql` 风格）：
  - 主键：内容表 `id VARCHAR(11) PRIMARY KEY`；配置/端点类用 `TEXT PRIMARY KEY`。
  - 时间戳：`created_at` / `updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`。
  - 软删除：可空 `deleted_at TIMESTAMP`，业务查询用 `deleted_at IS NULL` 过滤。
  - 灵活字段：常用 `data TEXT`（JSON 文本列）。
  - 备用字段：**常备 `ext1`~`ext10` 扩展槽位**。所有新建表建表即预留这 10 个可空类型化列；修改既有表时，若缺 `ext1`~`ext10`，本迁移用 `ALTER TABLE ADD COLUMN` 一并补齐；已存在则跳过。用途：后续新增字段直接写 ext 槽位，不必每次改表。现状：全仓 `migrations/` 目前 **0 支迁移**带 `ext1` 列（`grep -l "ext1" migrations/*.sql` 命中 0），既有多数表尚未回填——自本规则起，新建表即预留、修改表缺则补齐，历史表不强制一次性回填。
  - **运行态表例外**：按窗口或保留期过期的行（如 `ext_rate_limit`）不建 `created_at` / `updated_at`，也不建软删除列——它的生命周期由 `expires_at_ms` 一列表达，补时间戳只会给写热表多带两列负载。**此例外仅豁免时间戳与软删除列，不豁免 `ext1`~`ext10` 常备槽位**：运行态热表同样按上方规则常备（`ext_rate_limit` 已由 0167 补齐）。
  - 索引：每条查询路径都建 `CREATE INDEX IF NOT EXISTS <table>_<col> ON <table>(<col>...)`。
  - 业务约束/上限：`CREATE TRIGGER IF NOT EXISTS ... BEFORE INSERT ... WHEN ... BEGIN SELECT RAISE(ABORT, '<code>'); END;`（如 `webhook_endpoint_limit_insert`，20 条上限）。
  - 状态枚举：`status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (...))`，或 `TINYINT`。
- **SQL 字面量上限（通用约束）**：D1 单条 SQL 语句的字面量长度上限**实测约 100KB**。**严禁**把大列（如 `bundle_json`、`preview_fixture_json`）用模板插值拼进 SQL 字面量；大列一律经**绑定参数**（`?` 占位）传入，整行数据用单条 `INSERT` 写入，不做为绕过上限而做的分块 `UPDATE`。
- **数据导入通道必须用绑定参数**（同步场景的完整条文与主题安装确认清单一并见 `docs/agents/d1-sync.md`）：一切向 D1 导入数据行的路径（本地→远程同步、整库覆盖、差量补推、主题安装 / 发布 / 草稿、`.scratch` 下的一次性脚本）都用绑定参数——SQL 文本只写 `?` 占位，值经 `.bind(...)` / `queryD1WithParameters(...)` / D1 REST `{sql, params}` 传递。**绑定参数不计入 SQL 语句文本长度**：2026-11-09 真库实测 `themes.bundle_json` 最大 121,180 B、整行序列化最大 141,169 B，均超过单语句约 100KB 上限，但走 `params` 时一条 `INSERT` 即可入库，不触发 `SQLITE_TOOBIG`。把大列拼成 SQL 字面量（`VALUES ('<大列文本>')`）以及「占位 INSERT + 分块 UPDATE 拼列」属历史应急通道，不作为常规方案。
- **静态种子迁移是例外通道**：`wrangler d1 migrations apply` 读的是 SQL 文件，只有 `{sql}`、没有 `params`，因此 100KB 上限对它是硬约束；文件内按 **<80KB 分块**（实测 41 支待应用迁移共 268 条语句、最长 81,842 B，均在 100KB 内）。判断迁移是否超限须按 SQL 词法切分：逐字符跟踪单引号字符串（`''` 转义）、跳过 `--` 行内注释，只在字符串外的 `;` 处切分；**不要用 `/;\s*\n/` 正则**，seed 迁移每条 INSERT 结尾常是 `'); -- 行内注释`，会被合并误报超限。
- **安装或同步主题前的确认清单**（三条全满足才通过）：① 写库 SQL 文本只有 `?` 占位、无大列字面量；② 全部值（含 `bundle_json`、`preview_fixture_json`）经绑定参数；③ 预期一条 INSERT 入库，不出现为绕开文本长度上限而做的分块 UPDATE。不满足先改造通道再执行。
- **注意**：不要手改已发布的迁移；新需求用新迁移（含 `ALTER TABLE`）；迁移里的触发器/检查约束是业务规则，改动需同步契约与测试；本地改库造场景后要**还原**，避免污染后续联调。

## D1 额度与全表扫描治理（资源保护）

> D1 的读写额度是**宝贵资源**：远程 D1 每天读取 5M 行、写入 100K 行，耗尽当天即不可用。所有查询必须珍惜额度、避免浪费。

### 远程 D1 每日额度
- **读取额度**：每天 **5M 行**（`rows_read`）。本项目部署在 Cloudflare Workers 上，业务查询全部走远程 D1；读取额度耗尽当天即不可用。
- **写入额度**：每天 **100K 写入行数上限**（`rows_written`，即 `INSERT` / `UPDATE` / `DELETE` 的影响行数）。它与 5M 读取额度**相互独立**：读没爆也可能写爆。
- **写爆后果**：整库覆盖 / 派生索引重建等大批量写会迅速打爆写额度；之后当天任何写（含 `migrations apply`、`manage deploy`）都会被拒（`[code:7500]`），直到 **UTC 次日 0 点**重置，读不受影响。
- **批量写前评估**：大批量写前先评估当日写额度，避免耗尽。

### 避免全表扫描（添加功能时）
- **添加功能时，必须避免全表扫描**：每个新查询先确认所走索引，把**预计扫描行数**与**读取字节数**写清楚再动手。
- **出现全表扫描时，必须给出修复方案**，并以**量化方式**显示：当前扫描行数、当前读取字节数、修复后预计读取字节数、所走索引或需新增的索引定义。
- **必查闭环**：本小节为**模块开发（分册 09）**与**功能修改（分册 11）**流程的**必查项**——新建/修改任何 D1 查询都必须执行上述检测，详见两册流程清单。
