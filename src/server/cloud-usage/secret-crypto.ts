/**
 * cloud-usage 这一侧用的秘密加解密。
 *
 * 实现复用 `webhooks/crypto.ts` 的 AES-GCM——D1 里的一切秘密都走同一份实现
 * （webhook 签名 secret 与 Cloudflare API Token）。那两个导出名里的 `Webhook`
 * 只是历史遗留（首个使用者是 webhook），本模块给出通用名，让调用侧名实相符。
 *
 * 为什么不直接在上游文件里加导出：`webhooks/crypto.ts` 在 `origin/main` 上
 * 存在，仓库惯例是上游文件只做插行级改动、新逻辑进新文件，所以这里只做转发。
 */

import {decryptWebhookSecret, encryptWebhookSecret} from "@/server/webhooks/crypto";

/** 加密。KEK 由调用方给出（cloud-usage 用 `UPLOAD_SIGNING_KEY`）。 */
export function encryptSecret(
  plaintext: string,
  encryptionSecret: string,
): Promise<string> {
  return encryptWebhookSecret(plaintext, encryptionSecret);
}

/**
 * 解密。密文形状不认识时上游抛的是 webhook 专属文案的错误；调用方
 * （`token-store`）把解密失败整体当作设计内的 `unreadable` 状态处理，
 * 不会把那条文案透给用户，因此这里不再改写错误键。
 */
export function decryptSecret(
  encrypted: string,
  encryptionSecret: string,
): Promise<string> {
  return decryptWebhookSecret(encrypted, encryptionSecret);
}
