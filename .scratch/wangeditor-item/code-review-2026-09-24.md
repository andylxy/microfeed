# code-review：wangEditor 5 集成（双轴）

- **固定点**：`HEAD = aeb1907`（改动全在工作树，未提交）
- **diff**：`git diff HEAD -- src/ tests/ package.json` = 7 文件 / +345 / −21
- **规范来源**：`AGENTS.md`、`CONTEXT.md`、`CONTRIBUTING.md`
- **规格来源**：`.scratch/wangeditor-item/issues/01…06`
- **结论**：修复后门禁全绿并已部署；下文保留原始发现与处置。

## Standards

### 硬违规

**`AdminRichEditor` — `onBodyEditorChange` 可选回调守卫**
援引 AGENTS.md「行为」：代码应当 fast-fail，在出错位置就地崩溃，而不是捕获或 fallback。
`onWangChange` 与 `onModeChange` 都用 `if (this.props.onBodyEditorChange)` 包住归属写入。调用方开了
`enableWangEditor` 却漏接该回调时，正文静默切给 wangEditor 而 `body_editor` 不落库，刷新后正文回到 Quill
被重新解释——正是本改动要防的失效。
（须说明：`markBodyAsHtml()` 在 HEAD 上就是同一可选回调写法，该条款此前未被一贯执行。）

### 判断项（基线异味）

- **Duplicated Code**：`uploadMedia` 与 `RichEditorMediaDialog.onFileUpload` 逐行同形（同一
  `media/rich-editor/...` 字面量、同一扩展名切片、同一 `randomHex(32)`、同一组 toast）。
- **Duplicated Code + Primitive Obsession**：`props.bodyEditor === 'wang'` 在 constructor / onModeChange /
  render 三处重复，`'wang'` 字面量共 4 处。
- **Mysterious Name（否）**：`htmlSourceForWang` 承载「wangEditor 章节不做 Quill 清洗」这条规则，保留。
- **模块级 `i18nChangeLanguage`**：效果可接受（单一消费方；切语言走 `location.reload()`），但副作用绑在
  import 时刻，且静态导入让 wangEditor 及其 CSS 进入每个用 `AdminRichEditor` 的页面。
- **i18n 值未汉化**：`zh-CN` 为 `"WangEditor"`，同组 `markdownEditor` 是「Markdown 编辑器」。
- **新增两个 `vi.mock`**：AGENTS.md 有「不允许使用任何 mock」条款，但同文件 HEAD 已 mock `quill`，且此处是
  隔离仅浏览器可用的第三方依赖、未伪造断言 → 不判违规。

## Spec

### (a) 缺失 / 只做一半

- 媒体不可用提示用错键：工单 02 要求「提示**可改走链接**」，应用
  `shared.r2UnavailableUseUrl`（含「从 URL 添加」），实现用的是 `shared.enableR2BeforeUpload`。
- 工具栏未显式声明清单（`toolbarConfig = {}`），靠默认集兜底（默认集是清单的超集）。

### (b) scope creep

- 语言策略被改：工单 02 写「设为 `zh-CN`」，实现改为跟随后台 UI 语言。
- `onWangChange` 每次按键都调 `onBodyEditorChange('wang')`，工单 03 只要求切换时打标记。

### (c) 实现可疑（关键）

**单向锁定不收敛**：`isWangOwned` 全程读 `props.bodyEditor`。切换瞬间只 `setState({mode})`，父级未回传前
同一屏仍可点 rich/markdown，把 wang HTML 喂给 Quill。`onWangChange` 的补写只是自愈，不是锁定；测试也未覆盖
「切换后选项收缩」这条真路径。

### 重点项核实结论

| # | 项 | 结论 |
|---|---|---|
| 1 | 媒体拦截 + 提示可改走链接 | 拦截 ✓，提示键差一半 → 已修 |
| 2 | 未传 `enableWangEditor` 时列表精确为 `[rich, html, markdown]` | ✓ 保证，测试以 `not.toContain` 锁住 |
| 3 | wang 正文两处都绕开 Quill strip | ✓ `editorValue` 与 `htmlSourceForWang` 均无遗漏 |
| 4 | 零 D1 迁移 | ✓ 无新迁移文件，落 `_microfeed` |
| 5 | 单向锁定 | ✗ 依赖父级回传 → 已修（本地 state 立即锁定） |
| 6 | 三组新用例 | ✓ 断言有效，缺「切换后锁定」→ 已补 |

## 修复清单（全部落地）

1. `state.wangOwned` + `isWangOwned()` ⇒ 切换当帧即摘掉 rich/markdown，不依赖父级回传；
   抽 `BODY_EDITOR_WANG` 常量与 `isOwnedByWang()` 消掉三处重复与字面量。
2. `onModeChange('wangeditor')` 入口 fast-fail：缺 `onBodyEditorChange` 抛错；Markdown 正文缺
   `onFormatChange` 也抛错。
3. `onWangChange` 只透传 HTML。
4. 抽 `uploadRichEditorMedia(...)` 到 `src/client/RichEditorMedia.ts`，新组件调用；
   **Quill 侧 `RichEditorMediaDialog` 未改**（按「本期不动 Quill 路径」边界，旧副本列后续）。
5. `i18nChangeLanguage` 移入组件 `useEffect`。
6. toast 键改 `shared.r2UnavailableUseUrl`；`zh-CN` 改「WangEditor 编辑器」。
7. 新增 2 条测试：切换当帧即锁定、缺回调抛错。

## 门禁与部署

- `tsc --noEmit` 0 error；`yarn lint` 0；`yarn i18n:check` 2005/2005；组件测试 **30 文件 / 180 例**。
- 部署 `DEPLOY_EXIT=0`：`Checks and build passed` + `Deployed and verified https://feed.881019.xyz`
  （日志 `.microfeed/deploy-wangeditor.log`，耗时 24m12s，其中 18 分钟在内部 typecheck）。
- 存活：`/` 200、`/admin/` 302、`/admin/items/list` 308（尾斜杠规范化）。

## 遗留

- 浏览器手工验证未做（后台需登录凭据）→ 交用户。
- Quill 侧上传逻辑旧副本待合并到 `uploadRichEditorMedia`。
- 工具栏沿用 wangEditor 默认菜单集。
- 语言跟随后台 UI（对工单 02「设为 zh-CN」的有意偏离，理由：英文后台不该拿中文工具栏）。
- 未提交，在 `feat/login-credential`。
