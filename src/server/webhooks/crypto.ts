import {AppError} from "@/shared/errors";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) =>
    character.charCodeAt(0)
  );
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0)
  );
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const bytes = await crypto.subtle.digest("SHA-256", textEncoder.encode(secret));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * AES-GCM 封装（通用）。D1 里的一切秘密都走这一份实现：webhook 签名 secret
 * 与 Cloudflare API Token。函数名里的 `Webhook` 是历史遗留（首个使用者），
 * 对外的通用名是 {@link encryptSecret} / {@link decryptSecret}。
 */
async function seal(
  plaintext: string,
  encryptionSecret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name: "AES-GCM", iv},
    await encryptionKey(encryptionSecret),
    textEncoder.encode(plaintext),
  );
  return JSON.stringify({
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    iv: base64UrlEncode(iv),
    version: 1,
  });
}

/** {@link seal} 的反向操作；`unsupportedKey` 是该调用方自己的错误文案键。 */
async function open(
  encrypted: string,
  encryptionSecret: string,
  unsupportedKey: string,
): Promise<string> {
  const parsed = JSON.parse(encrypted) as Record<string, unknown>;
  if (
    parsed.version !== 1 || typeof parsed.iv !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new AppError(unsupportedKey);
  }
  const plaintext = await crypto.subtle.decrypt(
    {name: "AES-GCM", iv: arrayBuffer(base64UrlDecode(parsed.iv))},
    await encryptionKey(encryptionSecret),
    arrayBuffer(base64UrlDecode(parsed.ciphertext)),
  );
  return textDecoder.decode(plaintext);
}

export async function encryptWebhookSecret(
  plaintext: string,
  encryptionSecret: string,
): Promise<string> {
  return seal(plaintext, encryptionSecret);
}

export async function decryptWebhookSecret(
  encrypted: string,
  encryptionSecret: string,
): Promise<string> {
  return open(encrypted, encryptionSecret, "errors.webhook.unsupportedSecretFormat");
}

/**
 * 通用秘密加密（Cloudflare API Token 等）。与 {@link encryptWebhookSecret} 同一份
 * 实现，独立命名是为了让新调用方读起来名实相符。
 */
export async function encryptSecret(
  plaintext: string,
  encryptionSecret: string,
): Promise<string> {
  return seal(plaintext, encryptionSecret);
}

/**
 * 通用秘密解密。密文形状不认识时抛 `errors.cloudUsage.unsupportedSecretFormat`
 * ——调用方据此把「解不开」与「没配置」区分成两种引导态。
 */
export async function decryptSecret(
  encrypted: string,
  encryptionSecret: string,
): Promise<string> {
  return open(encrypted, encryptionSecret, "errors.cloudUsage.unsupportedSecretFormat");
}

export function generateWebhookSecret(): string {
  return `whsec_${base64Encode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function signingSecretBytes(secret: string): Uint8Array {
  if (!secret.startsWith("whsec_")) {
    throw new AppError("errors.webhook.secretMustStartWithWhsec");
  }
  return base64Decode(secret.slice("whsec_".length));
}

export async function standardWebhookSignature(
  secret: string,
  deliveryId: string,
  timestamp: number,
  payload: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(signingSecretBytes(secret)),
    {hash: "SHA-256", name: "HMAC"},
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`${deliveryId}.${timestamp}.${payload}`),
  );
  return `v1,${base64Encode(new Uint8Array(signature))}`;
}
