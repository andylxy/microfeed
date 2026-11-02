-- 0169_data_signup_source_register_and_default_role.sql
--
-- 一、把「库里出现过、分组配置里没有」的来源登记进 `signup_sources`。
--
--     0163 收敛过一次越界值（统一改回 'email'）。但操作者后来手工写入了
--     `back`（本机实测 2 行），明确表示不是 bug —— 再收敛回 'email' 等于抹掉
--     手工设置的数据，且无法反推。所以这一版**不抹数据**，改成把它登记成正式
--     分组：收敛的对象是「配置与数据的取值域不一致」，不是数据本身。
--
--     **只登记格式合法的值**（`[a-z][a-z0-9_]{0,31}`，用 GLOB 表达，因为迁移里
--     没有正则）。原因是一个坏值会毒化整份配置：`validateSignupSources` 是整表
--     校验，只要有一项不合法，读路径就回落到 `DEFAULT_SIGNUP_SOURCES` —— 管理员
--     自建的分组与改过的显示名全部隐形，而那个坏值又因为「仍在用」删不掉，只能
--     逐个搬账号。格式不合法的值留在库里、不登记，等人工处理。
--
--     新登记项的显示名优先取默认表里的名字（`back` → 后台创建），取不到才用
--     value 本身；这样「新建行」与「追加行」不会给同一个来源两个名字。
--
-- 二、给「没有任何角色」的账号补 r_readonly，并补上权限快照。
--
--     0160 用同一策略补过一批，但它是快照：0160 之后通过 QQ 首登 / 邮箱注册
--     建出来的账号当时没有授予逻辑，至今仍无任何角色。这条把 0160 的通用策略
--     再跑一遍（`NOT EXISTS` 保证幂等，已有任何授权的账号不受影响）。
--
--     **只授予不补快照是无效的**：读侧把「账号存在但没有 ext_user_permissions
--     行」当成无权限（snapshot.ts 的 readSnapshotGate），这批账号补完角色照样
--     进不了后台。第三条语句按 `snapshot.ts` 的同一聚合口径补快照，范围限于
--     「有授权却无快照行」的账号。
--
--     建号逻辑本轮已补齐（后台建号 / 邮箱注册 / QQ 首登一律授予 r_readonly，
--     见 src/server/rbac/grant.ts），所以这两条只补历史遗漏。
--
-- 读量：三条都是全表条件读写，各 SCAN auth_user 或 settings 一次；两张表规模
-- 分别等于账号数与配置类别数（本机 9 行 / 0 行）。
--
-- type = data。
-- rollback:
--   三条都不可逆到原值，理由分别是：
--     - 登记进去的分组无法与「管理员本来就这么配的」区分，删掉会连带清空他后
--       来改过的显示名；
--     - 补上的 r_readonly 无法与「本来就是唯一 readonly」的账号区分，0160 的回滚
--       块按「唯一授权是 r_readonly」删除会误伤那些账号；
--     - 补上的快照行无法与原本就有的快照区分。
--   需要撤销时请走后台「管理分组」与「角色管理」，它们能按项操作。

INSERT INTO "settings" ("category", "data", "created_at", "updated_at")
SELECT 'signup_sources', merged.payload, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM (
    SELECT json_group_array(json_object('value', value, 'label', label)) AS payload
      FROM (
        -- 与 `DEFAULT_SIGNUP_SOURCES` 保持同一份：配置行一旦建出来，读路径就
        -- 不再用代码默认值，两边不一致会让某个分组凭空消失。
        SELECT 'admin' AS value, '管理员' AS label
        UNION ALL SELECT 'email', '邮箱注册'
        UNION ALL SELECT 'qq', 'QQ 登录'
        UNION ALL SELECT 'back', '后台创建'
        UNION ALL
        SELECT DISTINCT "signup_source", "signup_source"
          FROM "auth_user"
         WHERE "signup_source" NOT IN ('admin', 'email', 'qq', 'back')
           AND "signup_source" GLOB '[a-z]*'
           AND NOT "signup_source" GLOB '*[^a-z0-9_]*'
           AND length("signup_source") <= 32
      )
  ) AS merged
 WHERE NOT EXISTS (
   SELECT 1 FROM "settings" WHERE "category" = 'signup_sources'
 );

UPDATE "settings"
   SET "data" = (
         SELECT json_group_array(json_object('value', value, 'label', label))
           FROM (
             -- 先用数组下标占位，保证管理员排好的顺序不被重排；新登记的一律
             -- 追加到末尾（`UNION` 会按值排序，那是错的）。
             SELECT known.key AS pos,
                    json_extract(known.value, '$.value') AS value,
                    json_extract(known.value, '$.label') AS label
               FROM json_each("settings"."data") AS known
             UNION ALL
             SELECT 1000000 + missing.rn,
                    missing.value,
                    COALESCE(seed.label, missing.value)
               FROM (
                 SELECT DISTINCT a."signup_source" AS value,
                        ROW_NUMBER() OVER (ORDER BY a."signup_source") AS rn
                   FROM "auth_user" AS a
                  WHERE a."signup_source" NOT IN (
                          SELECT json_extract(known.value, '$.value')
                            FROM json_each("settings"."data") AS known
                        )
                    AND a."signup_source" GLOB '[a-z]*'
                    AND NOT a."signup_source" GLOB '*[^a-z0-9_]*'
                    AND length(a."signup_source") <= 32
               ) AS missing
               LEFT JOIN (
                 SELECT 'admin' AS value, '管理员' AS label
                 UNION ALL SELECT 'email', '邮箱注册'
                 UNION ALL SELECT 'qq', 'QQ 登录'
                 UNION ALL SELECT 'back', '后台创建'
               ) AS seed ON seed.value = missing.value
             ORDER BY pos
             -- `LIMIT -1` 阻止子查询被拉平，否则上面的 ORDER BY 会被优化掉，
             -- 聚合出来的数组顺序就变成未定义。
             LIMIT -1
           )
       ),
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "category" = 'signup_sources'
   AND json_valid("data")
   AND json_type("data") = 'array'
   AND EXISTS (
         SELECT 1 FROM "auth_user" AS a
          WHERE a."signup_source" NOT IN (
                  SELECT json_extract(known.value, '$.value')
                    FROM json_each("settings"."data") AS known
                )
            AND a."signup_source" GLOB '[a-z]*'
            AND NOT a."signup_source" GLOB '*[^a-z0-9_]*'
            AND length(a."signup_source") <= 32
       );

INSERT OR IGNORE INTO "ext_user_roles" ("user_id", "role_id")
SELECT a."id", 'r_readonly'
  FROM "auth_user" a
 WHERE NOT EXISTS (
   SELECT 1 FROM "ext_user_roles" ur WHERE ur."user_id" = a."id"
 );

-- 补完授权必须补快照：读侧「账号存在但没有 ext_user_permissions 行」按无权限
-- 处理，只写 ext_user_roles 的话这批账号依旧进不了后台，补授等于没做（ADR-0053）。
--
-- 只补「有授权却没有快照行」的账号：它们正是上面这批（以及 0160 之后任何被
-- 手工授过权、却没重算快照的账号）。已有快照的一律不动，避免整表重写；聚合
-- 口径与 `snapshot.ts` 的 AGGREGATE_SELECT 逐项一致（`FILTER` 不能省，见该处注释）。
INSERT INTO "ext_user_permissions"
  ("user_id", "codes", "is_member", "admin_login_allowed", "updated_at")
SELECT ur."user_id",
       COALESCE(
         json_group_array(DISTINCT p."code") FILTER (WHERE p."code" IS NOT NULL),
         '[]'
       ),
       MAX(r."is_member"),
       MAX(r."allow_admin_login"),
       CURRENT_TIMESTAMP
  FROM "ext_user_roles" ur
  JOIN "ext_roles" r ON r."id" = ur."role_id"
  LEFT JOIN "ext_role_permissions" rp ON rp."role_id" = ur."role_id"
  LEFT JOIN "ext_permissions" p ON p."id" = rp."permission_id"
 WHERE NOT EXISTS (
   SELECT 1 FROM "ext_user_permissions" s WHERE s."user_id" = ur."user_id"
 )
 GROUP BY ur."user_id";
