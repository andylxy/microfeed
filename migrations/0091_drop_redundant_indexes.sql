-- 0091: 删除与 UNIQUE 约束 / PRIMARY KEY 完全重复的冗余索引
--
-- SQLite 会为 UNIQUE 约束与复合 PRIMARY KEY 自动建隐式索引；再显式建一个列相同
-- （或只是它的左前缀）的索引，只会让每次 INSERT/UPDATE/DELETE 多维护一份索引，
-- 没有任何读收益。这里逐条核对后删除，全部用 IF EXISTS 保证可重放。
--
-- 每一条都是「显式索引的列 == 某 UNIQUE/PK 的列（或为其左前缀）」，隐式索引即可
-- 完全替代：
--   - api_keys_api_key                == UNIQUE(api_key)
--   - channels_is_primary             == UNIQUE(is_primary)
--   - auth_password_setup_tokenHash_idx == UNIQUE(tokenHash)
--   - ext_roles_code                  == UNIQUE(code)
--   - ext_permissions_code            == UNIQUE(code)
--   - site_search_documents_source    == UNIQUE(content_type, content_id)
--   - ext_user_roles_user_id          == PK(user_id, role_id) 左前缀
--   - ext_role_permissions_role_id    == PK(role_id, permission_id) 左前缀
--   - ext_user_devices_user_id        == PK(user_id, device_id) 左前缀
--   - themes_package_id               == UNIQUE(package_id, version) 左前缀
--   - oauth_connection_owner_idx      == 以 PK(id) 打头的复合唯一索引
--
-- 保留：role_id / permission_id / credential_id 等「复合键右列」索引，它们不是任何
-- 唯一索引的前缀，仍有读收益。

DROP INDEX IF EXISTS api_keys_api_key;
DROP INDEX IF EXISTS channels_is_primary;
DROP INDEX IF EXISTS auth_password_setup_tokenHash_idx;
DROP INDEX IF EXISTS ext_roles_code;
DROP INDEX IF EXISTS ext_permissions_code;
DROP INDEX IF EXISTS site_search_documents_source;
DROP INDEX IF EXISTS ext_user_roles_user_id;
DROP INDEX IF EXISTS ext_role_permissions_role_id;
DROP INDEX IF EXISTS ext_user_devices_user_id;
DROP INDEX IF EXISTS themes_package_id;
DROP INDEX IF EXISTS oauth_connection_owner_idx;
