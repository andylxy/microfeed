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
 * - `X-Nonce` is de-duplicated in `ext_rate_limit`（`kind = 'replay-nonce'`）with
 *   `INSERT OR IGNORE`; a reused nonce (within its expiry window) is rejected
 *   with 400.
 *
 * 本文件只剩请求头解析与 400 响应；去重与过期行清理在
 * `server/rate-limit/once.ts`，保留期取自 `REPLAY_NONCE`。
 */

import {REPLAY_NONCE} from "@/server/rate-limit/kinds";
import {insertOnce} from "@/server/rate-limit/once";

const REPLAY_WINDOW_MS = REPLAY_NONCE.retentionMs;

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

  // 过期时刻按请求自带的时刻算：这条 nonce 只在它所属的时间窗口内有意义。
  // 过期行由写入路径的 1% 采样清理（ADR-0049 D4），残留不影响去重正确性。
  const inserted = await insertOnce(
    db,
    REPLAY_NONCE.kind,
    nonce,
    timestamp + REPLAY_WINDOW_MS,
  );
  if (!inserted) {
    return new Response("Replay detected", {status: 400});
  }

  return null;
}
