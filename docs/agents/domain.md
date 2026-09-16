# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

This repo carries its domain glossary and ADRs in a **feature-isolated folder** to keep novel-CMS work separate from the upstream microfeed core (upgrade-safety):

- **`docs/novel-cms/CONTEXT.md`** — the ubiquitous-language glossary for the "microfeed → 小说站 CMS" effort.
- **`docs/novel-cms/adr/`** — ADRs for that effort (ADR-0001 内容持久化=D1 / 0002 作者隔离=v1 单管理员 / 0003 留痕=diff+检查点 / 0004 查询列=真实列+索引).
- **`docs/novel-cms-design.md`** — the settled design doc (status: 评审完成).

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure (this effort)

```
docs/novel-cms/
├── CONTEXT.md                 ← glossary (ubiquitous language)
├── adr/                       ← ADRs 0001–0004
└── (design doc lives at repo root: docs/novel-cms-design.md)
```

The rest of the repo (src/, themes/, migrations/) is upstream microfeed core — do not assume novel-CMS vocabulary there; reference `docs/novel-cms/CONTEXT.md` when naming concepts.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/novel-cms/CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0004 (查询列=真实列) — but worth reopening because…_
