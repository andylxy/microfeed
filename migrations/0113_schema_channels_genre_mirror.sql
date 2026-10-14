-- 0113_schema_channels_genre_mirror.sql
--
-- 背景（2026-10-13 事故）：本草（gsY3ELgQsE4）分类页一本书都不显示，
-- 页面渲染出主题空态「该分类下暂时没有书。」，而后台书库显示这些书属于本草。
--
-- 根因是 `channels.genre` 镜像列脱读：4 本已发布书（中药 / 名词 /
-- 神农本草经・(人纪) / 神农本草经疏）的 `data._microfeed.genre`（SSOT）
-- 都写着本草，镜像列却是 NULL。写入来自仓库之外的直改 D1——ctwh 导入脚本
-- （scripts/import-ctwh）携带的是更早的、已被删除的分类 id（cat_renji01 /
-- j24vLiF3Sym / 1runoCsI7dr / OteD-aXHV_d），后续重分类只改了 JSON；
-- 应用内只有两个写入点维护镜像（FeedDb._putChannelToContentStatement 与
-- extBook.updateAdminBook），都没有参与这些写入。
--
-- 公共读路径只认镜像列：extCategory.listChannelsByGenre（分类页）、
-- listCategoryNav（首页导航计数）、content-read.getContentCategoryBooks
-- （/api/v1/content/categories/{id}/books/）。后台 toBookAdmin 读 JSON，
-- 于是「后台有、前台无」。
--
-- 做法与迁移 0103（ext_book_stats 三触发器）相同：把派生列钉在数据层。
-- 应用层钩子覆盖不到仓库外的直写——items 的写入点分散在 6 个文件，
-- channels 的直写点还有 import-ctwh 脚本与一次性 D1 补丁，逐处挂钩子
-- 漏一个就静默漂移，本次就是实例。触发器把同步钉在数据层，绕不过去。
--
-- 方向单向：JSON（SSOT）→ 列（镜像）。触发器从不反向写 JSON。
--
-- 为什么挂 `AFTER UPDATE OF data` 而不是 `AFTER UPDATE OF data, genre`：
-- extCategory.deleteCategory 靠 `UPDATE channels SET genre = NULL` 解引用
-- 被删分类（不碰 data）。若 genre 的变化也触发回填，删除分类时列会被从
-- JSON 里写回，删除语义被破坏。只认 data 变化 = 只有「改内容」才同步
-- 镜像，「解引用」放行。
--
-- 既有行的收敛不靠触发器（它只对未来的写入生效），靠同批执行的一次性
-- 回填，本地与生产各一次：
--   UPDATE channels SET genre = json_extract(data, '$._microfeed.genre')
--    WHERE json_extract(data, '$._microfeed.genre') IS NOT NULL
--      AND (genre IS NULL
--           OR genre <> json_extract(data, '$._microfeed.genre'));
-- 本地实测影响 5 行（4 本本草已发布书 + 方剂容器）；方剂被公共页的
-- status / tcmContainer 双重过滤挡着，不会因此出现在分类页或导航计数里。
--
-- 与既有写入点的关系：updateAdminBook / _putChannelToContentStatement 写的
-- 列值与触发器从 NEW.data 算出的值同源同值，触发器覆盖为无变化，不冲突。
-- removeImageMetadata 的 json_remove 只动 $.image，重算结果不变。
--
-- 回滚（若需）：DROP TRIGGER 掉下面两个。纯派生结构，不丢任何原始数据
-- （SSOT 一直在 channels.data 里）。

CREATE TRIGGER IF NOT EXISTS channels_genre_mirror_after_insert
AFTER INSERT ON channels
BEGIN
  UPDATE channels SET genre = json_extract(NEW.data, '$._microfeed.genre')
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS channels_genre_mirror_after_update
AFTER UPDATE OF data ON channels
BEGIN
  UPDATE channels SET genre = json_extract(NEW.data, '$._microfeed.genre')
   WHERE id = NEW.id;
END;
