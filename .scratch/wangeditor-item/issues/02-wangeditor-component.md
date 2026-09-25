# 02 — 新增 wangEditor 富文本编辑器组件（含图片/视频上传）

**What to build:** 一个自包含的 React wangEditor 封装组件：作者能在其中编辑标准 HTML 正文，并能通过项目既有的上传链路插入图片与视频。它对外只暴露 `value` / `onChange` / `extra` 三个契约，与 Quill 组件对齐，替换进容器时不会影响 Quill 路径。

**Blocked by:** 01（依赖与 i18n 基线）

**Status:** ready-for-agent

- [ ] 组件落位 `AdminRichEditor/component/RichEditorWangEditor/`
- [ ] 函数组件（`react-jsx` 运行时）+ `useRef`/`useEffect` 持有实例
- [ ] `onCreated` 持有 editor 引用，并用 `setHtml(value)` 注入初始正文（失败 try/catch 降级空白段落）
- [ ] `onChange` 直接透传 `editor.getHtml()` 的**原生 HTML**——不做净化、不做格式化转换（沿用既定决策）
- [ ] 引入 `@wangeditor/editor/dist/css/style.css`，且编辑器区域有**显式最小高度**（否则渲染 0 高）
- [ ] `i18nChangeLanguage` 设为 `zh-CN`
- [ ] 工具栏覆盖 Quill 对等能力：标题/加粗/斜体/下划线/引用/代码块/有序无序列表/链接/图片/视频/清除样式
- [ ] 图片与视频走 `customUpload`，复用既有 `Requests.upload` + `resolvePublicBucketUrl`/`urlJoinWithRelative`/`randomHex`
- [ ] 上传产物路径沿用既有约定 `media/rich-editor/<folder>/<type>-<hex>.<ext>`，保证 R2 结构统一
- [ ] `mediaStorageReady === false` 时拦截上传并提示可改走链接（视频仍可「插入视频链接」）
- [ ] 卸载时 `destroy()` 实例，避免内存泄漏与严格模式双挂载告警

## 备注

- 复用既有原语即可，不另建上传助手文件（`RichEditorMediaDialog.onFileUpload` 已提供完整范式）。
- `Requests.upload` 真实签名：`upload(file, cdnFilename, onProgress, onSuccess(cdnUrl), onError, onFailure(error))`。
