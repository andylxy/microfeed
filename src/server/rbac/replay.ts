/**
 * Replay defense for APP-originated requests: a captured request body cannot be
 * re-submitted successfully because its nonce is single-use inside the replay
 * window.
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
  // D1 has no TTL: prune expired nonces before inserting. 写节流（ADR-0049
  // D4）：清理在每个带 nonce 的请求上都会跑（App 通道满额即 1 万次/日/凭证，
  // 每次一写），改为 1% 采样——表上限 = 10 分钟窗口 × 请求速率，残留的过期行
  // 不影响去重正确性（INSERT OR IGNORE 只比对 nonce 本身）。
  if (Math.random() < 0.01) {
    await db
      .prepare("DELETE FROM ext_replay_nonces WHERE exp_at < ?")
      .bind(nowIso)
      .run();
  }

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
