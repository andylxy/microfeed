-- 0146_data_app_about_newline_normalize.sql
--
-- 关于页内容（ext_app_about_info）改用**真换行**存储，一次性把旧分行符 `|`
-- 转成 LF。
--
-- ## 为什么
--
-- 0145 建表时沿用了旧后端（netcore）的 `|` 分行约定：App 端 AboutActivity
-- 拿到 text 后 `split("\\|")` 再逐行拼回 "\n"。这个「存时用 `|`、显示时再拆」
-- 的往返带来两个问题：
--   1. 后台管理页（/admin/app-about/，ADR-0029 逐字存取）里看到的就是一坨带
--      竖线的长行，编辑和校对都很别扭；
--   2. 凡是 text 里本身要出现 `|` 字符（表格、分隔符、URL 片段）就会被误分行。
--
-- 改为「后端怎么存、App 就怎么显示」：存储即真换行（LF），App 端去掉 split，
-- 直接渲染原文。契约更简单，且管理页所见即 App 所得。
--
-- ## 转换口径
--
-- `replace(text, '|', char(10))` 一行完成。只动含 `|` 的行（WHERE 收窄），
-- 不含竖线的行不写、updated_at 不被无谓刷新。
--
-- 幂等：转换后再跑，已无 `|` 的行不匹配 WHERE，是空转；D1 重放安全。
-- 新写入的数据由管理页直接存 LF，本迁移不参与。
--
-- 回滚：这是语义转换，且**不可逆**——转换后无法区分「原文里本来就是 `|`」
-- 和「原本是换行」，所以**没有**对应的反向 UPDATE（把 LF 换回 `|` 会误伤
-- 用户新录入的真换行）。真要还原只能从 `text` 备份取原值整行覆盖写回。
-- rollback:
--   无反向语句：本转换不可逆。
--   如需还原，从迁移前的 `ext_app_about_info.text` 备份按 name 整行覆盖写回：
--   UPDATE ext_app_about_info SET text = '<原值>' WHERE name = '<name>';

UPDATE ext_app_about_info
   SET text = replace(text, '|', char(10)),
       updated_at = CURRENT_TIMESTAMP
 WHERE text LIKE '%|%';
