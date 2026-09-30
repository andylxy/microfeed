# 09 — App 典籍读端点：导航 / 目录 / 正文

**What to build:** App 打开后能拿到分类导航、能列出一本书的目录、能取到某一章下的逐条条文。**参数与响应里的 id 一律用当前项目的 11 位 id**（`BookId`=频道 id、条文 `Id`=条文条目 id），字段名保持不变以减少 App 改动。

三个必须做对的细节：每本书**独立请求，没有"10001 并上 10002"的合并特例**（那是源系统的怪癖，迁移后取消）；源系统的**签名字段（SignatureId / Signature）整体不要**，不进口袋也不进响应——取正文的定位键就是篇章条目 id；条文要逐条返回而不是拼成一整段，按 `receiptNo` 排序。

**Blocked by:** 07（本地数据）

**Status:** done（2026-09-28，dev server 实测 + worker 测试 6 例）

- [x] `GetNav`：分类 → 书 两层（实测 5 个分类，含真实元数据 针灸大成/明朝/杨继州）
- [x] `GetBookChapter`：返回目录列表；`BookId` 为当前项目的频道 id，`SignatureId` 为篇章条目 id（实测 45suxYq70le）
- [x] `GetChapterContent`：按 `(tcm_kind='section', tcm_parent_id=chapterId)` 取，走 `items_tcm_kind_parent` 索引；逐条条文按 `receiptNo` 排序，`text` 为**带标记原文**（`<p>` 包装已反转）
- [x] **`EXPLAIN QUERY PLAN` 证明每条查询都命中索引，无 SCAN items 全表扫描**（工单 07 已逐条核对）
- [x] **无任何按源 id 的合并特例**
- [x] **响应里不出现任何签名字段**
- [x] 查不到时返回空数组而不是 404（单测断言）
- [x] 响应带 `Cache-Control: public, max-age=300`
- [x] worker 测试：正常 / 空结果 / 参数缺失 400
