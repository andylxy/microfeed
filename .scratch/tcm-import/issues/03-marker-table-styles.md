# 03 — 标记表补齐颜色 / 小字 / 链接类型

**What to build:** 让后台"标注标记"里能表达原 App 那 13 种标记的**完整视觉效果**，而不只是一个中文名。拿到的标记表要能被 App 的样式配置端点直接消费，也能驱动前端渲染配色。

顺带修正现有 4 枚里 3 枚的语义错误：`$a` 不是"中药"是按语小字、`$u` 不是"穴位"是药物、`$x` 不是"西医/检验"是橙色单字。

**Blocked by:** None — can start immediately

**Status:** done（2026-09-28，迁移 `0071`；13 项种子 + 3 枚 title 修正）

- [x] 迁移给标记表加 `color` / `small_font` / `link_type` 三列（additive，带默认值）
- [x] 按 §4.2 的 13 行表重种完整标记（含颜色、是否小字、linkType）
- [x] 修正现有 `$a` / `$u` / `$x` 三枚名称（$a 按语 / $u 中药 / $x 橙字）
- [x] 迁移幂等：既有 4 行走 UPDATE、其余 9 行 INSERT OR IGNORE
- [x] 后台标记管理页能正常列出 13 项（不要求编辑新列，可后续补）
- [x] worker 测试确认种子变更没破坏 bootstrap（rbac 68 + bootstrap 5 全绿）
