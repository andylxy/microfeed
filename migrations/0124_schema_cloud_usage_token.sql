-- 0124_schema_cloud_usage_token.sql
--
-- Cloudflare API Token 的密文表（单行）。「Cloudflare 使用情况」仪表盘
-- （/admin/cloud-usage）用这枚 Token 调用官方只读接口。
--
-- ## 为什么加密
--
-- D1 里的秘密一律加密存放（与 webhook 签名 secret 同级的仓库先例，见
-- src/server/webhooks/crypto.ts）。快照、导出、直连数据库都不应暴露明文。
-- 密文由 AES-GCM 产生，写入数据库后的形状是 JSON：
--   {"ciphertext":"<base64url>","iv":"<base64url>","version":1}
-- KEK（密钥加密密钥）取 Worker secret `UPLOAD_SIGNING_KEY`——`requiredSecrets()`
-- 常驻的 32 字节随机值，每个实例本地自动生成、部署时推送，本功能不新增任何
-- 环境变量。该密钥若将来轮换，旧密文不可解密，页面引导用户在设置页重新保存
-- （见 src/server/cloud-usage/token-store.ts 的三态读取）。
--
-- ## 为什么单行
--
-- 全局只有一枚 Token。id 固定为 1，CHECK 约束防止误插第二行：多行会让
-- 「读哪一行」变成一个没有答案的问题，而这里根本没有第二个配置项。
--
-- ## 为什么单独一张表，不放通用 settings
--
-- ① 通用设置保存路径把客户端 JSON 原样 upsert 进 settings 表，没有服务端加密的
--    介入点；② 通用读取路径把 settings 表所有类别灌进 feedContent，同一对象供给
--    管理后台、公开站点、公开 API 等一切消费方——密文不该搭这趟车。
--
-- ## 幂等
--
-- CREATE TABLE IF NOT EXISTS；写入路径用 INSERT … ON CONFLICT(id) DO UPDATE。
-- 重复执行安全。

CREATE TABLE IF NOT EXISTS ext_cloud_usage_token (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  -- AES-GCM 密文 JSON（ciphertext / iv / version），非空。
  token_cipher  TEXT    NOT NULL,
  -- 保存时由明文算出的末四位提示（形如 `…a1b2`），只用于界面确认在役状态。
  token_hint    TEXT    NOT NULL DEFAULT '',
  -- 最近一次保存时刻（unix 毫秒，UTC）。
  updated_at_ms INTEGER NOT NULL
);
