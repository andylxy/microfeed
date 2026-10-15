# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

The glossary lives at the repo root (`CONTEXT.md`); the ADRs for the novel-CMS effort stay in a **feature-isolated folder** to keep that work separate from the upstream microfeed core (upgrade-safety):

- **`CONTEXT.md`** (repo root) — the ubiquitous-language glossary: book structure (卷 / 篇章 / 条文 / 扁平条目 / 卷键 / 未归类桶), the D1 read-cost vocabulary (行读 / 整本读取 / 按需读取 / 全表扫描), and the admin authorization vocabulary.
- **`docs/novel-cms/adr/`** — ADR-0001 through ADR-0027 for that effort, one numbered space (0001 内容持久化=D1 / 0002 作者隔离=v1 单管理员 / 0003 留痕=diff+检查点 / 0004 查询列=真实列+索引 … 0025 卷作为一级阅读单位 / 0026 物理删除收敛为 purge 端点 / 0027 后台卷看板按需读取).
- **`docs/novel-cms/CONTEXT.md`** — the original microfeed→novel concept-mapping table, kept as history of the first pass.
- **`docs/novel-cms-design.md`** — the settled design doc (status: 评审完成).

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure (this effort)

```
CONTEXT.md                      ← glossary (ubiquitous language), repo root
docs/novel-cms/
├── CONTEXT.md                  ← original concept-mapping table
├── adr/                        ← ADR-0001 … ADR-0027
└── (design doc lives at repo root: docs/novel-cms-design.md)
```

The rest of the repo (src/, themes/, migrations/) is upstream microfeed core — do not assume novel-CMS vocabulary there; reference the root `CONTEXT.md` when naming concepts.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the root `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0004 (查询列=真实列) — but worth reopening because…_
