-- 0189_data_front_site_settings.sql
--
-- ADR-0066 决策 14 / 规范 §3.4「P1 裁决：③」：把站点外壳的 4 个字段从主频道
-- `channels.data` 按实例复制进 `settings.webGlobalSettings`，并把 `favicon` 改写成
-- 现网生效值。前台此后只读 `settings`，站壳零读 `channels` 且显示逐字不变。
--
-- 为什么按实例取值：这是多实例部署的产品，本机 language="en-us"、
-- copyright="©{{current_year}}" 只是当前实例的值，别的实例未必相同。迁移里
-- 不能出现这些字面量，一律用子查询从 `channels WHERE is_primary = 1` 取。
--
-- 语义收敛（3 条，写进验收）：
--   1) `description` 存原文、`copyright` 存 `{{current_year}}` 原文；转纯文本与
--      展开变量这两步留在 `catalog/site.ts` 读取时做，迁移里不塞业务逻辑。
--   2) 主频道缺键时该键不写（规范 §3.4 迁移动作 #3）：四条 UPDATE 各带
--      `... IS NOT NULL` 条件，子查询为 NULL 时整条不执行，settings 里原有值保留、
--      原本没有的键也不会新增；`settings` 行不存在时不建行。
--   3) `favicon` 的语义从此扩成「站点图标」：值换成频道图，
--      后台 favicon 卡片会显示为「已有自定义图标」，前台输出不变。
--
-- 幂等：4 个键按实例现值覆盖写；`favicon` 只在值仍是 legacy 默认图时改写，
--       重放不会把用户后来上传的图标冲掉。
--
-- rollback:
--   按 MIG-004 描述如何撤销。4 个键是本迁移新增的，直接移除；`favicon.url` 还原
--   成 legacy 默认图，`contentType` 保留（原本就是 image/png）。下面两行注释里的
--   SQL 可直接执行：
--   UPDATE settings SET data = json_remove(data, '$.description', '$.language', '$.copyright', '$.publisher') WHERE category = 'webGlobalSettings';
--   UPDATE settings SET data = json_set(data, '$.favicon.url', '/assets/default/favicon.png') WHERE category = 'webGlobalSettings';

-- 1) 四个站壳字段：按实例从主频道复制，缺键不写。
UPDATE settings
SET data = json_set(data, '$.description',
  (SELECT json_extract(data, '$.description') FROM channels WHERE is_primary = 1))
WHERE category = 'webGlobalSettings'
  AND (SELECT json_extract(data, '$.description') FROM channels WHERE is_primary = 1) IS NOT NULL;

UPDATE settings
SET data = json_set(data, '$.language',
  (SELECT json_extract(data, '$.language') FROM channels WHERE is_primary = 1))
WHERE category = 'webGlobalSettings'
  AND (SELECT json_extract(data, '$.language') FROM channels WHERE is_primary = 1) IS NOT NULL;

UPDATE settings
SET data = json_set(data, '$.copyright',
  (SELECT json_extract(data, '$.copyright') FROM channels WHERE is_primary = 1))
WHERE category = 'webGlobalSettings'
  AND (SELECT json_extract(data, '$.copyright') FROM channels WHERE is_primary = 1) IS NOT NULL;

UPDATE settings
SET data = json_set(data, '$.publisher',
  (SELECT json_extract(data, '$.publisher') FROM channels WHERE is_primary = 1))
WHERE category = 'webGlobalSettings'
  AND (SELECT json_extract(data, '$.publisher') FROM channels WHERE is_primary = 1) IS NOT NULL;

-- 2) favicon：只在仍是 legacy 默认图（或未设置）时，改写成主频道 image 的现网生效值。
--    `LEGACY_DEFAULT_FAVICON_URL` 是产品常量（src/shared/Favicon.ts），不属于实例数据，
--    所以这处字面比较可以写死；写入的 url 本身仍按实例取。
UPDATE settings
SET data = json_set(
      data,
      '$.favicon.url',
      (SELECT json_extract(data, '$.image') FROM channels WHERE is_primary = 1),
      '$.favicon.contentType', 'image/png'
    )
WHERE category = 'webGlobalSettings'
  AND (SELECT json_extract(data, '$.image') FROM channels WHERE is_primary = 1) IS NOT NULL
  AND (
    json_extract(data, '$.favicon.url') IS NULL
    OR json_extract(data, '$.favicon.url') = '/assets/default/favicon.png'
  );
