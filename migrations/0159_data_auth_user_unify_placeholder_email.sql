-- 0159_data_auth_user_unify_placeholder_email.sql
--
-- 占位邮箱域统一（ADR-0014 rev.9 / I7）：从两套（@oauth.local + @users.microfeed.local）
-- 收敛为单一 @users.microfeed.local。QQ 建号（app-third-party.ts）与用户名建号
-- （AdminCredentials.ts）从此只写这一个域；判定（isPlaceholderEmail / isQqShellEmail /
-- bindEmailCommit WHERE / PLACEHOLDER_EMAIL_SUFFIXES）只写一处，不再两边光顾。
--
-- 本迁移只搬「存量里仍留在 @oauth.local 的行」。当前唯一一行是 QQ 空壳：
--   id       = 5ebee6d2-1e2e-41a4-bce3-c1779d907a20  (signup_source = 'qq')
--   email    = qq_39746869556B3DEAF1163DDCD5A12B9D@oauth.local
-- 用「域后缀替换」（substr 截尾再拼接）保留 openid 的原始大小写，只换最后一段域
-- （见 0158 注释，email 与 username 大小写不同步是刻意的）。
--
-- 注意：email_usable 是 VIRTUAL 生成列（0157），随 email 自动重算——两个域在该生成列
-- CASE 里都判 0，本迁移无须也不得改 email_usable（I11）。
--
-- type = data。
-- rollback:
--   -- 把 QQ 空壳（qq_ 前缀）从统一域搬回 @oauth.local。后台用户名建号
--   -- （xiaoyang@users.microfeed.local 之类，无 qq_ 前缀）不属于 QQ 空壳，不搬。
--   UPDATE "auth_user"
--      SET "email" = substr("email", 1, length("email") - length('@users.microfeed.local'))
--                   || '@oauth.local'
--    WHERE "email" LIKE 'qq\_%@users.microfeed.local' ESCAPE '\';

UPDATE "auth_user"
   SET "email" = substr("email", 1, length("email") - length('@oauth.local'))
                || '@users.microfeed.local'
 WHERE "email" LIKE '%@oauth.local';
