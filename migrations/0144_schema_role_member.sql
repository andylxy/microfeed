-- 0144_schema_role_member.sql
--
-- 角色加「会员」标记（`ext_roles.is_member`）：一个布尔，表示该角色是否为会员，
-- 默认 false。鉴权时经 `resolveUserAccess` 并入 `locals.appMember`，App 内容端点
-- （GetNav / GetBookChapter / GetChapterContent / GetBookIdFang）据此选会员档或
-- 公开档：会员档收录「会员」状态的书，公开档只收录「显示」状态的书。后台权限
-- 不读这一列，决策记录见 docs/novel-cms/adr/0044。
--
-- 同批把「登录后台」的默认值改为 false，但**不在表上改默认值**：种子角色
-- （super_admin / editor / readonly）在 0132 加列时就带上了 DEFAULT 1，必须保留；
-- 而 SQLite 改列默认值要重建表，会牵连两张引用 ext_roles 的子表。因此新建角色的
-- 默认值改在 `createRbacRole` 的 INSERT 里显式写 0——走管理界面新建的角色默认
-- 不允许登录后台，种子角色不受影响。
--
-- type = schema。
-- rollback:
--   ALTER TABLE ext_roles DROP COLUMN is_member;

ALTER TABLE ext_roles ADD COLUMN is_member INTEGER NOT NULL DEFAULT 0;
