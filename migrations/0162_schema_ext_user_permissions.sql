-- 0162_schema_ext_user_permissions.sql
--
-- 权限快照表（ADR-0053）：按账号物化「持有哪些权限码」。
--
-- 后台每个已登录请求都要解析权限。改造前是 4 表 3 JOIN + 2 条独立语句，
-- 实测 CPU 25.33 µs、返回 27 行（2026-11-01，本机实例 9 个账号）。角色、
-- 授权、用户角色分配三者都是人工月级操作，所以把结果按账号物化，读侧降为
-- 一条点查、一行、7.67 µs。
--
-- 这张表是仓库里唯一的物化镜像（ADR-0053）：
--   - 权威仍在 ext_user_roles / ext_role_permissions / ext_roles；
--   - 写入由应用层在同一批次里维护，没有触发器、没有外键约束保证内容；
--   - 读侧查不到即无权限（ADR-0053 约束 3），所以写路径漏一处就是 403 或越权。
--
-- banned / banReason / banExpires 刻意不进这张表：读路径已经在同一条语句里
-- 顺带把它们从 auth_user / ext_user_security 取回（见 src/server/rbac/snapshot.ts
-- 的 readSnapshotGate），物化既不减少往返也不减少行数，只多出一处需要同步的写点。
--
--   banExpires 是时间判据：读路径一旦开始做「过期即解封」的比较，物化就会把时间
--   维度固化下来，那时更不能进这张表。
--
-- type = schema。
-- rollback:
--   DROP TABLE ext_user_permissions;

CREATE TABLE IF NOT EXISTS ext_user_permissions (
  -- 一个账号一行，也就是「零权限」也占一行（codes = '[]'）。没有角色分配的
  -- 账号没有这一行，读侧据此拒绝。
  user_id             TEXT    NOT NULL PRIMARY KEY
                              REFERENCES "auth_user" ("id") ON DELETE CASCADE,
  -- JSON 数组。存权限码而不存 permission_id：权限码由 Constants.ts 三镜像
  -- 固定，仓库里没有任何 UPDATE ext_permissions 语句，没有换码路径。
  codes               TEXT    NOT NULL,
  -- ext_roles.is_member 的并集，多角色取 MAX。
  is_member           INTEGER NOT NULL DEFAULT 0,
  -- ext_roles.allow_admin_login 的并集，多角色取 MAX。
  -- 与 userMayEnterAdmin 的口径一致（resolve.ts:261）。
  admin_login_allowed INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT    NOT NULL
);

-- 索引：不建。读路径按主键点查，重算按 user_id 主键，删账号按主键；
-- is_member 是布尔列，两个取值的选择性近乎为零，`src/` 里也没有任何按它过滤的
-- 查询。等真的出现「按会员档筛账号」的查询再补，届时按那条查询的形状建。

-- 回填：有角色分配就有快照行，零角色账号不产生行。
--
-- FILTER 不能省成 WHERE：member 角色 0 条授权，LEFT JOIN 会产出 null 混进
-- JSON 数组；而把它写成 WHERE p.code IS NOT NULL 会把「只有零授权角色」的
-- 账号整行滤掉，连 MAX(r.is_member) 一起丢掉。
--
-- 读量（2026-11-01，本机实例副本 9 个账号，EXPLAIN QUERY PLAN 实测）：
--   SCAN ur   USING COVERING INDEX ext_user_roles(user_id, role_id)
--                                              —— 10 行 / 388 字节
--   SEARCH r  USING INDEX ext_roles(id)        —— 每次 ≤ 1 行（5 行表）
--   SEARCH rp USING COVERING INDEX ext_role_permissions(role_id, permission_id)
--                                              —— 63 行 / 1825 字节
--   SEARCH p  USING INDEX ext_permissions(id)  —— 每次 ≤ 1 行（65 行表）
-- 合计读取约 6 KB，结果 9 行 / 3.8 KB。规模随账号数与授权数线性增长，
-- 不随内容量增长。
--
-- 计划里另有 USE TEMP B-TREE FOR json_group_array(DISTINCT)：DISTINCT 需要一张
-- 去重临时表。分组只有 9 个、每组授权 4~24 条，这块开销可忽略；先 SELECT DISTINCT
-- 再聚合同样要建临时表，没有更省的写法。
INSERT OR REPLACE INTO ext_user_permissions
  (user_id, codes, is_member, admin_login_allowed, updated_at)
SELECT ur.user_id,
       COALESCE(
         json_group_array(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL),
         '[]'
       ),
       MAX(r.is_member),
       MAX(r.allow_admin_login),
       CURRENT_TIMESTAMP
  FROM ext_user_roles ur
  JOIN ext_roles r ON r.id = ur.role_id
  LEFT JOIN ext_role_permissions rp ON rp.role_id = ur.role_id
  LEFT JOIN ext_permissions p ON p.id = rp.permission_id
 GROUP BY ur.user_id;
