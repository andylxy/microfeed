/**
 * `/api/ping` — signed-call self-test (mirrors XiHan BasicApp's openapi/Ping).
 *
 * Identity is established purely by the signature, so this is the quickest way to
 * confirm the credential → user link works end to end: it echoes the access key
 * and the resolved owner user id.
 */

import {verifySignedCall} from "./signed-call";

export async function handleApiPing(
  database: D1Database,
  request: Request,
): Promise<Response> {
  const verified = await verifySignedCall(database, request);
  if (!verified.ok) {
    return new Response("Unauthorized", {
      headers: {"content-type": "text/plain; charset=utf-8"},
      status: 401,
    });
  }
  return Response.json({
    ok: true,
    accessKey: verified.identity.accessKey,
    ownerUserId: verified.identity.userId,
    serverTimeUtc: new Date().toISOString(),
  });
}
