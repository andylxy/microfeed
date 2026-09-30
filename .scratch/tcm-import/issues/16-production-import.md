# 16 — 生产导入与上线验证

**What to build:** 把数据真正落到生产库，并证明站点与端点都活着。这一步只做一次，但必须有退路。

**Blocked by:** 07（本地已验）, 08（主题可见）, 15（golden 对齐）

**Status:** done（小量数据上线 + 全量 9504 条导入均完成并验证通过）

## 2026-09-28 执行记录

- [x] 导入前完整备份生产库 — `wrangler d1 export` 因远程 D1 含 FTS5 虚拟表被拒；改用逻辑备份（items 35 + channels 10 → `.microfeed/backup-remote-pretcm-20260928.sql`，恢复命令已写入文件头）。操作全程**仅 INSERT 新增 TCM 行**，小说（35 条，不同 id）不受影响。
- [x] 分批写入 — **首批小量样本已写入远程**：1 书频道（伤寒论・(人纪) XNK0VFX39Xv）+ 11 篇章 + 10 条文 + 10 方剂 + 10 中药 + 5 名词 = 46 条 items（`.scratch/tcm-import/small-data.sql`）。全量（9504 条）暂缓。
- [x] 写入前 unset 代理变量 — 每次远程 D1/Cloudflare 命令均 `unset HTTPS_PROXY HTTP_PROXY ...`
- [x] 导入后直查生产库核对行数 — 远程 `items WHERE tcm_kind IS NOT NULL = 46`，`total_items = 81`（35 小说 + 46 TCM），迁移 0070–0072 已生效（markers=13 / cats=2 / containers=3）。
- [x] 站点存活 — `https://feed.881019.xyz/` HTTP 200；App 端点 curl 验证：GetNav(含伤寒论・(人纪))/GetBookChapter(11)/GetChapterContent(10 条文，含 `$f{麻黄汤}` 标记)/GetBookIdFang(10)/GetAllZhongYao(10)/GetAliaZhongYao(26)/GetAllMingCi(5)/GetTipsStyleConfig(13，裸 `{styles}` 形状)。
- [x] 现有小说内容未被破坏 — 35 条小说 id 不变，`total_items` 仅 +46。
- [x] 跑完整门禁后再部署 — `yarn manage deploy` 内部 runChecks（typecheck 热缓存 ~2min + test:deploy + build）通过，日志 `Deployed and verified https://feed.881019.xyz`。
- [x] 部署后复查 — 见上，端点全部 200 且有数据。

## 2026-09-28 续 — 全量导入 9504（用户确认后执行）

- [x] 全量数据落远程：`scripts/import-ctwh/out/` 的 **13 本书频道（tcm-channels.sql）+ 33 批次（tcm-batch-001..032）** 全部 `INSERT OR REPLACE` 写入远程 D1；33 批次逐文件退出码检查，**0 失败**。
- [x] **条数与源库逐项一致**：chapter 445 / section 8066 / fang 804 / yao 172 / term 17 / 小说 35；TCM 合计 **9504**，远程 items 总数 **9539**。
- [x] **标签守恒**：远程 `description` 中 `$X{` 标记总数 = **13342**，与源库 / 构建输出（markerCountOutput）完全一致。
- [x] **书名正确**：13 本书频道名来自源 WorkInfo（伤寒论・(人纪)/伤寒金匮・(宋版)/金匮要略・(宋版)/(人纪)/难经/黄帝内经・素问/灵枢/神农本草经・(人纪)/疏/针灸大成/针灸篇・(人纪)/伤寒杂病论・(桂林古本) 等）。
- [x] **卷节关系完整**：孤儿条文 0（每条文 `tcm_parent_id` 都指向有效篇章）、孤儿篇章 0（每篇章 `book_id` 指向有效频道）、方剂/中药/名词挂错容器 0；10 本有内容书的篇章数之和 = **445**、条文数之和 = **8066**，与总数逐一对齐。
- [x] 活体端点全量生效：GetAllZhongYao 172 / GetAllMingCi 17 / GetAliaZhongYao 339 / GetTipsStyleConfig 13 / GetNav 6 分类 20 书（13 TCM + 7 小说）/ 金匮要略・(人纪) 25 篇章，均吻合。
- [x] 生产站首页 HTTP 200，小说未被破坏（仍 35 条）。
- 核验脚本留档（只读，可复跑）：`.scratch/tcm-import/count-markers-remote.mjs`、`check-endpoints.mjs`。

**后续**：无。全量已落生产并验证；如需回滚，用 `.microfeed/backup-remote-pretcm-20260928.sql` 逻辑备份（仅含导入前 35 小说 + 10 小说频道）。

