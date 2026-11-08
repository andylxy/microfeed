-- 0192_data_fix_mail_settings_node_parent.sql
--
-- 修正 0154 的权限树挂靠缺陷：system:mail-settings:read / manage 两个码叶
-- 被 0154 直接挂在顶层组 group_operations 下，违反 ADR-0038 结构规则
-- 「code 叶的父级必须是 page」（page 的父级才是 group）。挂在 group 下会被
-- buildGrantGroupsFromNodes 忽略，导致这两个码在权限树上不可见、无法在
-- 角色编辑器勾选（邮件设置权限不可授出）。
--
-- 0154 注释本意「与 login-methods 同族、sort 610/611 取 page_login_methods
-- （0150，sort 609）顺延」——挂靠点应为 page_login_methods。本迁移把两个
-- 码叶移到该页下，sort 改为页内顺延（page_login_methods 现有码叶 sort 0/1，
-- 取 2/3），组内不占位。
--
-- 幂等：UPDATE 结果与执行次数无关；带 parent_code 条件，仅在仍是错误挂靠时移动。
--
-- rollback:
--   UPDATE ext_permission_nodes SET parent_code = 'group_operations', sort = 610 WHERE code = 'system:mail-settings:read';
--   UPDATE ext_permission_nodes SET parent_code = 'group_operations', sort = 611 WHERE code = 'system:mail-settings:manage';

UPDATE ext_permission_nodes
   SET parent_code = 'page_login_methods', sort = 2
 WHERE code = 'system:mail-settings:read' AND parent_code = 'group_operations';

UPDATE ext_permission_nodes
   SET parent_code = 'page_login_methods', sort = 3
 WHERE code = 'system:mail-settings:manage' AND parent_code = 'group_operations';
