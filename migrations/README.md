# D1 迁移目录说明

D1 以**文件名**为迁移身份键（`d1_migrations.name`），按文件名排序应用。
本目录存在编号空洞，属正常现象，不要因此"补号"或改动既有文件。

## 编号空洞（C9 备案）

- `0044`、`0045`、`0047`、`0048`、`0049` 无对应文件。
  这些编号在功能开发过程中被创建后又删除（`0044`/`0045` 属用户级权限覆盖实验，
  `0046_drop_ext_user_permissions.sql` 是其回滚清理；`0047`–`0049` 同期为 RBAC 迭代废稿）。
- `0046_drop_ext_user_permissions.sql` 头注释引用的"0045"指的就是这批已删除文件。
  **该文件已在线上应用过，按「已部署迁移一字不动」红线不改其注释**，以本说明为准。

## 约定

1. 已应用的迁移文件**一字不动**（包括注释）；语义修正一律走新迁移。
2. 新迁移序号接续 `0061` 之后，命名带 `ext_` 前缀 + 语义名（本地特有表/功能一律
   `ext_` 前缀，便于与上游合并时肉眼区分撞号）。
3. 与上游撞号（如 `0023_multilingual_search.sql` vs `0023_ext_novel.sql`）不致命：
   同号不同名按文件名去重，合并时两者都保留。
4. 幂等要求（**数据迁移**）：`INSERT OR IGNORE` / `NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`，
   D1 可能在部分部署上重放。**列级 DDL 例外**：SQLite 无 `DROP COLUMN IF EXISTS` /
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，这类语句天然不可重放（如 `0060` 的
   `DROP COLUMN resolved_at`、`0033` 的 `ADD COLUMN secret_hash`），其一次性由
   `d1_migrations` 的**文件名记账**保证——**不要**为"重放安全"去改写已应用的迁移文件。

## 已知死结构（C2 备案，刻意保留不 DROP）

- `ext_api_key_owners`（0032）：全仓无读写。0032 注释中"删除 owner 行由应用代码处理"的
  契约已由 `api-keys.ts` 的 revoke/delete batch 落实（DELETE 语句为无害空转）。
  刻意不 DROP：表已进入 `SNAPSHOT_TABLES` 分类与快照链路，删除需同步改造快照读取，
  得不偿失；保留空表不影响任何行为。
- `api_keys.secret_hash`（0033 加列）：无读写。签名凭证能力最终由
  `ext_login_credentials.secret_hash`（0036）承担。同理保留，避免对上游核心表
  `api_keys` 再加一个本地分叉点。
