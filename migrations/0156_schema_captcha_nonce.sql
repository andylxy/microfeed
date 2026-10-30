-- 0156_schema_captcha_nonce.sql
--
-- 图形验证码的「一次性」记账（ADR-0015 D2）。
--
-- 背景：`captcha.ts` 的验证码是无状态的（reqNo 里只有过期时刻 + HMAC 签名），
-- 同一张码在 120s TTL 内可被无限次提交。把它当防枚举门控时，攻击者只需解一次图
-- 就能打满 IP 窗口（20 次/60s），门控成本被高估 40 倍。
--
-- 本表只记「这张码已经用过」：reqNo 的 SHA-256 摘要作主键，INSERT OR IGNORE 的
-- changes 判定首次使用。不存码本身、不存 reqNo 原文，库泄露也无法重放。
--
-- 行数 ≈ 发码次数，与 ext_email_otp 同量级；写入前顺带删 24h 前的行
-- （cleanupCaptchaNonces），故不会无界增长。
--
-- 另补 ext_email_otp 的过期索引：清理语句按 expires_at_ms 过滤，原索引
-- (email, purpose) 用不上，会退化成全表扫描。

CREATE TABLE IF NOT EXISTS ext_captcha_nonce (
  req_no_hash TEXT PRIMARY KEY,
  used_at_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ext_captcha_nonce_used_idx
  ON ext_captcha_nonce (used_at_ms);

CREATE INDEX IF NOT EXISTS ext_email_otp_expires_idx
  ON ext_email_otp (expires_at_ms);
