# 01 — 给 items 加业务索引列

**What to build:** 让一条 item 能被"它属于中医四种内容里的哪一种"以及"它在源库里的整数主键是多少"这两个条件直接命中索引。这是一条纯 additive 的 schema 变更：加两列两个索引，现有小说站功能零回归，加完立刻可以跑全量测试确认没坏东西。

之所以要提为真实列（而不是塞进 JSON 口袋）：后台保存走 `FeedDb` 的 upsert，只写它认识的 8 个列，**真实列不会被保存动作覆盖**；而条件落在 JSON 路径上必然全表扫描。

**Blocked by:** None — can start immediately

**Status:** done（2026-09-28，分支 `feature/tcm-import`；**2 列 2 索引，无源 id 列**）

- [x] 新增迁移，给 `items` 加 `tcm_kind TEXT`（`chapter`/`section`/`fang`/`yao`/`term`）与 `tcm_parent_id TEXT`（父条目 11 位 id）
- [x] 建索引 `(tcm_kind, json_extract(data,'$.title'))`：最左前缀覆盖「按 kind 过滤」，全对覆盖名字跳转
- [x] 建索引 `(tcm_kind, tcm_parent_id)`：**修掉「某篇章的条文」这条 8066 行全表扫描**（App 最主要的读取路径）
- [x] **不设任何源 id 列**——源 int64（ChapterId/BookInfoId/FangId/YaoId）只在导入脚本内存里消费，不落库
- [x] 关系载体按 §16 两条规则分流：频道归属走 `_microfeed.bookId`（保存路径自动镜像到已有索引列 `book_id`）；父子条目层级走 `tcm_parent_id` 列
- [x] 迁移幂等（`IF NOT EXISTS`），重跑不报错
- [x] worker 测试套件应用迁移成功（rbac 68 + bootstrap 5 全绿，证明 schema 可用）
- [x] 跑一遍现有 worker 测试确认零回归（75/75 通过）
