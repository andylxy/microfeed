@AGENTS.md

## Repository skills

When `AGENTS.md` instructs you to use a named skill, read
`.agents/skills/<skill-name>/SKILL.md` completely before acting. Treat that
file and every resource it references as the canonical workflow.

## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature-slug>/` (no external tracker). See `docs/agents/issue-tracker.md`.

### Triage labels

Five default triage roles: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context for the novel-CMS effort: the glossary and ADRs live in `docs/novel-cms/` (isolated from upstream microfeed core for upgrade-safety). See `docs/agents/domain.md`.

