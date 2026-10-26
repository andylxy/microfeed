# 功能记录：阶段与登记规则

功能清单在 `feature-registry.md`，本册只写规则。触发条件见 `AGENTS.md` 的触发表。

## 阶段词表

五个值，只用这五个，不造新词。

| 阶段 | 含义 | 退出条件 |
| --- | --- | --- |
| `evaluating` | 评估中：查可行性、比方案、估代价 | 结论写入 `spec.md` 的 `## 评估结论` |
| `implementing` | 实施中：代码与测试文件在写 | 代码写完、测试文件写完（不运行） |
| `done` | 已完成：改动已交还 | 用户手动触发门禁并通过 |
| `accepted` | 已验收：用户实际用过并确认可用 | 无 |
| `dropped` | 已放弃：评估后决定不做 | 无 |

`done` 与 `accepted` 分开：`done` 指代码写完并交还，`accepted` 指用户确认可用。两者之间可能隔着几天。

## 登记规则

- 登记 `evaluating` / `implementing` / `dropped`，以及 30 天内进入 `done` / `accepted` 的。
- `done` 与 `accepted` 满 30 天移出清单，`dropped` 满 7 天移出。移出不代表删除，`.scratch/<slug>/` 与 git log 仍然保留。
- 清单上限 30 行，超出时移出最旧的已完成项。
- 阶段变化时改「最近更新」列，不写变更历史。进入 `done` 时同时填「完成」列，30 天从该日期算起；`done` 之后的优化只改「最近更新」。

## Status 行写法

`.scratch/<slug>/issues/NN-*.md` 顶部写：

```
**Status:** done
```

半角冒号、加粗、行首、单独一行。需要补充说明时写在值后面，用括号括起来：

```
**Status:** done（2026-10-24 真机复验通过）
```

2026-10-26 实测磁盘上共 199 条 Status 行：行首半角 195 条、行首全角 4 条。聚合脚本只识别行首半角写法，报出 195 条；那 4 条全角需要手工改成半角后才会进入统计。

## 指针格式

清单的「指针」列写 `.scratch/<slug>/`，以斜杠结尾。方案细节、票据、探针输出都在该目录下。

## 查当前状态

```bash
node .scratch/agents-md-opt/aggregate-status.mjs
```

脚本读全部 issue 文件的 `**Status:**` 行，按功能聚合出分布。脚本本身在草稿区，会随 `.scratch/` 一起丢；丢失时按本册的写法重新写一个即可，逻辑只有一条：遍历 `.scratch/*/issues/*.md`，取 `**Status:**` 行的值，按目录聚合。

## 「改了什么」去哪查

| 层面 | 位置 | 进仓库 |
| --- | --- | --- |
| 代码 | `git log --oneline -- <path>` | 是 |
| 方案与取舍 | `.scratch/<slug>/spec.md` 的 `## 评估结论` | 否 |
| 单张票据的进展 | `.scratch/<slug>/issues/NN-*.md` 的 `**Status:**` 行 | 否 |
| 清单层面 | `feature-registry.md` | 是 |

草稿区丢失时清单仍在，能查到「有这个功能、到哪一步、去哪个目录找」。
