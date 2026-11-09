# ADR-0071: 移除零引用的孤儿数据层 extBook.ts

ADR-0069 退役 6 个 legacy 内容看板（f21961c 删除 `book-handlers.ts` / `volume-handlers.ts`，它们是 `extBook.ts` 的全部生产调用者）后，`extBook.ts` 的 11 个导出函数失去全部调用方，成为无活跃调用者的孤儿模块；它是 ADR-0069 决策 2「保留共享数据层」里唯一至今零引用的文件。本决策移除该文件与其配套单元测试；不删任何表、不删任何索引——`extBook.ts` 用到的 `items_book_id` / `items_book_kind` 是多个活跃模块共享的索引（`extCategory` / `reads.ts` / `admin-list` / App 书页仍在使用），移除本文件不影响它们的活跃性。

- 状态：Accepted（2026-11-09 实施完成；`tsc --noEmit` exit 0、`ext-book-status.test.ts` 20 通过、无残留 `feed/extBook` import；`extCategory.test.ts` 的失败为**预先存在**的 `cloudflare:workers` 环境问题——`extCategory.ts:5` 直接 import `app-cache` → `cache-control.ts` 的 `cloudflare:workers`，与本次移除无关，见「验证」）
- 关联：ADR-0069（决策 2「6 个 feed 数据层文件保留，只清理零引用函数」——本决策是 `extBook.ts` 的零引用清理到极致）、ADR-0070（同类孤儿清理，删 `extVolume`/`extFang`/`extTcmEntries`/`tcmSections` + 5 个无活跃调用索引）、迁移 0097 / 0102（`extBook.ts` 曾是单列索引的注释引用对象）
- 证据范围：本地真库只读探针 2026-11-09（`items` 19 显式索引 + 1 autoindex），代码调用链只读调查（`src/server/feed/*`、`src/server/cache/app-cache.ts`、`src/server/book-info/types.ts`、`src/server/ming-ci/types.ts`、`tests/unit/server/extBook.test.ts`）

## 背景

ADR-0069 退役的是 6 个看板的页面 / ajax / 组件 / handler。其决策 2 写明「6 个 feed 数据层文件与 5 张字典表保留，只清理其中零引用的函数」。实施时（f21961c）删除了 `book-handlers.ts` / `volume-handlers.ts`——这两者是 `extBook.ts` 的**全部**生产调用者（分别调用其 6 个与 1 个导出函数）。自此 `extBook.ts` 的 11 个导出函数全部零调用。

「保留文件」不等于「保留调用链」：`extBook.ts` 保留下来后从未被任何活跃代码重新接入。其「四写函数」（`createAdminBook` / `updateAdminBook` / `deleteAdminBook` / `purgeAdminBook`）正是 ADR-0069 风险表 #2 描述的 `channels.status` 写方——ADR-0069 第 113 行已裁定「接受冻结快照，不保留最小写入口」，即接受这些写函数零调用。

## 孤儿证据（多重）

| # | 证据 | 结论 |
|---|---|---|
| 1 | `src/` 全量 grep `server/feed/extBook` 的 import → 0 个生产调用者 | 11 个导出函数全零调用 |
| 2 | 唯一生产引用在 `dist/`（旧构建 `book-handlers_*.mjs` / `volume-handlers_*.mjs`），源文件已被 f21961c 删除 | 构建产物过期，非活跃引用 |
| 3 | `book-handlers.ts` / `volume-handlers.ts`（原调用者）在 f21961c（ADR-0069 实施）删除 | 调用链已断 |
| 4 | `app-cache.ts:269` / `GetBookIdFang.ts:13` 的「extBook 四写函数」注释无对应调用 | 注释过时 |
| 5 | 依赖不牵连：`bookWordCount` 仍被 `extCategory` / `FeedPublicJsonBuilder` 消费；`app-cache` / `extBookStatus` 有活跃消费；`book-info` / `ming-ci` 类型镜像自包含（不 import extBook） | 移除不破坏依赖方 |

## 决策

1. **移除 `src/server/feed/extBook.ts`**（零引用孤儿，文件无保留价值）。
2. **移除 `tests/unit/server/extBook.test.ts`**（测的是孤儿模块本身，不同步删则 tsc 找不到模块）。
3. **不删任何索引**：`extBook.ts` 用到的 `items_book_id`（`DELETE`/`COUNT` `WHERE book_id=?`）与 `items_book_kind`（`purgeBookChapterContentCaches` `WHERE book_id=? AND tcm_kind='chapter'`）是活跃共享索引（`extCategory` / `reads.ts` / `admin-list` / App 书页仍在读），移除本文件不改变其活跃性。
4. **文档同步**：ADR-0069 决策 2 加执行注记（6 个数据层文件的实际处置）；`docs/front-site-catalog-switch.md` 三处 `extBook.ts` 引用更新。

## 影响

- `items_book_kind` 的活跃查询集合从「fang-references 草稿 / App 书页最近更新 / extBook 章 id / reads 682」变为不含 extBook（其余 3 个不变）。
- `channels.status` 写方从「事实零调用」（运行时已无代码调用）变为「代码层面零写方」——行为不变，只是把 ADR-0069 第 113 行已接受的状态在代码里坐实。
- 若未来要恢复书籍管理看板，从 git 历史取回 `extBook.ts`（文件本身是领域知识，移除是刻意为之，非数据丢失）。

## 验证

- `tsc --noEmit` exit 0（25s）；`grep` 确认无残留 `feed/extBook` import。
- `ext-book-status.test.ts` 20 通过；`extCategory.test.ts` **0 test / 失败**，错误 `Cannot find package 'cloudflare:workers'`（`src/server/cache/cache-control.ts:18`）——**预先存在**：`extCategory.ts:5` 直接 `import {purgeAppNavCache} from "@/server/cache/app-cache"`，链到 `cloudflare:workers`（unit vitest 不提供该模块），与本次移除无关（删除前 HEAD 即失败，`app-cache`/`cache-control` 0 改动）。
- 备份（回滚点）：`.scratch/backups/extBook.ts.20261109`（17,693 B）+ `extBook.test.ts.20261109`（15,549 B）。
- 不跑全量门禁（按 AGENTS.md，门禁仅用户手动触发）。
