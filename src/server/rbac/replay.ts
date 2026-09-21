/**
 * Replay defense for sensitive APP-originated writes (DESIGN.md L2).
 *
 * Enforced only when the request carries the `X-Nonce` / `X-Timestamp` pair
 * (the APP backend sends these). The web admin never sends them, so browser
 * traffic passes through untouched.
 *
 * - `X-Timestamp` must be within ±5 minutes of now.
 * - `X-Nonce` is de-duplicated in `ext_replay_nonces` with `INSERT OR IGNORE`;
 *   a reused nonce (within its expiry window) is rejected with 400.
 */

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export async function checkReplay(
  db: D1Database,
  request: Request,
): Promise<Response | null> {
  const nonce = request.headers.get("x-nonce");
  const timestampHeader = request.headers.get("x-timestamp");
  if (!nonce || !timestampHeader) {
    // Not a replay-protected (APP) request; web admin path is allowed through.
    return null;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return new Response("Invalid replay timestamp", {status: 400});
  }

  const now = Date.now();
  if (Math.abs(now - timestamp) > REPLAY_WINDOW_MS) {
    return new Response("Replay timestamp out of window", {status: 400});
  }

  const nowIso = new Date(now).toISOString();
  // D1 has no TTL: prune expired nonces before inserting.
  await db
    .prepare("DELETE FROM ext_replay_nonces WHERE exp_at < ?")
    .bind(nowIso)
    .run();

  const expiry = new Date(timestamp + REPLAY_WINDOW_MS).toISOString();
  const inserted = await db
    .prepare(
      "INSERT OR IGNORE INTO ext_replay_nonces (nonce, exp_at) VALUES (?, ?)",
    )
    .bind(nonce, expiry)
    .run();

  if ((inserted.meta?.changes ?? 0) === 0) {
    return new Response("Replay detected", {status: 400});
  }

  return null;
}
