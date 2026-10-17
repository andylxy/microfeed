# ADR-0030: 后台条目编辑页隐藏媒体文件与播客专属字段区块

- 状态：Accepted
- 日期：2026-10-17
- 决策人：用户 + grilling 评审
- 关联决策：ADR-0029（同页 TCM 条文注文字段，相邻改动）
- 关联迁移：无（纯 UI 渲染开关，无表结构 / 数据变更）

## 背景

后台条目编辑页 `EditItemApp`（`/admin/items/[id]/` 编辑态与 `/admin/items/new/` 新建态共用同一组件）
的 `render` 里并列多组字段卡片。其中两组面向 RSS / 播客场景：

1. **媒体文件**：`<MediaManager/>` 卡片，内含 enclosure 类别选择、`MediaUploader`
   （「上传一个新的 audio 文件」即此处的 `<details>`）、`UrlEditor`（外部 URL 输入）。
2. **播客专属字段**：`<details>` 卡片（`items.podcastFields`），含 itunes:explicit / guid /
   title / episodeType / season / episode / block。

当前仓库主要承载 TCM 条文与小说章节（ADR-0029、方案 E），这两组播客 / 媒体附件字段在日常编辑流里
属于噪音。用户要求将这三块从页面上隐藏，且强调是**隐藏、后续可能重新启用**（保留代码与数据，
仅当前不渲染）。

## 决策

### D1：后台设置项控制两块渲染，默认关闭

新增独立设置分区「条目编辑区块」（对标内容审核），开关配置在 settings category
`itemEditorSections` 的布尔字段 `mediaPodcast`（`feed.settings.itemEditorSections.mediaPodcast`）。
`EditItemApp` 读该值（`=== true` 才显示）决定两块卡片是否渲染；未配置时默认隐藏。

选用后台设置项的理由：管理员可在设置页直接切换，无需改代码重新部署；settings 存取按
category 通用处理（`FeedDb._putSettingsToContentStatements` 遍历各 category），新分区复用
`onSubmit → ajaxFeed → putContent` 既有保存路径，与内容审核同一权限门。

### D2：隐藏范围为整卡，且「上传 audio」随父卡一并收起

「上传一个新的 audio 文件」位于媒体文件卡片**内部**（`MediaManager` 的 `MediaUploader`），
是媒体卡的子集。故隐藏媒体文件整卡时，该上传控件与外部 URL 输入（`UrlEditor`）一并收起，
无需单独处理。用户已确认按整卡范围处理。

因 `EditItemApp` 同时服务编辑态与新建态，隐藏对两个页面同时生效（用户已确认）。

### D3：隐藏仅改变 UI 渲染，数据与保存路径保持原样

条件包裹只影响这两块是否渲染；`mediaFile` 与 `itunes:*` 字段的读取、编辑、`onUpdateItemMeta`
保存通路、`FeedDb` 整袋写回均不改动。已有条目的这些字段值原样保留，界面收起后仍可通过接口与
数据库访问。代码完整保留，恢复显示即可继续编辑，数据与逻辑均不移除。

### D4：控制方式——后台设置开关，零代码改动

管理员在「设置 → 条目编辑区块」把开关切到「显示」即恢复两块渲染，
无需改动任何代码、数据或配置。数据始终保留（D3），可随时来回切换。

## 影响

- 后台条目编辑页与新建页默认不显示媒体文件、播客专属字段两块，页面聚焦 TCM / 小说字段；
  设置页新增「条目编辑区块」分区（`AdminSettingsNavigation` / `AdminSettingsSidebar` 图标字典 /
  `SettingsApp` 容器 / `ItemEditorSectionsSettingsApp` 组件），管理员可在此切换显隐。
- 数据层与 App 接口零变化：`GetChapterContent`、RSS / JSON 输出、字段保存均不受影响。
- i18n 键不增不减：`items.podcastFields` 等键仍被代码引用（条件分支内），`i18n:check` 口径不变。
- 测试调整：`admin-autosave-editors.test.ts` 原依赖 `name==="lh-explicit"` 播客单选控件的用例，
  因该控件随卡片隐藏而从渲染树消失，改造为「写入 itunes 字段后提交仍可保存」，
  用以固化 D3 的保证；其原「单选控件变更保存」「提交保存」两个维度分别由同文件既有的
  `item-status` 用例与 unlisted 用例承接，无净覆盖损失。
- 无迁移、无服务端改动、无 OpenAPI 文档改动。
