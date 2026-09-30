# ADR-01 — 源模型映射（为什么不建表、两列索引列、派生关系）

- 状态：已采纳（2026-09-28）
- 关联：spec.md §5 / §5.2 / §5.3 / §16；issues 05、09
- 上游：fork of microfeed/microfeed（ctwh 分支），旧栈为 .NET + 关系库

## 背景（Context）

旧 ctwh 后端用一组关系表承载内容：`BookInfo`（典籍）、`Chapter`（篇章）、
`BookBody`/`Section`（条文）、`Fang`（方剂）、`Yao`（中药）、`MingCi`（名词），
外加 `BookBody.BieMing`、`Yao.YaoList`、`YaoAlias` 等别名源。迁移目标是
microfeed（Astro + Cloudflare Workers + D1 SQLite），且须保持线上小说（novel-cms）
内容不被破坏。

## 决策（Decision）

采用 **Approach E：不新建任何业务表**，全部复用现有通用模型：

| 旧实体 | 落点 | 说明 |
|---|---|---|
| 典籍 `BookInfo` | `channels`（一条典籍 = 一个频道） | `genre` 指向分类；书籍元数据存 `data._microfeed`（author/chengShu/case…） |
| 篇章 `Chapter` | `items`（`tcm_kind='chapter'`） | `book_id` = 典籍频道 id |
| 条文 `Section` | `items`（`tcm_kind='section'`） | `tcm_parent_id` = 所属篇章条目 id；`book_id` = 典籍频道 id |
| 方剂 `Fang` | `items`（`tcm_kind='fang'`） | `book_id` = 容器频道（方剂）；`_microfeed.sourceBookId` = 源典籍 id |
| 中药 `Yao` | `items`（`tcm_kind='yao'`） | `book_id` = 容器频道（本草） |
| 名词 `MingCi` | `items`（`tcm_kind='term'`） | `book_id` = 容器频道（名词） |
| 标记样式 | `ext_annotation_markers`（加 3 列） | 13 枚目录，App 端据此自行着色 |
| 分类（针灸/人纪） | `ext_category` | 由迁移 0072 种子 |
| 容器频道（方剂/本草/名词） | `channels`（`_microfeed.tcmContainer`） | 由迁移 0072 种子，无 `genre`，不进导航 |

`items` 表新增两列真实列：`tcm_kind TEXT`、`tcm_parent_id TEXT`，各带索引：
`items_tcm_kind_name (tcm_kind, json_extract(data,'$.title'))`、`items_tcm_kind_parent (tcm_kind, tcm_parent_id)`。

## 理由（Rationale）

1. **复用通用模型**：microfeed 的 `items` 已是内容载体，无需为中医另起炉灶。
2. **真实列而非 JSON 口袋**：dashboard 保存路径（`FeedDb._putItemToContentStatement`）
   会整体重写 `data` 的 8 个已知列，只活在口袋里的业务键一次编辑即丢；真实列不受影响。
   同时 JSON 路径条件无法走索引，而"某篇章的条文"（8066 行，App 主阅读查询）若无
   `tcm_parent_id` 索引就是全表扫描。
3. **源 int64 不落库**：旧 `ChapterId/BookInfoId/FangId/YaoId/ReceiptNo` 仅在导入脚本内存中
   用于推导 11 位确定性 id（sha256(kind+源id)→base62），落库只用 11 位 id；删除/重跑幂等。

## 后果（Consequences）

- 条文→篇章的父子关系**只能**走 `tcm_parent_id`，不能走 `book_id`：novel-cms 把 `book_id`
  读作"本书章节"，若把条文 `book_id` 标成篇章 id，条文会在小说侧冒充当章节。
- 标记跳转（`$u{}`/`$f{}`/`$g{}`）靠 `tcm_kind + title` 索引定位实体落地页。
- 方剂/本草/名词归属容器频道而非典籍频道，因此 `GetBookIdFang` 必须按 `_microfeed.sourceBookId`
  （源典籍 id）过滤，而非按频道 id——这是与直觉相反的一处（见 ADR-02）。
