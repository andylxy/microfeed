# 10 — App 百科读端点：方剂 / 中药 / 别名 / 名词

**What to build:** App 的"查方子、查药、查名词"四条链路全部打通，且方剂要连它的**组成明细**（药味/剂量/炮制）一起返回——这是方剂页的核心内容，不能只给一段原文。

**id 一律用当前项目的 11 位条目 id**（方剂 `ID`、组成里的 `yaoID`、名词 `Id` 都是条目 id，不再是源库整数），字段名保持不变。源 int64 主键**不落库、不出现在任何响应里**。

**Blocked by:** 07（本地数据）

**Status:** done（2026-09-28，dev server 实测 + worker 测试）

- [x] `GetBookIdFang`：走 `tcm_kind` 前缀索引 + pocket `sourceBookId` 过滤（伤寒金匮实测 113 方）；`ID`/`yaoID` 为当前项目条目 id；**无按源 id 的合并特例**
- [x] `GetAllZhongYao`：172 条全量（走 `items_tcm_kind_name` 最左前缀）
- [x] `GetAliaZhongYao`：43 条别名对照（源自中药条目内嵌 `aliases[]`；旧后端的第三源 BookBody.BieMing 绝大多数为空，未纳入——已在实现说明中记录）（自 `aliases[]` 内嵌 + 中药条目名）
- [x] `GetAllMingCi`：17 条名词（`Id` 为条目 id；`MingCiList` 从口袋 `list` 带出）
- [x] **`EXPLAIN QUERY PLAN` 证明无 `SCAN items` 全表扫描**（工单 07 核对）
- [x] 四个端点的字段名与大小写与 §6 完全一致
- [x] worker 测试覆盖四个端点；组成明细数组非空
