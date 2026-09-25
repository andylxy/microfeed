# 05 — 测试加固：wangEditor mock 与归属/切换用例

**What to build:** 单元测试能在 node 环境下加载「接入了 wangEditor 的编辑器容器」，并锁住两项关键行为——模式可见性、以及切到 wangEditor 时的单向锁定（含 Markdown 正文的转换）。没有这层 mock，容器顶部的新 import 会让现有用例在 node 下集体崩溃。

**Blocked by:** 03（容器模式隔离）

**Status:** ready-for-agent

- [ ] `admin-rich-editor-modes.test.ts` 顶部 `vi.mock` 掉 `@wangeditor/editor` 与 `@wangeditor/editor-for-react`（返回 dummy，避免 node import 崩溃）
- [ ] 现有断言 `toEqual(["rich", "html", "markdown"])` **仍绿**（未传 `enableWangEditor` 的默认路径）
- [ ] 新增用例：`enableWangEditor` 为真时选项含 `wangeditor`
- [ ] 新增用例：`bodyEditor='wang'` 时选项**仅 `[wangeditor, html]`**，且初始 `mode` 为 `wangeditor`
- [ ] 新增用例：Markdown 正文切到 `wangeditor` 会先渲染为 HTML，并触发 `onBodyEditorChange('wang')`
- [ ] `admin-autosave-editors.test.ts` 仍绿（其已整体 mock `AdminRichEditor`，不受本次改动影响）

## 备注

- 测试必须经 yarn 跑（`./node_modules/.bin/yarn test`），直接调 `vitest` 会假失败。
- `yarn test` 会跑单元 + worker 两套配置，两者都要绿。
