# 01 — 安装 wangEditor 依赖并补齐 i18n 基线

**What to build:** 让项目具备 wangEditor 5 的运行时依赖，以及后台模式选择器所需的「WangEditor」中英文案键。后续工单全部建立在这条基线上：没有它，编辑器组件无法编译，模式列表也无法显示新选项。

**Blocked by:** None — can start immediately

**Status:** superseded（2026-10-21 核对：wangEditor 已被主动移除——`src` 内三处注释口径一致（「原 wangEditor 已移除 / 迁到 Markdown 编辑器」），组件、i18n 键、接线与测试均已不存在，条目编辑器现走 `AdminMarkdownEditor` + `AdminRichEditor` + `FangEditor`；两个残留依赖已在本轮清理。本组不再执行。）

- [ ] 根 `package.json` 新增 `@wangeditor/editor`（锁 `5.1.23`）与 `@wangeditor/editor-for-react`（安装前用 `npm view` 查最新稳定版再锁）
- [ ] **确认未误装 `@wangeditor/editor-for-vue`**（Vue 适配器，本项目是 React）
- [ ] 依赖已实际安装进 `node_modules`（经 `./node_modules/.bin/yarn add`，不走 corepack）
- [ ] `src/shared/i18n/en.ts` 与 `zh-CN.ts` 的 `shared` 命名空间新增 `shared.wangEditor` 键，两份同步
- [ ] `./node_modules/.bin/yarn i18n:check` 通过（键存在性 + 中英文一致性）

## 备注

- 本环境 `corepack` 已坏，yarn 一律走 `./node_modules/.bin/yarn <script>`；shim 若报 `sed`/`dirname` 缺失，先 export 含 PortableGit `usr/bin` 的 PATH。
- 只新增依赖与文案，不触碰任何编辑器逻辑，Quill 路径零改动。
