-- 0100: 删除测试频道「星河剑歌」及其 14 条章节
--
-- 原因：星河剑歌 (J1jGJjUWeCz) 是测试/演示数据，非 ctwh 源数据导入。
-- 删除后 channels 从 14 → 13，与 WorkInfo 13 本书对齐。
--
-- 影响：
--   - 删除 1 个频道 (J1jGJjUWeCz, status=2)
--   - 删除 14 条 items (status=1, tcm_kind=NULL)
--   - 删除前无其他表引用 (items.book_id 引用数为 14，删除后为 0)
--
-- 保留：
--   - 中药频道 (4KbG9bDqdz3) - 系统容器，fayao 归属
--   - 名词频道 (tcmterm0001) - 系统容器，term 归属
--   - 方剂频道 (tcmfang0001) - 系统容器，fang 归属

-- 1. 删除星河剑歌的 14 条章节
DELETE FROM items WHERE book_id = 'J1jGJjUWeCz';

-- 2. 删除星河剑歌频道
DELETE FROM channels WHERE id = 'J1jGJjUWeCz';
