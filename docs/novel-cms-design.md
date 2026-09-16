# microfeed 改造为「小说站 CMS」完整设计方案

> 状态：设计评审完成（2026-09-16 经 grill-with-docs 评审，决策见 §11 + `docs/novel-cms/adr/`）。
> 目标：把 microfeed（RSS/Atom 发布引擎）改造成「前端展示、后端管理」的小说站 CMS，支持分类、书、章节管理，以及带留痕的内容审核；并且**不碰上游核心、不影响后续版本升级**。
> 参考站点：番茄小说 fanqienovel.com（首页/书详情/阅读页布局）。

---

## 1. 目标与边界

| 项 | 内容 |
|---|---|
| 前端（展示） | 书主页、分类页、书详情页、阅读页、搜索（含章节正文检索，见 G5） |
| 后端（管理） | 分类管理、书（Channel）管理、章（Item）管理、内容审核、举报下架 |
| 硬约束 | 不影响 microfeed 后续版本升级（见 §2 四条铁律） |
| 明确不做 | 不重写核心 Worker/渲染管线；不改动公开 API 契约 SSOT（`ApiSchemas.ts` / `OpenApiDocument.ts`） |

---

## 2. 升级安全总原则（四条铁律）

1. **新表全用 `ext_*` 命名空间 + 高序号加性迁移**。microfeed 迁移是 `CREATE TABLE IF NOT EXISTS` + 顺序号（当前已到 `0022`），我们的扩展表用 `0023+`，表名/列名不会与上游未来任何对象重名，升级时多跑这几个迁移文件即可。
2. **不碰 `ApiSchemas.ts` / `OpenApiDocument.ts`**（API 契约 SSOT）。审计/审核是 admin 内部数据，不进公开 API，完全避开契约风险。
3. **快照/差异存 `data` 相关字段**，上游将来改 item 结构，历史审计里的旧内容依然完整有效，不会被"撕掉"。
4. **公共展示全走 `themes/feed-zh/*.mustache`**，与核心零冲突。

> 唯一雷区：若将来让"独立前端工程（Vue SPA）"读到审核状态，才会逼你动 `_microfeed` 透传或 SSOT —— 届时再单独评估，本方案先不碰。

---

## 3. 实体映射总表

| 小说概念 | microfeed 已有/新建 | 落点 | 升级风险 |
|---|---|---|---|
| 分类（题材） | **新建 `ext_category` 表** + `channels.genre` 真实列 | 命名空间隔离 + 加性列 | 中 |
| 书 | **Channel** | 复用，`_microfeed` 加字段 | 低 |
| 卷 | `_microfeed.volume` 标签分组 | 不建表 | 低 |
| 章 | **Item** | 复用，`_microfeed` 加字段 | 低 |
| 书架/书主页 | Channel 列表（首页 feed） | 主题模板 | 零 |
| 书详情页 | Channel 页（item 列表=章节列表雏形） | 主题改造 | 零 |
| 阅读页 | `web-item.mustache`（已存在） | 主题改造 | 零 |
| 内容审核 | `items.review_status` 列 + **新建 `ext_content_audit` 表**（diff+检查点） | 真实列 + 表 | 中 |
| 举报/下架 | **新建 `ext_content_report` 表** | 命名空间隔离 | 中 |
| 多级角色 | v1：单管理员（无隔离）；扩展：`ext_role` 表+中间件 | 命名空间/中间件 | 中（非 v1） |

---

## 4. 数据模型设计

### 4.1 现有基础（已核实）

- `items` / `channels` 整篇内容存在 `data TEXT` 这个 JSON 列（文档型存储，`migrations/0001_initial.sql`）。
- `apiItemInputSchema` / `apiChannelInputSchema` 均为 `.loose()` 且带 `_microfeed: z.record(z.string(), z.unknown())` —— 官方预留的"扩展口袋"，放扩展字段**不校验、不报错、不动 Schema**。
- **内容持久化 = D1 数据库，非文件**（已核实：`FeedDb._putItemToContentStatement` / `_putChannelToContentStatement` 均 `JSON.stringify(data)` 写入；无内容从文件读取的代码）。见 ADR-0001。

### 4.2 `_microfeed` 扩展字段定义

**Item（章）**
```ts
_microfeed: {
  volume?: string;       // 卷名，用于分组
  chapterNo?: number;    // 章节序号
  order?: number;        // 手动排序（默认按 date_published）
  wordCount?: number;    // 字数
  reviewStatus?: "draft" | "submitted" | "approved" | "rejected";  // 同时镜像到 items.review_status 列（供查询，见 ADR-0004）
  takedown?: boolean;    // 下架标记
}
```

**Channel（书）**
```ts
_microfeed: {
  serialStatus?: "serializing" | "finished";  // 连载中/完结
  signStatus?: "signed" | "unsigned";         // 签约状态
  genre?: string;        // 主分类，关联 ext_category.id；同时镜像到 channels.genre 列（供查询，见 ADR-0004）
  tags?: string[];       // 多个自由标签（单主分类 + 多标签模型，见决策 Q6）
}
```

### 4.3 新增表 SQL（加性迁移，文件 `migrations/0023_ext_novel.sql` 等）

```sql
-- 分类（题材）
CREATE TABLE IF NOT EXISTS ext_category (
  id VARCHAR(11) PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  parent_id VARCHAR(11),          -- 支持二级分类
  sort INTEGER DEFAULT 0,
  visible INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 内容审核留痕（核心需求：原始/修改/时间/谁/改了什么）
-- 存储模型：字段级 diff + 周期性检查点（见 ADR-0003）。
-- 常规行存 diff_data（字段级差异）；每 K 次编辑的检查点行额外存 checkpoint_data（完整快照）。
CREATE TABLE IF NOT EXISTS ext_content_audit (
  id VARCHAR(11) PRIMARY KEY,
  item_id VARCHAR(11) NOT NULL,
  channel_id VARCHAR(11),
  action TEXT NOT NULL,           -- create/edit/submit/approve/reject/takedown/restore/auto_flag
  actor_type TEXT NOT NULL,       -- admin/author/reviewer/system
  actor_id TEXT,
  diff_data TEXT,                 -- 字段级差异 JSON（标题/正文/卷章号/标签逐字段增删改）；常规行非空
  checkpoint_data TEXT,           -- 完整 data 快照；仅检查点行非空（恢复任意旧版的重建起点）
  is_checkpoint INTEGER DEFAULT 0,-- 1 = 检查点行
  review_status TEXT,             -- 该次动作后的审核状态
  reason TEXT,                    -- 驳回/下架理由
  created_at INTEGER NOT NULL     -- 何时改（毫秒时间戳）
);
CREATE INDEX IF NOT EXISTS idx_audit_item ON ext_content_audit(item_id, created_at);

-- 读者举报
CREATE TABLE IF NOT EXISTS ext_content_report (
  id VARCHAR(11) PRIMARY KEY,
  item_id VARCHAR(11) NOT NULL,
  channel_id VARCHAR(11),
  reporter_type TEXT NOT NULL,    -- anonymous/account
  category TEXT,                  -- 淫秽/侵权/其他
  detail TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_status ON ext_content_report(status);

-- 角色（仅 v1 之后的扩展用；v1 不建，见 ADR-0002）
-- CREATE TABLE IF NOT EXISTS ext_role (
--   id VARCHAR(11) PRIMARY KEY,
--   account_id TEXT,
--   channel_id VARCHAR(11),
--   role TEXT NOT NULL,             -- author/reviewer
--   created_at INTEGER NOT NULL
-- );

-- 加性列：在核心表上新增查询列（见 ADR-0004；属加性改动，升级安全，不与上游冲突）
-- ALTER TABLE items ADD COLUMN review_status TEXT;
-- CREATE INDEX idx_items_review_status ON items(review_status);
-- ALTER TABLE channels ADD COLUMN genre TEXT;
-- CREATE INDEX idx_channels_genre ON channels(genre);
```

---

## 5. 前端展示层（A 路线：纯主题，零冲突）

书/章/分类的**公共展示全部走 `themes/feed-zh/` 的 mustache 模板**，纯静态、零构建、与核心零冲突。对照番茄小说布局：

| 番茄页面 | microfeed 落点 | 改造要点 |
|---|---|---|
| 首页/精选 | `web-feed.mustache` | 改造成"精选书单 + 分类导航"；书=channel 列表 |
| 分类页 | **新增路由或 query 页** | 按 `channels.genre` 列过滤 channel（书）。注意：新 admin/公开路由属"中"风险，需 rebase |
| 书详情页 | Channel 页（现有把 item 当 feed 列出，即"章节列表"雏形） | 加封面/简介/作者/标签/连载状态头图；章节按卷（`_microfeed.volume`）分组 |
| 阅读页 | `web-item.mustache`（已存在） | 正文 + 上一章/下一章 + 目录抽屉 + 阅读设置（字号/背景/进度） |
| 搜索 | `web-search.mustache`（已有） | 按书名 / 作者 / **章节正文**检索（G5 改进：复用 `content_text` 列） |

> 现有模板文件已确认存在：`web-feed.mustache`、`web-item.mustache`、`web-page.mustache`、`web-search.mustache`、`web-header.mustache`、`web-body-start/end.mustache`。

---

## 6. 后端管理层

### 6.1 分类管理页（新 admin 路由）
- 新增 admin 路由（如 `[adminPath]/categories`），增删改 + 排序 + 展示开关。
- 书采用「**单主分类 + 多标签**」模型（决策 Q6）：`_microfeed.genre` 绑一个 `ext_category.id`（主分类，镜像到 `channels.genre` 列供筛选），`_microfeed.tags` 存多个自由标签（如 热血/升级/剑道）。

### 6.2 书管理（Channel）
- 复用现有 Channel 设置（标题/简介/封面/作者/语言）。
- 在保存处补 `_microfeed` 字段：连载状态、签约状态、分类 ID、标签；同步写 `channels.genre` 列。
- 核心改动很小（仅 Channel 表单加扩展字段）。

### 6.3 章管理（Item）
- 复用 `src/components/admin/items/EditItemApp/index.tsx`（已确认路径）做章节编辑（草稿/发布）。
- 最小改造：加"卷 / 章号"输入框（写入 `_microfeed.volume` / `chapterNo`）。
- **批量导入（决策 Q5）**：后台"txt 分章导入"工具**同时支持两种来源**——① 粘贴文本框（作者粘入 txt，按空行/标题正则切章，零额外依赖）；② 文件上传（存 R2 后解析，需启用 R2）。逐条调 API 建 item。
- 手动排序：默认按 `date_published`，手动序扩展 `_microfeed.order`。

### 6.4 卷章管理可行性（标签方案，已定）
**章节管理 = 免费复用**：章即 item，microfeed 原生提供 增 / 删 / 改、草稿 / 发布、条目列表分页。只需在 `EditItemApp` 多两个输入框（卷名、章号），写入 `_microfeed.volume` / `chapterNo`。即"章管理"开箱即得，无需新建任何东西。

**卷管理 = 后台"卷聚合"UI（无需建表）**：卷不是独立实体，只是每章身上的一个字符串标签。新建一个 admin 路由（落在你的 `ext` 层），它做三件事：
1. 读某本书（channel）下的全部 item，按 `_microfeed.volume` 聚合成"卷 → 章列表"；
2. 支持：把某章划入某卷（写该 item 的 `volume`）、卷内 / 卷间调整章顺序（写 `chapterNo` / `order`）、改名（把带该卷名的所有 item 的 `volume` 批量改写为新名）；
3. 卷的展示顺序：默认按"该卷首章的 `chapterNo`"排；若要显式卷序，加 `_microfeed.volumeOrder`（仍是标签，不建表）。

**标签方案能做到的**：卷章的归组、调动、改名、排序——全部可实现，且零新表、零 schema 改动、升级零冲突。
**标签方案不做的事（本期决定）**：不建独立卷详情页（`ext_volume` 表），卷无自己的资料页（卷封面 / 卷简介 / 卷独立 URL）。如未来确需，再升级为 `ext_volume` 表（中冲突，命名空间隔离），把 `volume` 标签映射成 `ext_volume.id` 即可，历史数据平滑迁移。

---

## 7. 内容审核系统（重点）

### 7.1 状态机
```
draft(未提交) → submitted(待审) → approved(通过) / rejected(驳回+理由)
配合 item.status：unpublished(草稿) ↔ published(公开)
```
- 作者保存 = `reviewStatus=draft`，或提交即 `submitted` 进审核。
- 审核员通过 = `reviewStatus=approved` + `status=published`。
- 驳回 = `reviewStatus=rejected` + `reason` + `status=unpublished`。
- 恢复 = 定位目标版本之前最近的**检查点**（`checkpoint_data` 完整快照）→ 向前**重放 diff** 序列重建目标版本 `data` → 回填 item（见 ADR-0003，diff-only 模型下不再直接回填 before_data）。

### 7.2 留痕表 `ext_content_audit`（你要的五要素）
存储模型 = **字段级 diff + 周期性检查点**（决策 Q3+Q4，见 ADR-0003）：常规行存 `diff_data`（字段级差异），每 K 次编辑的检查点行额外存 `checkpoint_data`（完整 `data` 快照）。这样既满足"原始/修改/时间/谁/改了什么"的完整追溯，又避免全量快照无限膨胀。

| 字段 | 记录什么 | 对应要求 |
|---|---|---|
| `diff_data` | 本次修改的字段级差异 JSON（标题/正文/卷章号/标签逐一比对） | **原始 vs 修改后 的变化** |
| `checkpoint_data` | 仅检查点行非空：完整 `data` 快照 | **任意旧版重建的起点** |
| `created_at` | 毫秒时间戳 | **什么时候改** |
| `actor_type`+`actor_id` | 管理员/作者/审核员/系统 | **谁改的** |
| `action`+`reason` | 动作 + 理由 | **改了什么** |

> "改了什么"展示：直接渲染 `diff_data` 的字段级差异（高亮增删改）；"恢复任意旧版"见 §7.1（检查点 + diff 重放）。

### 7.3 写入拦截点（精确落点）
- 实际写库位置：`src/server/feed/FeedDb.ts` 的 `_putItemToContentStatement`（第 558 行，第 609 行调用）。
- **推荐拦截点**：`src/server/api/handlers.ts` 的 item PUT/POST 处理器（`apiItemInputSchema.safeParse` 在 596 / 669 / 721 行）。在解析出新 `data` 后、落库后，调用：
  ```ts
  await extContentAudit.record({
    itemId, channelId, action: "edit",
    actorType, actorId,
    diff: computeDiff(existingItem?.data, newData),  // 字段级 diff
    isCheckpoint: shouldCheckpoint(itemId),           // 每 K 次为 true
    checkpointData: shouldCheckpoint(itemId) ? newData : null,
    reviewStatus: newData._microfeed?.reviewStatus,
    reason: null, createdAt: Date.now(),
  });
  ```
- 逻辑收口到独立模块 `src/server/feed/extContentAudit.ts`；**核心唯一改动点即 handlers.ts 里这一处调用**，rebase 风险最小。
- 同一写入点顺带把 `reviewStatus` / `genre` 镜像进 `items.review_status` / `channels.genre` 列（供查询，见 ADR-0004）。

### 7.4 审核队列页 + 审计详情
- 审核队列：`SELECT * FROM items WHERE review_status='submitted'`（已落成真实列，见 ADR-0004）；举报队列查 `ext_content_report WHERE status='pending'`。
- 审计详情页（新 admin 路由）：列出某 item 的全部审计行（时间/谁/动作），点开渲染 `diff_data` 的**字段级差异高亮**（原始 vs 修改）。

### 7.5 违规内容安全筛查（可选，与"修改留痕"是两件事）

> ⚠️ **澄清（2026-09-16 用户纠正）**：本方案要求的"审核"= **内容修改留痕**（§7.2–7.4 的 `ext_content_audit` 前后 diff + 检查点），用于回答"原始内容 / 修改后内容 / 何时改 / 谁改 / 改了什么"。
> 它**不是**敏感词 / 违规内容筛查。下列"机审"是另一件**可选**的事（内容安全），本次需求**未要求**，降级为 Phase 4 可选，整段可跳过，不影响"修改留痕"审核。

- 在 item 写入口接关键词预筛或第三方文本审核 API，命中可疑 → 标 `submitted` + 记一条 `auto_flag` 审计，转人工。
- 若不需要内容安全筛查，直接不实现即可。

### 7.6 举报与下架
- 读者匿名举报表单 → 写 `ext_content_report` → 进审核队列。
- 后台"违规下架"：置 `status=unpublished` 或加 `_microfeed.takedown=true`，并记一条 `takedown` 审计。

### 7.7 角色体系（v1 单管理员，扩展预留）
- **v1（已定，ADR-0002）**：采用单管理员模型——所有作者/编辑共用同一后台登录（或同一把全局 API Key），**不做按书隔离**。零额外代码，最快上线，升级最稳。
  - 依据：microfeed 的 `ApiKeyRecord.scopes` 仅 `["content:read","content:write"]`，**无 channel 绑定**（核实 `src/shared/Api.ts`），原"API Key 按 channel 授权"方案不可行，已弃用。
  - 账户模型为单管理员（`auth_account` 单条登录），无原生多作者/多角色。
- **扩展路径（v1 之后）**：当真实需要"作者只能改自己书 / 审核员能审"时，再按 `ext_role` + handler 层守卫实现，不阻塞 v1。

---

## 8. 文件落点清单与冲突分级

| 落点 | 文件 | 风险 | 说明 |
|---|---|---|---|
| 主题展示 | `themes/feed-zh/web-feed.mustache`、`web-item.mustache`、`web-search.mustache`、新增分类页 | **零** | 完全隔离 |
| 扩展字段 | `src/shared/ApiSchemas.ts` 的 `_microfeed`（不改结构，仅使用） | 低 | 契约已支持 |
| 查询列 | `items.review_status` / `channels.genre`（加性 ALTER，见 ADR-0004） | 低（加性） | 不与上游冲突 |
| 章录入 | `src/components/admin/items/EditItemApp/index.tsx` | 中 | 动核心，需 rebase |
| 写入拦截 | `src/server/api/handlers.ts`（596/669/721 行附近）+ 新建 `src/server/feed/extContentAudit.ts` | 中 | 单点调用 + 独立模块 |
| 新表 | `migrations/0023_ext_novel.sql` 等 | 中 | 命名空间隔离 |
| 分类/审核/举报页 | 新 admin 路由 | 中 | 命名空间隔离 |
| 角色中间件 | `src/server/**` 中间件（仅 v1 之后扩展） | 中 | 非 v1 |
| **SSOT** | `ApiSchemas.ts` 顶层 / `OpenApiDocument.ts` | **高（避开）** | 不碰 |

---

## 9. 实施分期（建议）

- **Phase 0 — 数据底座**：新建 `ext_*` 表迁移（0023+）；定义 `_microfeed` 字段；`items.review_status`/`channels.genre` 加性列迁移；`extContentAudit.record()` 模块骨架（diff 计算 + 检查点）。
- **Phase 1 — 前端展示（最快见效果，零冲突）**：改造 `themes/feed-zh` 的 web-feed / channel 详情 / web-item / web-search + 分类页。
- **Phase 2 — 后端录入**：分类管理页（单主分类+多标签）；Channel 表单加 `_microfeed`；EditItemApp 加卷/章号；txt 批量导入（粘贴+上传 R2 双来源）；`channels.genre`/`items.review_status` 加性列迁移。
- **Phase 3 — 内容审核**：状态机 + 写入拦截留痕（diff+检查点模型）+ 审核队列页（按 review_status 列查）+ 审计详情（diff 高亮）+ 举报下架。
- **Phase 4 — 进阶（本期均不做）**：机审内容安全筛查（§7.5，与修改留痕无关，本次不做）、`ext_role` 多级角色（v1 采用单管理员，见 ADR-0002，属 v1 之后扩展）、阅读计数 / 排行榜（`ext_view_count`，不做）、独立卷详情页（`ext_volume`，不做）。

---

## 10. 验证方式

- **类型**：`tsc --noEmit` 全量 0 错误（托管 Node）。
- **迁移**：在测试实例跑 `0023+` 迁移，确认 `ext_*` 表与 `items.review_status` / `channels.genre` 列创建成功、与上游表/列无冲突。
- **审核走查（手动）**：作者提交 → 审核员驳回（填理由）→ 查 `ext_content_audit` 见 `diff_data`/`checkpoint_data`/`created_at`/`actor`/`reason` 齐备 → 恢复（从检查点 + diff 重放重建旧版）→ 确认内容回到目标版本。
- **升级演练**：在 fork 上 `git fetch` 上游、`rebase` 最新，确认冲突仅集中在 `EditItemApp` 与 item 模型这两处，范围可控。
- **i18n（若后台文案要中文化）**：复用既有 `src/shared/i18n` 命名空间 + `t()`，不新增耦合。

---

## 11. 决策点（已定 / 待定）

**已定（2026-09-16，经 grill-with-docs 评审）**：
1. **前端路线 = A（纯 `themes/feed-zh` 主题）**：零冲突、零额外工程，升级最稳。
2. **"审核"含义 = 内容修改留痕**（非敏感词筛查）：机审降级为可选 add-on（§7.5），本次不做。
3. **作者隔离 = v1 单管理员**，预留多角色扩展（决策 Q1，见 ADR-0002）；原"API Key 按 channel 授权"经代码核实不可行（microfeed API Key 无 channel 绑定），已弃用。
4. **卷管理 = `_microfeed.volume` 标签分组**（不建表）；分类模型 = **单主分类 + 多标签**（决策 Q6）。
5. **查询模型（修正 G2）**：`review_status` / `genre` 落成 `items` / `channels` 真实列 + 索引（决策 Q2，见 ADR-0004）；原设计 `WHERE _microfeed.xxx` 为无效 SQL，已修正。
6. **留痕存储 = 字段级 diff + 周期性检查点**（决策 Q3+Q4，见 ADR-0003）；可回到任意旧版，存储有界。
7. **批量导入 = 粘贴文本框 + 文件上传(R2) 双来源**（决策 Q5）。
8. **内容持久化 = D1 数据库（非文件）**（见 ADR-0001），满足"必须进 DB"硬要求。

**仍开放**：无。阅读计数排行（`ext_view_count`）与独立卷详情页（`ext_volume`）、机审、多级角色（`ext_role`，属 v1 之后扩展）均不做/暂缓。

**决策记录索引**：详见 `docs/novel-cms/adr/` 下 ADR-0001～0004 与 `docs/novel-cms/CONTEXT.md`（领域术语表）。

---

## 12. 测试模拟数据（用于预览方案实现效果）

为了让方案"看得见"，下面给出一套可灌入测试实例的模拟数据：一本书《星河剑歌》+ 2 卷 3 章 + 1 条修改留痕 + 1 条举报。灌入后，前端主题改造（Phase 1）与审核页（Phase 3）即可直接看到效果。

### 12.1 分类（ext_category）

| 字段 | 值 |
|---|---|
| id | `cat_x1` |
| name | 东方玄幻 |
| slug | `eastern-fantasy` |
| parent_id | NULL |
| sort | 1 |
| visible | 1 |
| created_at | 1700000000000 |

### 12.2 书（Channel，整篇存于 `channels.data` JSON；`genre` 同步写 `channels.genre` 列）

```json
{
  "title": "星河剑歌",
  "description": "少年陆尘持一柄断剑，自边陲小城走出，踏碎星河。",
  "icon": "https://example.com/cover/xinghe.jpg",
  "authors": ["墨青"],
  "language": "zh-CN",
  "genre": "cat_x1",
  "_microfeed": {
    "serialStatus": "serializing",
    "signStatus": "signed",
    "genre": "cat_x1",
    "tags": ["热血", "升级", "剑道"]
  }
}
```

### 12.3 章（Item，整篇存于 `items.data` JSON；`reviewStatus` 同步写 `items.review_status` 列）

**第1章（第一卷）**

```json
{
  "title": "第一章 边陲小城",
  "content_html": "<p>晨雾未散，陆尘已站在城头……</p>",
  "date_published": "2026-01-10T09:00:00Z",
  "status": 1,
  "review_status": "approved",
  "_microfeed": { "volume": "第一卷 初入江湖", "chapterNo": 1, "order": 1, "wordCount": 3120, "reviewStatus": "approved" }
}
```

**第2章（第一卷）**

```json
{
  "title": "第二章 断剑之秘",
  "content_html": "<p>陆尘指尖拂过断剑……</p>",
  "date_published": "2026-01-11T09:00:00Z",
  "status": 1,
  "review_status": "approved",
  "_microfeed": { "volume": "第一卷 初入江湖", "chapterNo": 2, "order": 2, "wordCount": 2980, "reviewStatus": "approved" }
}
```

**第1章（第二卷，待审）**

```json
{
  "title": "第二卷 第1章 星河觉醒",
  "content_html": "<p>夜幕降临，剑鸣自丹田响起……</p>",
  "date_published": "2026-02-01T09:00:00Z",
  "status": 0,
  "review_status": "submitted",
  "_microfeed": { "volume": "第二卷 星河初现", "chapterNo": 1, "order": 1, "wordCount": 3400, "reviewStatus": "submitted" }
}
```

### 12.4 内容修改留痕（ext_content_audit，diff + 检查点模型）

以"第2章"被作者修改为例（对应你要的"原始 / 修改后 / 何时 / 谁 / 改了什么"）：

| 字段 | 值 |
|---|---|
| id | `aud_01` |
| item_id | `itm_c2`（第2章） |
| channel_id | `chn_book1` |
| action | `edit` |
| actor_type / actor_id | `author` / `apikey_author_li` |
| diff_data | 字段级差异：正文第1段 `<p>陆尘握紧断剑……</p>` → `<p>陆尘指尖拂过断剑……</p>`；`reviewStatus` approved→submitted |
| checkpoint_data | NULL（本行为常规 diff 行，非检查点；检查点行每 K 次编辑才出现） |
| is_checkpoint | 0 |
| review_status | `submitted` |
| reason | NULL |
| created_at | 1704000000000 |

> 审核页"前后对比"直接渲染 `diff_data`：标题无变化、正文第1段变更、`reviewStatus` 由 approved 变 submitted。

### 12.5 举报（ext_content_report）

| 字段 | 值 |
|---|---|
| id | `rpt_01` |
| item_id | `itm_c2` |
| channel_id | `chn_book1` |
| reporter_type | `anonymous` |
| category | 侵权 |
| detail | 疑似抄袭某书开头 |
| status | `pending` |
| created_at | 1704100000000 |

### 12.6 灌入与预览方式

- **最简灌入**：用 microfeed 公开 API 逐条 POST channel / item（`_microfeed` 与 `review_status`/`genre` 随 `data` 一起提交，因 schema 为 `.loose()` 不报错；`review_status`/`genre` 列由写入拦截点同步镜像）；分类 / 审核 / 举报用 `wrangler d1 execute` 跑 INSERT（表见 §4.3）。
- **效果验证点（对照 Phase 1 / Phase 3）**：
  - 前端 `web-feed.mustache` 改造后 → 首页出现"星河剑歌"书卡 + 分类导航"东方玄幻"。
  - 书详情页 → 按卷分组：`第一卷 初入江湖`（第1/2章）、`第二卷 星河初现`（第1章，标"待审"）。
  - 阅读页 `web-item.mustache` → 正文 + 上/下章导航。
  - 审核队列页 → `SELECT * FROM items WHERE review_status='submitted'` 列出"第二卷 第1章" + 举报 `rpt_01`（pending）。
  - 审计详情页 → 点"第2章"见 `aud_01`：时间 / 作者 / 动作 + `diff_data` 高亮。

---

## 13. 参考与依据（已核实）

- 数据模型：`docs/start-here/concepts.md`、`migrations/0001_initial.sql`（items/channels 用 `data TEXT` JSON 列）。
- 扩展口袋：`src/shared/ApiSchemas.ts` 的 `apiItemInputSchema`/`apiChannelInputSchema` 为 `.loose()` + `_microfeed`。
- 写库点：`src/server/feed/FeedDb.ts` `_putItemToContentStatement`（558/609）；item 处理器 `src/server/api/handlers.ts`（596/669/721）。
- 内容持久化核实：`FeedDb._putItemToContentStatement` / `_putChannelToContentStatement` 均 `JSON.stringify(data)` 写入；全仓库无内容从文件读取代码（Cloudflare Worker + D1，无持久文件系统）。
- API Key 模型：`src/shared/Api.ts` 的 `ApiKeyRecord.scopes` 仅 `["content:read","content:write"]`，无 channel 绑定 → 决策点 3 原方案不可行（见 ADR-0002）。
- 主题模板：`themes/feed-zh/*.mustache`（已确认存在）。
- 迁移序号：当前最大 `0022`，新表从 `0023` 起。
- 架构/边界：`AGENTS.md`、`CLAUDE.md`（核心分层 `src/server` / `src/client` / `src/shared`，SSOT 规则）。
- 番茄小说布局：`fanqienovel.com`（首页精选+男/女频+排行榜+题材分类）。
- 决策记录：`docs/novel-cms/adr/`（ADR-0001 内容持久化 / 0002 作者隔离 / 0003 留痕diff / 0004 查询列）；领域术语：`docs/novel-cms/CONTEXT.md`。
