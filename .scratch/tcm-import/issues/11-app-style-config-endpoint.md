# 11 — App 样式配置端点

**What to build:** App 启动后能从新后端拉到 13 种标记的配色、是否小字、链接类型，效果与旧后端下发的一致。带版本号参数，未变更时走轻量返回。

**Blocked by:** 03（标记表要有颜色/小字/链接三列）

**Status:** done（2026-09-28，dev server 实测 13 项）

- [x] 端点返回 `{styles:[{marker, color, isSmallFont, linkType}]}`，实测 13 项齐全（f=#0000FF/link2 等）
- [x] 数据来自 `ext_annotation_markers`（唯一事实来源），后台改标记下次请求即生效
- [x] `version` 参数保留兼容；样式目录极小（13 行），始终返回全量由 App 侧比对（实现说明写在路由注释）
- [x] 颜色为 App 可解析格式（`#RRGGBB` 与 `rgba(0, 128, 255, 0.90)`）
- [x] 单测：13 项齐全、linkType 1/2/3 对应 u/f/g、w 小字 #1CB55C
