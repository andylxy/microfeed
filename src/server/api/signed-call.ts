/**
 * Signed API call verification (XiHan BasicApp "open API, signature call" model).
 *
 * A client sends its access key in `X-Access-Key` plus an HMAC-SHA256 signature
 * over a canonical string. Verifying the signature proves possession of the
 * secret; looking the access key up in `ext_api_key_owners` proves *which user*
 * is calling. Authorization (what the user may do) is delegated to RBAC — this
 * module only establishes identity and the replay/integrity checks.
 *
 * The HMAC key is `SHA-256(secret)`; the server stores only that hash, so a DB
 * leak never exposes the raw secret. The client derives the same key from the
 * secret it was given once at issue time.
 */

import {checkReplay} from "@/server/rbac/replay";
import {
  canonicalizeQuery,
  constantTimeEqualHex,
  hmacSha256Hex,
  sha256Hex,
} from "@/shared/crypto";

export interface ApiIdentity {
  apiKeyId: string;
  userId: string;
  accessKey: string;
}

export type VerifySignedCallResult =
  | {ok: true; identity: ApiIdentity}
  | {ok: false; status: number; reason: string};

export async function verifySignedCall(
  database: D1Database,
  request: Request,
): Promise<VerifySignedCallResult> {
  const accessKey = request.headers.get("x-access-key");
  if (!accessKey) {
    return {ok: false, status: 401, reason: "missing_access_key"};
  }

  const timestamp = request.headers.get("x-timestamp");
  const nonce = request.headers.get("x-nonce");
  const signature = request.headers.get("x-signature");
  if (!timestamp || !nonce || !signature) {
    return {ok: false, status: 401, reason: "missing_signature_headers"};
  }

  // Replay + timestamp window (INSERT OR IGNORE into ext_replay_nonces).
  const replay = await checkReplay(database, request);
  if (replay) {
    return {ok: false, status: replay.status, reason: "replay"};
  }

  const row = await database.prepare(
    "SELECT id, secret_hash FROM api_keys WHERE api_key = ? LIMIT 1",
  ).bind(accessKey).first<{id: string; secret_hash: string | null}>();
  if (!row || !row.secret_hash) {
    return {ok: false, status: 401, reason: "unknown_key"};
  }

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const canonicalQuery = canonicalizeQuery(url.search);
  // Read the body from a clone so the original request stays intact for the
  // downstream route handler (a Worker request body can only be consumed once).
  const bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
  const contentSign = await sha256Hex(bodyBytes);
  const stringToSign =
    `${method}\n${url.pathname}\n${canonicalQuery}\n${contentSign}\n${timestamp}\n${nonce}`;
  const expected = await hmacSha256Hex(row.secret_hash, stringToSign);
  if (!constantTimeEqualHex(expected, signature)) {
    return {ok: false, status: 401, reason: "bad_signature"};
  }

  const owner = await database.prepare(
    "SELECT user_id FROM ext_api_key_owners WHERE api_key_id = ? LIMIT 1",
  ).bind(row.id).first<{user_id: string}>();
  if (!owner) {
    return {ok: false, status: 401, reason: "unowned_key"};
  }

  return {
    ok: true,
    identity: {apiKeyId: row.id, userId: owner.user_id, accessKey},
  };
}
