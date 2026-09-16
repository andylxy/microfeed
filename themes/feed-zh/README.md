# feed zh theme

This theme was initialized from `microfeed.default@1.1.15` (installed) and keeps
the separate identity `local.feed-zh@0.1.0`, so edits cannot overwrite the
source version.

It now lives inside the microfeed repository as `themes/feed-zh`, alongside the
theme it derives from. It is **not** registered in the Built-in theme catalog
(see [`themes/README.md`](../README.md)), so initialization and deployment never
install, synchronize, or activate it. It was previously maintained as a
standalone repository outside microfeed; that is no longer the case.

This directory contains the rendered files installed by microfeed. It does not
recreate private build tools or source files used by the original theme author.

## Develop

Use Node.js 22.12 or newer and Yarn 4. Because `workspaces` in the repository
root covers `themes/*`, this directory is a workspace member: install and run
from the repository root, and its `@microfeed/theme-kit` dependency resolves to
the in-repo package rather than a published one.

```console
yarn install          # from the repository root
yarn validate         # or: node --import tsx packages/theme-kit/src/cli.ts validate themes/feed-zh --json
yarn test             # or: node --import tsx packages/theme-kit/src/cli.ts test themes/feed-zh --json
yarn preview
```

There is deliberately no `yarn.lock` or `.yarnrc.yml` here: the repository root
owns the lockfile, and this package is recorded in it as
`@microfeed/feed-zh-theme-source@workspace:themes/feed-zh`.

When the manifest declares a `previewFixture`, `yarn preview` uses that
theme-specific demo content by default. To preview against a public microfeed
JSON Feed instead:

```console
yarn preview --feed-url https://example.com/json/
```

Read [THEME.md](./THEME.md), `microfeed-theme.json`, and the schemas under
`.microfeed/schemas/` before editing. Establish a clean validation and test
baseline before the first commit.

Coding-agent workflows remain canonical under `.agents/skills/`.
`CLAUDE.md` directs Claude Code to the same theme-development skill without
duplicating it.

Do **not** run `git init` here: this directory is tracked by the microfeed
repository, and a nested repository would be committed as a gitlink instead of
its contents.

Before installing changed content, increment the semantic version in
`microfeed-theme.json`. Install the new version as inactive, preview it, and
activate it only as a separate confirmed action.
