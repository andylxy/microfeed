-- 0155_schema_ext_user_oauth.sql
--
-- 第三方登录（本期仅 QQ）的 openid → 本应用用户 绑定表。
-- 主键 (provider, openid) 保证同一平台同一 openid 只绑一个用户；
-- user_id 外键级联到 auth_user（删用户时清理绑定）。
-- 幂等：CREATE TABLE IF NOT EXISTS，可安全重放。

CREATE TABLE IF NOT EXISTS ext_user_oauth (
  provider       TEXT    NOT NULL,
  openid         TEXT    NOT NULL,
  user_id        TEXT    NOT NULL REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  created_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (provider, openid)
);

CREATE INDEX IF NOT EXISTS ext_user_oauth_user_id ON ext_user_oauth (user_id);
