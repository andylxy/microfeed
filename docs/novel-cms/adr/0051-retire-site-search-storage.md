# ADR-0051: 退役全文搜索存储层（site_search 表族与触发器）

- 状态：Accepted（随工单 01–03 分步实施；测试只写不跑，验证由用户手动触发门禁）
- 日期：2026-10-25
- 关联：ADR-0016（缓存取舍）、ADR-0049（缓存正确性与写预算——本 ADR 是其写放大模型的边界收缩）；数字依据 `.scratch/items-eval/`（探针 stdout 留档）

## 背景

`site_search_*` 表族（14 张：主文档 + FTS5 exact 倒排 + 标题三字组 + metadata）与 9 条触发器（items 3 + pages 3 + 影子表 3 二级）构成站内全文搜索的存储层。规模压力测算（100+ 本书、10 万行 items 在即）暴露三个数字：全库外推 500–660 MB 对免费单库 500 MB 上限；items 每写一行连带 10.21 行派生写；批量导入 ≈112 万行写 = 免费日写额度的 11 倍。

读路径查证（2026-10-25）：公开搜索的消费入口只有三个——公开站 `/search/` 页与平台搜索弹窗、公开 API `/api/v1/search/`（无第三方集成在用）、后台管理列表搜索框。**App 搜索与本项目录零关系**：App 启动调 `/api/app/search-permission`（权限查询，双码门 fail-closed），搜索执行在端上本地（`SearchCoordinator` / `BookContentSearchActivity`）。站长确认公开搜索无人使用。

## 决策

### D1｜整体退役，不瘦身

不采用 FTS5 external-content 或砍 trigram 的局部瘦身：那些只省 60–70 MB 且引入新模式风险；整体退役一次拿走全部三项收益——

| | 退役前 | 退役后 |
| --- | --- | --- |
| 库容 @10 万行 | 全库 500–660 MB（site_search 占 160 MB） | **340–500 MB，回免费单库上限内** |
| items/pages 每行写的派生连带 | 10.21 行 | **~4 行**（typeahead 仍在） |
| 100 本书导入写 | ≈112 万行（免费 11 个额度日） | **≈50 万行（1 日灌库 + 4 日派生）** |

### D2｜三端处置

- **公开侧下线**：`/search/` 页、`/search.json`、`/api/v1/search/` handler 与 OpenAPI path 撤下（404）；feed-zh 主题的搜索表单与入口按钮移除。
- **后台搜索改道**：`/admin/ajax/search/` 从 FTS 换 items 直查——按书/类型缩圈走 `items_book_kind` / `items_tcm_kind_parent` 索引，圈内 `$.title` LIKE + LIMIT；每书范围 ~2,000 行读/次（EXPLAIN 实测计划见 `.scratch/items-eval/probe-explain*.stdout.txt`），管理列表 UI 零改动。
- **App 零改动**：`/api/app/search-permission` 与 `app:search:global` / `app:search:book` 权限码保留（权限查询语义独立于搜索存储）。

### D3｜保留物

`ext_admin_typeahead` 族（6 张表 + items 上 3 条触发器）：Webhook 事件浏览器的条目候选在用，与全文搜索无关，不动。

### D4｜迁移与部署

迁移 0151（cleanup 类，幂等 DROP，rollback 块写重建路径：从 git 历史取 `CREATE_SITE_SEARCH_INDEX_SQL` 建表建触发器后全量回填，回填行写按 10.21 连带 × 全表行数计额度）。**迁移与下线/改道代码必须同一次 `manage deploy` 上线**，单独应用迁移会让在线搜索端点 500。同步工具（`reconcile-local-remote.mjs`）的 DERIVED 集合同批收缩；远程残留旧表由核对按「本地缺表」报出后手工 DROP 收敛。

## 后续

若将来需要恢复公开搜索：git 历史完整保留引擎实现与 DDL，重建代价 = 建表迁移 + 全量回填（≈10.21 × 当时行数的行写额度），功能可完整回滚。
