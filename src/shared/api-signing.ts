/**
 * Client-side request signer for microfeed's signed API call (XiHan BasicApp
 * model). Use this in the browser, Node, or any external client to call the API
 * with an API credential instead of a bearer token.
 *
 * The HMAC key is `SHA-256(secret)` — identical to what the server stores — so a
 * client given the plaintext secret can derive the key locally. Keep the secret
 * out of logs; it is shown by the dashboard only once.
 */

import {
  canonicalizeQuery,
  hmacSha256Hex,
  sha256Hex,
} from "./crypto";

export interface SignRequestOptions {
  method: string;
  path: string;
  /** Raw query string (with or without leading `?`), already URL-encoded. */
  query?: string;
  /** Request body as a string (JSON). Omit for GET/HEAD. */
  body?: string;
  accessKey: string;
  secret: string;
  /** Override for testing; defaults to the current time in milliseconds
   * (must match the server's `checkReplay`, which compares against `Date.now()`). */
  timestamp?: number;
  /** Override for testing; defaults to a random UUID. */
  nonce?: string;
}

export interface SignedHeaders {
  "x-access-key": string;
  "x-timestamp": string;
  "x-nonce": string;
  "x-signature": string;
  // Index signature so a signed-headers object is directly usable as a
  // `HeadersInit` (fetch / Request / new Headers).
  [key: string]: string;
}

export async function signRequest(
  options: SignRequestOptions,
): Promise<SignedHeaders> {
  const method = options.method.toUpperCase();
  // Milliseconds — the server's `checkReplay` compares this header against
  // `Date.now()` (ms). Sending seconds would always fall outside the ±5min
  // window and reject every signed call.
  const timestamp = options.timestamp ?? Date.now();
  const nonce = options.nonce ?? crypto.randomUUID();
  const canonicalQuery = canonicalizeQuery(options.query ?? "");
  const contentSign = await sha256Hex(options.body ?? "");
  const stringToSign =
    `${method}\n${options.path}\n${canonicalQuery}\n${contentSign}\n${timestamp}\n${nonce}`;
  // The HMAC key is the hash of the secret — the same value the server stores.
  const key = await sha256Hex(options.secret);
  const signature = await hmacSha256Hex(key, stringToSign);
  return {
    "x-access-key": options.accessKey,
    "x-timestamp": String(timestamp),
    "x-nonce": nonce,
    "x-signature": signature,
  };
}
