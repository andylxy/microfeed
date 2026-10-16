-- 将 readonly 角色的授权同步为与 editor 相同，并把角色名改为「默认编辑」
-- （用户 2026-10-16 要求同步；code 保留 `readonly`，因 r_readonly 被多处引用）。
--
-- editor 的授权由多条迁移（0031/0035/0040/0069/0073/0074/0075/0077/0079/0120）
-- 与 seed.ts 累积而成；seed.ts 的 readonly 已与 editor 共用 `EDITOR_PERMISSIONS`
-- 共享常量（见该文件）。本 data 迁移把**现有实例**的 readonly 授权也同步到 editor，
-- 并把角色名从「只读」改为「默认编辑」：先删 readonly 全部授权，再从 editor 的
-- ext_role_permissions 复制一份，最后改名。幂等（DELETE + INSERT + UPDATE）。
--
-- fresh 安装顺序：迁移（含本条）先跑，bootstrapAdmin 的 seedRbac 后跑并以
-- `INSERT OR IGNORE` 落库 —— editor 与 readonly 都会拿到「迁移累积 ∪ seed 列表」，
-- 二者因此相等；本条在 seedRbac 之前已把 editor 的迁移累积复制给 readonly，
-- 与 seedRbac 的 INSERT OR IGNORE 合并无冲突（主键 (role_id, permission_id) 按角色去重）。
--
-- rollback: UPDATE ext_roles SET name = '只读' WHERE code = 'readonly'; DELETE FROM ext_role_permissions WHERE role_id = (SELECT id FROM ext_roles WHERE code = 'readonly'); INSERT INTO ext_role_permissions (role_id, permission_id) SELECT (SELECT id FROM ext_roles WHERE code = 'readonly'), p.id FROM ext_permissions p WHERE p.code IN ('content:chapter:read','content:book:read','content:category:read','content:fang:read','content:alias:read','content:volume:read','content:term:read','content:yao:read','content:annotation-markers:read');

-- 角色名：readonly 不再是只读，改为「默认编辑」反映实际权限。
UPDATE ext_roles SET name = '默认编辑' WHERE code = 'readonly';

DELETE FROM ext_role_permissions
  WHERE role_id = (SELECT id FROM ext_roles WHERE code = 'readonly');

INSERT INTO ext_role_permissions (role_id, permission_id)
  SELECT (SELECT id FROM ext_roles WHERE code = 'readonly'), rp.permission_id
  FROM ext_role_permissions rp
  WHERE rp.role_id = (SELECT id FROM ext_roles WHERE code = 'editor');
