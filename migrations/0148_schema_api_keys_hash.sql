-- 0148_schema_api_keys_hash.sql
--
-- mf_ API key 改哈希存储（ADR-0047 D3 / F4）：
-- - 鉴权改为按 sha256(明文) 查 secret_hash（与 mflc_ 凭证同源模式）；
-- - 明文列 api_key 删除——D1 数据面泄露后可用 key 数从全部降为 0；
-- - api_key_hint（后 4 位）供列表识别。
--
-- 为什么是建表重造而不是 DROP COLUMN：0006 建表时 api_key 带内联
-- `TEXT NOT NULL UNIQUE`（隐式 sqlite_autoindex，DROP INDEX 删不掉），SQLite
-- 拒绝 DROP 处于 UNIQUE 约束内的列——2026-10-24 本地启动实测报错
-- `cannot drop UNIQUE column: "api_key": SQLITE_ERROR`。改用标准重造：
-- 建新表（无 api_key）→ 拷行 → 删旧表 → 改名 → 重建二级索引。
--
-- 前提：本地 api_keys 0 行（.scratch/sec-hardening/probe-rowcounts-2026-10-24.stdout.txt）。
-- 若某环境表非 0 行：拷行保留 id/name/scopes/时间戳，但 secret_hash 置 NULL
-- （SQLite 无 sha256 函数，无法在库内回填哈希）——这些 key 立即失效、需在后台
-- 重建轮换；ext_api_key_owners 的关联按 id 保留。
-- ext_api_key_owners 为空表，删旧表不触发外键约束；RENAME 自动修正其引用。

DROP INDEX IF EXISTS api_keys_api_key;
DROP INDEX IF EXISTS api_keys_created_at_ms;

CREATE TABLE api_keys_hashed (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  secret_hash TEXT,
  api_key_hint TEXT,
  scopes TEXT NOT NULL DEFAULT 'content:read content:write',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

INSERT INTO api_keys_hashed
  (id, name, scopes, created_at_ms, updated_at_ms)
SELECT id, name, scopes, created_at_ms, updated_at_ms FROM api_keys;

DROP TABLE api_keys;
ALTER TABLE api_keys_hashed RENAME TO api_keys;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_secret_hash ON api_keys (secret_hash);
CREATE INDEX IF NOT EXISTS api_keys_created_at_ms ON api_keys (created_at_ms, id);
