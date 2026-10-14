# ADR-0015: 标记渲染器接入公开阅读页（取代"不接入公开管线"拍板）

- 状态：Accepted（取代 2026-09-28 拍板）
- 日期：2026-10-11
- 决策人：用户

## 背景

`src/shared/TcmMarkers.ts`（递归解析 `$f{方剂}` / `$u{药名}` → 内联注解）在 2026-09-28
经用户拍板"已实现但未接入公开管线"：PC Web 暂时原样输出 `$X{}`（`FeedPublicJsonBuilder` /
`BodyFormat.ts` 直出原文），移动端 App 自己渲染。渲染器与单测保留，等待将来从
`FeedPublicJsonBuilder` 的 `content_html` 出口接回。

2026-10-11 的提交 `feat(tcm): 阅读页标记弹层、容器频道过滤、D1 索引与 ADR 整理` 把
`src/server/tcm/markerPopover.ts`（`buildTcmMarkerLayer`）接入了公开阅读页
`src/pages/i/[slug]/index.astro`。这与原拍板矛盾，故正式记录口径变更。

## 决策

标记渲染器**已接入公开阅读页**，取代原"不接入公开管线"拍板：

- 接入点：`src/pages/i/[slug]/index.astro`（公开阅读页）在服务端调用
  `src/server/tcm/markerPopover.ts` 的 `buildTcmMarkerLayer(db, {bodyHtml, title, currentBookId})`。
- 激活条件：条目属于典籍频道且有 tcm 子项（`currentBookId != null && tcmProbe != null`）
  时才解析 `content_html`，其余条目保持原样；`markerPopover` 内硬编码容器频道
  `CONTAINER_CHANNEL_IDS = {"tcmfang0001","tcmyao00001","tcmterm0001"}`。
- **解析之后还有两道门（2026-10-13 修正，见 ticket 01）**：`buildTcmMarkerLayer`
  内部按两个不同目的分别门控——
  1. **样式渲染门**：正文或标题渲染出过任何 `mf-mk` span 才返回渲染结果，
     否则回退原文。样式表 `ext_annotation_markers` 里 `linkType=0` 的码
     （`$a` 按语 / `$m` 强调 / `$w` 剂量 / `$q` 出处 / `$n` / `$x` / `$r` / `$v` /
     `$h` / `$y`）**有样式、无链接**，这一门保证它们照常出彩色/小字。
  2. **弹层激活门**：只有出现可链接实体（`$f`=方剂 / `$u`=中药 / `$g`=名词，
     带 `data-tcm-kind`）才构建弹层 runtime 与引用表预热——纯样式码没有可弹内容。
  这两件事自 2026-10-13 起由两道门分别判定；此前由同一个 `if`（都看 `data-tcm-kind`）
  判定，只含非链接码的页面会整层作废：本地快照 **700 个全非链接码条目**（占带标记条目
  22.5%）正文裸露 `$x{...}` 原文。全库不可链接 occurrence 6,139 / 14,349（42.8%）是
  occurrence 占比，混合页的非链接码本就正常渲染，不计入受影响条目数。
- 复用：弹层依旧复用 `src/shared/TcmMarkers.ts` 渲染器与既有 `mf-mk` CSS 类约定。
- 移动端 App 通道**不受影响**：App 仍自渲染（`GetTipsStyleConfig` 下发 linkType 语义，
  App 侧 `TipsTextRenderer` 消费），与本次改动正交。

**与原拍板的关键偏差**：原拍板的接入点是 `FeedPublicJsonBuilder` / `BodyFormat.ts` 的
`content_html` 出口（已取消）；实际接入走的是阅读页**服务端解析层** `buildTcmMarkerLayer`，
在 `bodyToHtml` 之后、主题 mustache 之前对 `content_html` 做二次变换。两者目的相同
（公开页显示内联标记弹层），但接入位置不同。

## 考虑过的其他做法

**沿用原拍板，仍不接入**：保留"PC 原样输出、App 自渲染"。被否——用户明确要求把标记弹层
落到公开阅读页（本次提交即此意图），原拍板的"暂不接入"已过期。

**按原拍板接入 `BodyFormat.ts` / `FeedPublicJsonBuilder`**：被否——那是 JSON 构建出口，
会把标记解析强加给所有消费 `content_html` 的通道（含 RSS/JSON feed），而标记弹层只需
在阅读页出现；放在阅读页服务端更精准、副作用更小。

## 后续影响

- `spec.md` §7 状态、§7 接入点、§12 实施边界、§13 实施清单、§14 对比表第 12 行的
  "未接入公开管线 / 原样输出" 描述均已同步为"已接入"。
- 原 §13 清单第 7 项（`BodyFormat.ts` 接入点"已取消"）保留为"原计划出口未采用"的注记，
  避免后人误以为标记仍完全不解析。
- 若日后要扩展到 RSS/JSON feed 也带标记，需重新评估是否要把解析下沉到 `BodyFormat.ts`，
  届时与本 ADR 的"只在阅读页解析"取舍对照。
