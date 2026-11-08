-- rollback: 由 .scratch/backups/alias-retire-ext-tcm-aliases.json 的 2 行备份重建
--           ext_tcm_aliases（含 deleted 列）；恢复 2 枚 content:alias:* 权限码、
--           4 条角色授权、3 行 ext_permission_nodes；最后按
--           src/server/rbac/snapshot.ts 的 AGGREGATE_SELECT 全量重算
--           ext_user_permissions（9 行 / 165 码）。
DROP TABLE ext_tcm_aliases;

DELETE FROM ext_permission_nodes
 WHERE code IN ('content:alias:manage', 'content:alias:read', 'page_aliases');

DELETE FROM ext_role_permissions
 WHERE permission_id IN ('p_content_alias_manage', 'p_content_alias_read');

DELETE FROM ext_permissions WHERE code LIKE 'content:alias:%';

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
