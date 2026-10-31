-- 0157_schema_auth_user_attrs.sql
--
-- auth_user 加两个用户属性（ADR-0014 rev.6 / D8、D9）：
--
--   signup_source —— 用户类型（注册来源）。普通列，建号时写死，此后任何操作
--     （补邮箱 / 绑定 QQ / 解绑 / 提权）都不得修改（I12）。三值：
--       'email' 邮件注册（better-auth signUpEmail 内部写库，只能吃 DEFAULT —— N8）
--       'qq'    QQ 首登建号（createQqUser 显式写）
--       'admin' 管理侧任意入口（bootstrap / password-setup / rbac-handlers 补写）
--     不能改成「按 ext_user_oauth 是否存在」派生：绑定瞬间值会翻转，丢掉注册来源（N5）。
--     也不能只做二值：@users.microfeed.local 那类用户名账号既非邮件注册也无法发信（N6）。
--
--   email_usable —— 邮件可发信标记。VIRTUAL 生成列，不是普通列、不是 emailVerified：
--     emailVerified 对 QQ 占位账号被 createQqUser 硬写成 1（N1），不能当判据；
--     普通列会在「改 email 后忘记同步」时漂移（A27）。生成列随 email 自动变化，
--     且数据库层拒绝写入（I11）。
--
-- 顺序不可调换：先加列（默认 'email'）→ 再回填 → 最后建生成列与索引。
--
-- type = schema。
-- rollback:
--   DROP INDEX ix_auth_user_email_usable;
--   ALTER TABLE "auth_user" DROP COLUMN "email_usable";
--   ALTER TABLE "auth_user" DROP COLUMN "signup_source";

-- 1) 用户类型：普通列，建号时写死，此后不可变（I12）
ALTER TABLE "auth_user" ADD COLUMN "signup_source" TEXT NOT NULL DEFAULT 'email';

-- 2) 存量回填（实测：email=6 / qq=1 / admin=2 / 合计 9）
UPDATE "auth_user" SET "signup_source" = 'qq'
 WHERE lower("email") LIKE '%@oauth.local';
UPDATE "auth_user" SET "signup_source" = 'admin'
 WHERE lower("email") LIKE '%@users.microfeed.local';

-- 2b) role 兜底（N9 / A30）：bootstrap、password-setup 用**真实邮箱**建的管理侧账号，
--     纯后缀回填会把它们记成 'email'。实测当前命中 1 行（xi.ernest@gmail.com）。
--     放在前两条之后：占位域行已定性，不会被这条改写。
--     残留风险（已知且接受）：role 是当前态而非创建路径，迁移前被提权的邮件注册用户
--     会被错标成 'admin'。这是一次性历史近似，不做常驻校验（SQL 无法区分两种情形）。
UPDATE "auth_user" SET "signup_source" = 'admin'
 WHERE "role" IN ('admin', 'owner')
   AND lower("email") NOT LIKE '%@oauth.local'
   AND lower("email") NOT LIKE '%@users.microfeed.local';

-- 3) 邮件可发信标记：VIRTUAL 生成列（STORED 无法 ALTER 添加 —— A26），数据库层不可写（I11）
ALTER TABLE "auth_user" ADD COLUMN "email_usable" INTEGER
  GENERATED ALWAYS AS (
    CASE WHEN lower("email") LIKE '%@oauth.local'
           OR lower("email") LIKE '%@users.microfeed.local' THEN 0 ELSE 1 END
  ) VIRTUAL;

-- 4) 索引：实测可建，且 EXPLAIN QUERY PLAN 命中（A25）
CREATE INDEX "ix_auth_user_email_usable" ON "auth_user" ("email_usable");
