/**
 * Small, dependency-free Web Crypto helpers shared by the client-side request
 * signer (`api-signing.ts`) and the server-side verifier (`signed-call.ts`).
 *
 * Keeping both sides in this one module guarantees the canonicalization and the
 * HMAC key derivation are byte-for-byte identical — a mismatch would make every
 * signature fail to verify.
 */

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(
  key: string,
  message: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    {hash: "SHA-256", name: "HMAC"},
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return toHex(new Uint8Array(signature));
}

/** Constant-time hexadecimal string comparison (timing-attack safe). */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Canonicalize a query string the way XiHan BasicApp does: sort by key (ordinal)
 * then value, percent-encode each, join with `&`. Accepts a leading `?`.
 */
export function canonicalizeQuery(query: string): string {
  const trimmed = query.startsWith("?") ? query.slice(1) : query;
  if (!trimmed) return "";
  const entries = [...new URLSearchParams(trimmed).entries()].sort(
    (left, right) => {
      if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
      if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
      return 0;
    },
  );
  return entries
    .map(([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}
