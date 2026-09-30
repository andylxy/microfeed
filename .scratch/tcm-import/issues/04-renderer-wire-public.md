# 04 — 渲染器接入公开正文

**What to build:** ~~让读者在公开页面上真正看到彩色、可点的药名与方名~~

**Blocked by:** 02（渲染器）, 03（完整样式数据）

**Status:** superseded（2026-09-28 用户拍板：**PC Web 暂时原样输出 `$X{}`，移动端 App 自渲染**——App 消费 `GetTipsStyleConfig` 的样式目录 + 自带 TipsTextRenderer 处理 linkType 跳转）

## 演变记录

1. **已实现后撤回接线**（保留资产，未删除）：
   - `src/shared/TcmMarkers.ts` 递归渲染器 + 10 例单测 —— **保留**，将来 PC 要上样式时从 `FeedPublicJsonBuilder` 的 `content_html` 出口接回（spec §7）
   - 迁移 0071 的标记样式列（color/small_font/link_type）—— **保留**，`GetTipsStyleConfig`（工单 11）必需
   - 曾接好的 `FeedPublicJsonBuilder` 渲染参数与 `FeedDb._loadTcmMarkerRender()` —— **已拆除**（公开管线恢复原样透传）
2. **当前行为**：`content_html` 原样携带 `$u{桂枝}` 等字面标记；PC 读者看到原文，App 端按自己的渲染器处理。
3. 拆除时曾引入 FeedDb 尾括号缺失（sed 多删一行）与 3 处测试 noUncheckedIndexedAccess 报错——均已修复，typecheck 0 errors。

- [x] 渲染器模块与样式下发数据保留（App 端路径完整）
- [x] 公开管线恢复原样输出（builder 直出 `bodyToHtml` 结果，无标记处理）
- [x] 移除公开 CSS 的 `.mf-mk` 规则（避免死代码）
- [x] typecheck 0 errors + 相关单测回归通过
