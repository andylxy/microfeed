/**
 * Cloudflare API Token 的存取中枢（migration 0124）。
 *
 * 单行密文表 `ext_cloud_usage_token`：id 固定 1，列 `token_cipher` / `token_hint` /
 * `updated_at_ms`。加密走 `src/server/webhooks/crypto.ts` 的 AES-GCM 实现
 * （通用导出 `encryptSecret` / `decryptSecret`），KEK 取 `UPLOAD_SIGNING_KEY`
 * ——`requiredSecrets()` 常驻的随机值，本功能不新增任何环境变量。
 *
 * 读取分三态，界面据此给不同引导：
 *   - `absent`      没有密文行 → 去设置页配置；
 *   - `unreadable`  有行但解不开（KEK 轮换过、密文形状不认识）→ 去设置页重新保存；
 *   - `ok`          明文只在内存里返回，不写入任何日志。
 *
 * 明文与密文都不出服务端：状态接口只回 `{configured, tokenHint, updatedAtMs}`。
 */

import {encryptSecret, decryptSecret} from "@/server/webhooks/crypto";
import {AppError} from "@/shared/errors";

/** 本模块只用到这两个绑定；窄接口让测试可以传入替身。 */
export interface CloudUsageTokenEnv {
  FEED_DB: D1Database;
  UPLOAD_SIGNING_KEY: string;
}

export interface CloudflareTokenStatus {
  configured: boolean;
  /** 末四位提示（形如 `…a1b2`）；未配置时为空串。 */
  tokenHint: string;
  /** 最近一次保存时刻（unix 毫秒）；未配置时为 null。 */
  updatedAtMs: number | null;
}

export type CloudflareTokenRead =
  | {state: "absent"}
  | {state: "unreadable"}
  | {state: "ok"; token: string; tokenHint: string};

/** 全局只有一枚 Token，行号固定。 */
const TOKEN_ROW_ID = 1;

/**
 * Cloudflare Token 的实际长度是 40 个字符。上限取 200 是为了容纳未来的格式变化，
 * 同时挡住把整段配置或私钥误粘进输入框的情形。
 */
const TOKEN_MAX_LENGTH = 200;

/** 末四位提示：明文只在服务端参与计算，写入数据库的只有这四个字符。 */
function hintOf(token: string): string {
  return `…${token.slice(-4)}`;
}

/**
 * 校验并归一化用户粘贴的值。空白字符一律拒绝——Token 中间夹换行通常意味着
 * 复制时带上了别的行，静默去掉会存进一个「看起来能用」的错误值。
 */
function normalizeToken(raw: string): string {
  const token = raw.trim();
  if (!token || token.length > TOKEN_MAX_LENGTH || /\s/u.test(token)) {
    throw new AppError("errors.cloudUsage.invalidToken");
  }
  return token;
}

/** KEK 缺失只可能发生在绑定被破坏时；保存动作直接报错，不写半条记录。 */
function encryptionKeyOf(env: CloudUsageTokenEnv): string {
  const key = env.UPLOAD_SIGNING_KEY;
  if (!key) throw new AppError("errors.cloudUsage.missingEncryptionKey");
  return key;
}

/**
 * 读 Token 三态。`ok` 时返回明文，调用方只能把它交给 Cloudflare 客户端，
 * 不得写进日志、响应或任何持久化位置。
 */
export async function readCloudflareToken(
  env: CloudUsageTokenEnv,
): Promise<CloudflareTokenRead> {
  // `WHERE id = ?` 命中 INTEGER PRIMARY KEY，扫描 1 行、读取 1 行；
  // 这是整个看板唯一的 D1 读取，业务表 0 行。
  const row = await env.FEED_DB.prepare(
    "SELECT token_cipher, token_hint FROM ext_cloud_usage_token WHERE id = ?",
  ).bind(TOKEN_ROW_ID).first<{token_cipher: string; token_hint: string}>();
  if (!row) return {state: "absent"};

  const key = env.UPLOAD_SIGNING_KEY;
  if (!key) return {state: "unreadable"};

  try {
    const token = await decryptSecret(row.token_cipher, key);
    if (!token) return {state: "unreadable"};
    return {state: "ok", token, tokenHint: row.token_hint};
  } catch {
    // 解密失败是设计内的一种状态（KEK 轮换、密文损坏），不是异常路径：
    // 界面据此引导重新保存，而调用方需要拿到一个可判定的结果。
    return {state: "unreadable"};
  }
}

/** 加密并 upsert 单行；同一次调用算出末四位提示与更新时刻。 */
export async function saveCloudflareToken(
  env: CloudUsageTokenEnv,
  raw: string,
): Promise<CloudflareTokenStatus> {
  const token = normalizeToken(raw);
  const cipher = await encryptSecret(token, encryptionKeyOf(env));
  const hint = hintOf(token);
  const updatedAtMs = Date.now();
  await env.FEED_DB.prepare(
    "INSERT INTO ext_cloud_usage_token (id, token_cipher, token_hint, updated_at_ms) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "token_cipher = excluded.token_cipher, " +
      "token_hint = excluded.token_hint, " +
      "updated_at_ms = excluded.updated_at_ms",
  ).bind(TOKEN_ROW_ID, cipher, hint, updatedAtMs).run();
  return {configured: true, tokenHint: hint, updatedAtMs};
}

/** 清除即删行，仪表盘回到引导态——单一来源，行为唯一且可预期。 */
export async function clearCloudflareToken(
  env: CloudUsageTokenEnv,
): Promise<CloudflareTokenStatus> {
  await env.FEED_DB.prepare(
    "DELETE FROM ext_cloud_usage_token WHERE id = ?",
  ).bind(TOKEN_ROW_ID).run();
  return {configured: false, tokenHint: "", updatedAtMs: null};
}

/** 状态查询：只回三样，密文与明文都不出现。 */
export async function cloudflareTokenStatus(
  env: CloudUsageTokenEnv,
): Promise<CloudflareTokenStatus> {
  const row = await env.FEED_DB.prepare(
    "SELECT token_hint, updated_at_ms FROM ext_cloud_usage_token WHERE id = ?",
  ).bind(TOKEN_ROW_ID).first<{token_hint: string; updated_at_ms: number}>();
  if (!row) return {configured: false, tokenHint: "", updatedAtMs: null};
  return {
    configured: true,
    tokenHint: row.token_hint,
    updatedAtMs: row.updated_at_ms,
  };
}
