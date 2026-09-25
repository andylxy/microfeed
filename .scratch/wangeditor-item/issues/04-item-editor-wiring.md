# 04 — Item 编辑器接线与 body_editor 归属持久化

**What to build:** 文章（Item）编辑页真正能用上 wangEditor，且「这篇正文归 wangEditor 所有」这一事实能被持久化——作者保存并重开页面后，归属依然生效，不会退回 Quill。

**Blocked by:** 03（容器模式隔离）

**Status:** ready-for-agent

- [ ] `EditItemApp` 的 `<AdminRichEditor>` 传入 `enableWangEditor`
- [ ] 传入 `bodyEditor`，读自 `item._microfeed?.body_editor`
- [ ] 传入 `onBodyEditorChange`，经既有 `onUpdateItemMicrofeedMeta('body_editor', v)` 写入 `_microfeed` 口袋
- [ ] **无需任何 D1 迁移**（`_microfeed` 是 `.loose()` JSON 口袋，写入永不校验，随 autosave 原样回传）
- [ ] `extra` 透传 `publicBucketUrl` / `folderName`（`items/<itemId>`）/ `mediaStorageReady`
- [ ] 历史 item 缺失该键时按 `quill` 处理（即默认行为不变）
- [ ] Page / Channel 编辑器**未**开启 wangEditor（本期范围外，保持原样）

## 备注

- `description` / `content_format` 是 item 顶层字段，不要往里塞归属标记；归属只落在 `_microfeed`。
- 与公开渲染彻底解耦：公开侧对 HTML 正文原样透传，渲染路径零改动。
