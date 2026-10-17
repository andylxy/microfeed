# ADR-0029: 后台可编辑 TCM 条文注文（note / videoMemo）

- 状态：Accepted
- 日期：2026-10-16
- 决策人：用户 + 设计评审
- 关联设计：ADR-0028（两端口径与 App 配置链路）、ADR-0006（`_microfeed` 口袋 SSOT）
- 关联规范：`.scratch/tcm-import/spec.md` §6（BookBody → items 字段映射）与 §9（防御性降级）
- 关联迁移：无（纯 `_microfeed` 口袋字段，无表结构变更）

## 背景

移动端 `GetChapterContent` 的每条条文带 `note` 与 `sectionvideo` 两个字段，映射自
`items.data._microfeed.note` / `.videoMemo`（`src/server/tcm/reads.ts` 的 `getAppChapterContent`）。
这两个口袋键由导入脚本一次性写入（源库 `SectionNote` / `SectionVideoMemo`，
`scripts/import-ctwh/build.ts`），此后**全仓没有任何界面能查看或修改它们**——后台条目编辑页
（`EditItemApp`）的 `_microfeed` 控件只有 `bookId` / `volume` / `chapterNo` / `fangYaoList` 四个。

本地 D1 实测量化（`tcm_kind='section'` 共 8066 条）：

| 事实 | 数字 |
|---|---|
| `note` 非空 | 1428 条（17.7%）：神农本草经疏 545 / 神农本草经・(人纪) 385 / 伤寒论・(人纪) 382 / 金匮要略・(人纪) 116 |
| `note` 长度 | p50 = 376、p90 = 974、max = 3523 字符；>200 字符 1084 条（75.9%） |
| `videoMemo` 非空 | 5 条（0.06%） |
| `note` 键存在性 | 全部 8066 个 section 条目有键、0 个非 section 条目有键 |

保存路径本身无损：`FeedDb._putItemToContentStatement` 整袋 `JSON.stringify(data)` 写回，
后台保存不会抹掉口袋里的任何键。缺的只是**可见性与可编辑性**：改一个注文错别字目前只能重跑导入。

## 决策

### D1：`note` / `videoMemo` 变为后台可编辑，控件置于描述编辑器正下方，无条件渲染

在 `EditItemApp` 的描述（`AdminRichEditor`）块之后新增注文区块，复用既有共享组件
`AdminTextarea`（`minRows` / `maxRows` 随内容增高并封顶，适配最长 3523 字符的 note）。

**无条件渲染**（所有条目、新建与编辑一律显示）。判据有两条：

1. 用户明确要求新建页（`/admin/items/new/`）就显示这两个字段；新建页是创建模式，
   `_microfeed` 口袋尚不存在，键存在性条件恰好把字段藏在唯一被点名要求的页面上。
2. 条件渲染会造陷阱：后台新建的条目若初建时没填注文，编辑页将永远不再显示这两个字段，
   事后无法补填。

无条件渲染的代价（非 TCM 条目也会看到两个空文本框）用**写-on-interaction 约定**抵消：
未触碰的 textarea 不触发 onChange，保存时不会向口袋写入任何键，非 TCM 条目口袋保持干净。

### D2：App 缓存签名不含 note——控件旁明示，不改签名算法

`signature = MD5(text)`（`reads.ts`），**只含正文、不含 note**。该算法受 golden
逐字节一致约束（315/315 方剂 + 全部条文的 signature 均等于 MD5(text)，见 `reads.ts` 验证记录），
不可为 note 改动而修改。后果：后台改 note 后，App 按 `signatureId` + `signature`
（类 ETag）的缓存不失效，改动**随下一次正文修改一起到达 App**。

处置：不改算法；在控件旁以 muted 小字（`items.tcmPocketHint`）如实标注该语义。
web 公开页从不渲染 note（全仓仅 `reads.ts` 一处消费），故编辑不波及任何渲染路径。

### D3：保存约定——原样存取，清空写空串

- **不 trim、不清洗**：note 是 App 原样下发的纯文本（含 `\n\n` 换行分隔），字节保真。
- **清空写 `""` 不写 `undefined`**：`JSON.stringify` 会丢弃值为 `undefined` 的键，
  写 `""` 才能让键保留（App 侧 `textOrNull("")` → `null`，与旧后端「空值发 null」的接口行为一致）。
- 写入一律经 `onUpdateItemMicrofeedMeta`，与既有口袋字段同一通路。

### D4：`videoMemo` 字段名误导，如实记录

App 字段名 `sectionvideo` 与源列名 `SectionVideoMemo` 都带「视频」，但本地实测 5 条非空值
**全部是文本注文**（最长一条为 3500 余字音义注释）、0 条是地址。故后台标签命名为「附注」；
wire 字段名写进 placeholder 保持映射可查。字段名本身属于 App 接口规范，不可更改，
此处仅记录该事实避免后人误判。

## 影响

- 后台表单多两个长文本控件（新建 / 编辑所有条目可见）；非 TCM 条目口袋零污染（D1 约定）。
- App 接口行为不变：`GetChapterContent` 响应形状、字段名、null 语义均不变。
- 无迁移、无服务端改动、无 OpenAPI 文档改动。
- 遗留（本票范围外）：本草两书（9020000 / 400100 共 930 条）的 App `text` 已含 note 副本，
  注文在 App 端重复显示，见 `.scratch/tcm-import/api-test-plan.md` §4.14 遗留提示。
