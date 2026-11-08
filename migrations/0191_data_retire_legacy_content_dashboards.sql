-- 0191_data_retire_legacy_content_dashboards.sql
--
-- ADR-0069：退役 6 个 legacy 内容看板（term / books / volumes / categories / fangs / yao）。
--
-- 本迁移只处理权限侧（Q5=A）：6 个 legacy page 节点、16 个相关 code 叶、
-- 7 枚不复用权限码、10 行角色授权；并重建 9 条复用码 code 叶到独立模块页
-- （page_book_info / page_ming_ci / page_zhong_yao）与隐藏页 page_content_api，
-- 最后按 src/server/rbac/snapshot.ts 的 AGGREGATE_SELECT 全量重算
-- ext_user_permissions（9 行 / 151 → 137 个码 token）。
--
-- 与 0190（退役 alias 模块）同型：data 类、破坏性、只删不建表；items / channels /
-- ext_category / 6 个 feed 数据层文件 / 5 张字典表**全部保留**（本 ADR 决策 1/2）。
--
-- 行数与 id 全部为 2026-11-08 本地真库只读探针结果（实例 ctwh-881019-xyz，
-- ext_permissions=69 / ext_permission_nodes=113 / ext_role_permissions=59 /
-- ext_user_permissions 9 行 / 151 token），与 .scratch/backups/legacy-dashboards-rbac.json
-- 的 39 行备份逐行核对一致。
--
-- 顺序不可调换：先删节点 → 删授权 → 删码 → 建新叶 → 重算快照。AGGREGATE_SELECT
-- 读 ext_permissions，重算必须排在删码之后，否则聚合看到旧值。
--
-- rollback: 由 .scratch/backups/legacy-dashboards-rbac.json 的 39 行备份重建——
--           6 个 page 节点（page_books/page_volumes/page_categories/page_fangs/
--           page_yao/page_term）、16 个 code 叶、7 枚权限码、10 行角色授权；
--           撤销本文件新建的 9 条 code 叶与隐藏页 page_content_api；最后按
--           src/server/rbac/snapshot.ts 的 AGGREGATE_SELECT 全量重算
--           ext_user_permissions（9 行 / 151 个码 token）。备份为本地真库只读导出，
--           部署到其他实例时须先按「仓库内无数据」复核 6 个基线数字再回滚。

-- 1. 删 6 个 legacy page 节点（parent_code='group_content'，sort 101/103/104/108/110/111）
DELETE FROM ext_permission_nodes
 WHERE code IN ('page_books', 'page_volumes', 'page_categories', 'page_fangs', 'page_yao', 'page_term');

-- 2. 删 16 个相关 code 叶（6 页的唯一子节点，children-check 实测 16/16、0 悬挂）
DELETE FROM ext_permission_nodes
 WHERE kind = 'code'
   AND (code LIKE 'content:book:%'
     OR code LIKE 'content:category:%'
     OR code LIKE 'content:volume:%'
     OR code LIKE 'content:fang:%'
     OR code LIKE 'content:term:%'
     OR code LIKE 'content:yao:%');

-- 3. 删 10 行角色授权（7 枚不复用码的授权）
DELETE FROM ext_role_permissions
 WHERE permission_id IN ('p_content_category_create', 'p_content_category_delete',
                         'p_content_category_order', 'p_content_category_update',
                         'p_content_fang_read', 'p_content_volume_read',
                         'p_content_volume_update');

-- 4. 删 7 枚不复用权限码
DELETE FROM ext_permissions
 WHERE code IN ('content:category:create', 'content:category:update',
                'content:category:delete', 'content:category:order',
                'content:volume:read', 'content:volume:update', 'content:fang:read');

-- 5. 重建 9 条复用码 code 叶到独立模块页（复用原 id，仅改挂点与 sort）
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms) VALUES
  -- page_book_info（book-info，sort=111）挂 4 条 book 码
  ('pn_content_book_read',   'content:book:read',   'code', 'page_book_info', 1, 'desktop', 'content:book:read',   NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_book_create', 'content:book:create', 'code', 'page_book_info', 2, 'desktop', 'content:book:create', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_book_update', 'content:book:update', 'code', 'page_book_info', 3, 'desktop', 'content:book:update', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_book_delete', 'content:book:delete', 'code', 'page_book_info', 4, 'desktop', 'content:book:delete', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  -- page_ming_ci（ming-ci，sort=112）挂 2 条 term 码
  ('pn_content_term_read',   'content:term:read',   'code', 'page_ming_ci',  1, 'desktop', 'content:term:read',   NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_term_manage', 'content:term:manage', 'code', 'page_ming_ci',  2, 'desktop', 'content:term:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  -- page_zhong_yao（zhongyao，sort=113）挂 2 条 yao 码
  ('pn_content_yao_read',    'content:yao:read',    'code', 'page_zhong_yao', 1, 'desktop', 'content:yao:read',    NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_yao_manage',  'content:yao:manage',  'code', 'page_zhong_yao', 2, 'desktop', 'content:yao:manage',  NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  -- page_content_api（隐藏页，承接 content:category:read）
  ('pn_content_category_read', 'content:category:read', 'code', 'page_content_api', 1, 'desktop', 'content:category:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 6. 新建隐藏页 page_content_api（承接 content:category:read；不进侧栏，
--    触发器只拦「entry_code 非空且 path 空」，两者留空即放行）
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms, path, entry_code) VALUES
  ('pn_page_content_api', 'page_content_api', 'page', 'group_content', 117, 'desktop', NULL,
   '内容读取接口', 'Content read API', NULL, NULL, 0, 'seed',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL, NULL);

-- 7. 全量重算 ext_user_permissions（9 行 / 151 → 137 个码 token；simulate-recompute 实测）
DELETE FROM ext_user_permissions;
INSERT INTO ext_user_permissions
       (user_id, codes, is_member, admin_login_allowed, updated_at)
SELECT ur.user_id,
       COALESCE(json_group_array(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '[]'),
       MAX(r.is_member),
       MAX(r.allow_admin_login),
       CURRENT_TIMESTAMP
  FROM ext_user_roles ur
  JOIN ext_roles r ON r.id = ur.role_id
  LEFT JOIN ext_role_permissions rp ON rp.role_id = ur.role_id
  LEFT JOIN ext_permissions p ON p.id = rp.permission_id
 GROUP BY ur.user_id;
