-- 0114_data_channels_genre_backfill.sql
--
-- 0113 的触发器只对**未来的写入**生效。本草事故里 4 本已发布书（中药 / 名词 /
-- 神农本草经・(人纪) / 神农本草经疏）外加方剂容器的 `channels.genre` 镜像列是
-- NULL，而这些行是仓库外直写 D1 产生的（ctwh 导入脚本携带的是更早的、已被删除
-- 的分类 id，后续重分类只改了 JSON），永远不会再走应用内那两个维护镜像的写入点
-- （FeedDb._putChannelToContentStatement / extBook.updateAdminBook）——不回填，
-- 触发器就永远不为它们触发，本草分类页继续空白。
--
-- 所以把 0113 文件头里「同批执行的一次性回填」落成本文件：以 JSON（SSOT）为准
-- 单向同步镜像列。WHERE 条件自带过滤，重复执行是 no-op（收敛后 0 行）。
--
-- 本地实测影响 5 行。方剂（tcmfang0001）被同步后也不会出现在公共页：`status`
-- 与 `tcmContainer` 双重过滤挡着（listChannelsByGenre / listCategoryNav）。
--
-- rollback:
--   无需回滚数据：本迁移只把派生列收敛到 SSOT，收敛后的状态就是正确状态。
--   若要退回 0113 之前的机制，DROP TRIGGER 掉 0113 的两个触发器即可
--   （channels_genre_mirror_after_insert / channels_genre_mirror_after_update），
--   列值保留不动——保留即为 SSOT 的正确形态。

UPDATE channels SET genre = json_extract(data, '$._microfeed.genre')
 WHERE json_extract(data, '$._microfeed.genre') IS NOT NULL
   AND (genre IS NULL OR genre <> json_extract(data, '$._microfeed.genre'));
