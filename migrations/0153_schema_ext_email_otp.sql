-- 0153_schema_ext_email_otp.sql
--
-- 邮箱验证码（OTP）存储（邮箱 + 验证码注册；purpose 隔离 register / reset / forget）。
--
-- 明文验证码不落库：只存 HMAC-SHA256(code, BETTER_AUTH_SECRET) 的十六进制摘要，
-- 与 `ext_login_credentials.secret_hash` 同思路——库泄露也无法直接得到可用验证码。
--
-- 行数 ≈ 发码次数：按 (email, purpose) 保留历史行，供「当日发码上限」计数；
-- 校验只认「未过期的最后一条」（ORDER BY last_sent_at_ms DESC LIMIT 1），
-- 因此重发后旧码自动失效，无需额外清理。校验通过即删除该行（一次性消费）。

CREATE TABLE IF NOT EXISTS ext_email_otp (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

-- 发码前查最新一条（重发间隔）、校验时定位有效记录、当日计数，三条路径都走
-- (email, purpose) 前缀，索引按此建。
CREATE INDEX IF NOT EXISTS ext_email_otp_email_purpose_idx
  ON ext_email_otp (email, purpose);
