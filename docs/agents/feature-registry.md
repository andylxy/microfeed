# 功能清单

阶段词表与登记规则见 `feature-log.md`。本表上限 30 行，只登记 `evaluating` / `implementing` / `dropped` 与 30 天内完成的项。

| 功能 | 阶段 | 起始 | 最近更新 | 完成 | 指针 |
| --- | --- | --- | --- | --- | --- |
| AGENTS.md 分册化 | done | 2026-10-26 | 2026-10-26 | 2026-10-26 | `.scratch/agents-md-opt/` |
| 单测 D1 端口替身收成一份 | evaluating | 2026-11-05 | 2026-11-05 | — | `.scratch/sqlite-test-double/` |
| 独立方剂模块（ADR-0065） | implementing | 2026-11-05 | 2026-11-05 | — | `.scratch/fang-yao-module/` |

## 维护说明

- 新增功能时在表尾加一行，阶段写 `evaluating`。
- 阶段变化时改「最近更新」，不写变更历史。进入 `done` 时填「完成」列，30 天从该日期算起；`done` 之后的优化只改「最近更新」。
- `done` 与 `accepted` 满 30 天、`dropped` 满 7 天，从表中移出。移出不代表删除，`.scratch/<slug>/` 与 git log 仍然保留。
- 历史功能没有批量回填。需要总览时跑 `node .scratch/agents-md-opt/aggregate-status.mjs`，它读 `.scratch/*/issues/*.md` 的 `**Status:**` 行，覆盖 24 个功能目录、195 条状态。
