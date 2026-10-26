/**
 * Sessionless bearer authentication for the public API, using a login
 * credential (`mflc_…`).
 *
 * This is the "no session, token on every request" half of the credential
 * feature: an API client that holds a credential can call `/api/*` directly
 * without first trading it for a cookie. Authorization is delegated to RBAC —
 * the token only establishes *which user* is calling.
 *
 * Two properties are worth naming:
 *  - the credential signs nothing, so the bearer rides on every request and the
 *    only anti-replay control is revocation plus the sign-in throttle;
 *  - failed attempts are throttled per client address, because the token is a
 *    bearer secret the caller could otherwise keep guessing.
 *
 * A credential call is attributed and audited like a signed call: the decision
 * carries an `ApiAttribution` (with `apiKeyId: null`) so the middleware writes
 * an `ext_api_access_log` row on both the allow and the deny path.
 */

import {
  loginCredentialVerifyStatement,
  verifiedLoginCredentialFromRow,
  type LoginCredentialLookupRow,
} from "@/server/auth/login-credentials";
import {clientAddress} from "@/server/auth/client-address";
import {
  loginThrottleRowAllows,
  loginThrottleSelectStatement,
  recordLoginFailure,
  type LoginThrottleRow,
} from "@/server/auth/login-throttle";
import {
  deviceRevocationStatement,
  deviceRevokedFromRow,
  permissionsInclude,
} from "@/server/rbac/resolve";
import type {AppRequestQuotaRow} from "@/server/rbac/app-quota";
import {cachedUserAccess} from "@/server/cache/identity-cache";
import {LOGIN_CREDENTIAL_PREFIX} from "@/shared/LoginCredential";
import {apiPathDetails, type ApiAttribution} from "./access";
import {requiredApiPermission} from "./api-permissions";

/** Throttle bucket for this path; paired with the client address in the key. */
const THROTTLE_KEY_SUFFIX = ":/api/bearer";

export type CredentialBearerDecision =
  | {
    kind: "allow";
    attribution: ApiAttribution;
    isMember: boolean;
    /** 权限集合同趟带出（ADR-0049 D11）：middleware 挂进 locals 供能力端点复用。 */
    permissions: Set<string>;
    /**
     * 批次二取回的配额计数行（方案 6）：只在调用方要求计数时出现。
     * `row` 为 null 表示该凭证还没有计数行；UPSERT 仍由调用方在版本门后单独执行。
     */
    quota?: {credentialId: string; row: AppRequestQuotaRow | null};
  }
  | {kind: "deviceRevoked"}
  | {kind: "forbidden"; attribution: ApiAttribution}
  | {kind: "notFound"}
  | {kind: "reference"}
  | {kind: "throttled"}
  | {kind: "unauthorized"};

export interface CredentialBearerOptions {
  /**
   * 批次二与设备吊销同批执行的配额 SELECT。返回 null 表示本路径不计数。
   * 只取行，不写库——拒绝路径的写入必须为零。
   */
  quotaSelect?: (credentialId: string) => D1PreparedStatement | null;
}

/** `db.batch` 的结果里取第一行。 */
function rowOf<T>(result: D1Result | undefined): T | null {
  const row = result?.results?.[0];
  return row === undefined ? null : row as T;
}

/** The presented `mflc_…` bearer token, if any (other bearers are left alone). */
export function providedLoginCredential(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  const token = match?.[1]?.trim();
  return token?.startsWith(LOGIN_CREDENTIAL_PREFIX) ? token : null;
}

export async function decideLoginCredentialApiRequest(
  database: D1Database,
  request: Request,
  pathname: string,
  options: CredentialBearerOptions = {},
): Promise<CredentialBearerDecision> {
  const details = apiPathDetails(pathname);
  if (!details) return {kind: "notFound"};
  if (details.kind === "reference") return {kind: "reference"};

  // The caller must present a `mflc_…` bearer on every request. There is no
  // hardcoded fallback key: a request without one is rejected as unauthorized.
  const token = providedLoginCredential(request);
  if (!token) return {kind: "unauthorized"};

  // The token is a bearer secret, so this path is guessable material in exactly
  // the way the sign-in endpoint already is. B13: with no client address, skip
  // the IP dimension instead of falling back to a shared "unknown" bucket that
  // would lock out every addressless caller.
  const ip = clientAddress(request);
  const throttleKey = ip ? `${ip}${THROTTLE_KEY_SUFFIX}` : null;

  // 批次一（方案 6）：限流桶按 IP、凭证 JOIN 按 token，互不依赖，一次往返取回。
  const credentialStatement = await loginCredentialVerifyStatement(database, token);
  if (!credentialStatement) return {kind: "unauthorized"};
  const throttleStatement = throttleKey
    ? loginThrottleSelectStatement(database, throttleKey)
    : null;
  const preludeStatements = throttleStatement
    ? [throttleStatement, credentialStatement]
    : [credentialStatement];
  const prelude = await database.batch(preludeStatements);
  const throttleRow = throttleStatement
    ? rowOf<LoginThrottleRow>(prelude[0])
    : null;
  if (throttleStatement && !loginThrottleRowAllows(throttleRow)) {
    return {kind: "throttled"};
  }

  const verified = verifiedLoginCredentialFromRow(
    rowOf<LoginCredentialLookupRow>(prelude[throttleStatement ? 1 : 0]),
  );
  if (!verified) {
    if (throttleKey) await recordLoginFailure(database, throttleKey);
    return {kind: "unauthorized"};
  }

  // 封禁标记与验票同一趟 LEFT JOIN 取回（方案 4.4）。Only an unresolvable
  // token counts as a brute-force failure; a valid token whose permissions fall
  // short is an authorization outcome, not a guess.
  if (verified.banned) {
    return {kind: "unauthorized"};
  }

  // 批次二（方案 6）：设备吊销与配额 SELECT 都依赖批次一的结果，二者同批执行。
  // The upsert that records the device heartbeat lives in the middleware now
  // (scheduled through `waitUntil` once the call is authorized), so it stays off
  // the critical path; the revocation *check* stays here because its result
  // decides the response.
  //
  // Scope note: this is deliberately **not** narrowed to `/api/AppBookRequest/*`.
  // Revocation is a property of the calling *device*, so applying it on every
  // credential-backed integration path keeps one device from being blocked on
  // the App content endpoints while still reading through `/api/content/*` with
  // the same credential. The admin branch already behaves this way for every
  // admin request (`resolveRbacContext`). Callers that send no `x-device-id`
  // (everyone today except the App) are unaffected.
  const deviceStatement = deviceRevocationStatement(database, verified.userId, request);
  const quotaStatement = options.quotaSelect?.(verified.credentialId) ?? null;
  const postAuthStatements: D1PreparedStatement[] = [];
  let deviceIndex = -1;
  if (deviceStatement) {
    deviceIndex = postAuthStatements.length;
    postAuthStatements.push(deviceStatement);
  }
  let quotaIndex = -1;
  if (quotaStatement) {
    quotaIndex = postAuthStatements.length;
    postAuthStatements.push(quotaStatement);
  }
  let deviceRevoked = false;
  let quotaRow: AppRequestQuotaRow | null = null;
  if (postAuthStatements.length > 0) {
    const postAuth = await database.batch(postAuthStatements);
    if (deviceIndex >= 0) {
      deviceRevoked = deviceRevokedFromRow(
        rowOf<{status: string}>(postAuth[deviceIndex]),
      );
    }
    if (quotaIndex >= 0) {
      quotaRow = rowOf<AppRequestQuotaRow>(postAuth[quotaIndex]);
    }
  }
  if (deviceRevoked) {
    return {kind: "deviceRevoked"};
  }

  // Account gates on this path are banned + device-revoked (above). The fourth
  // gate — `must_change_password` -> 428 — is deliberately **not** applied: a
  // sessionless API caller has no way to complete an interactive password
  // change, so the gate would only wall it off. It is dormant regardless
  // (nothing sets the flag; see `RbacResolved` in `resolve.ts`), while the admin
  // session path still enforces it for interactive users.
  //
  // The credential authenticates the user; `requiredApiPermission` decides what
  // the user may do. After A1 every integration path maps to a code, so a `null`
  // here means the path is outside the mapped set — deny it (fail-closed) rather
  // than silently allowing it. 数组形态是任一双码门（migration 0131）：持其中
  // 任意一个码即放行；审计行记下实际放行的那一个码，全不中时记首个（受检码）。
  const required = requiredApiPermission(pathname, request.method);
  const requiredCodes = required === null
    ? []
    : typeof required === "string" ? [required] : required;
  // 权限码与会员标记同一趟查询取回：会员标记由鉴权结果下发给内容端点，
  // 端点不必再查一次角色。角色对象按 userId 缓存 24h（方案 4.3），
  // RBAC 写路径按用户清。
  const access = await cachedUserAccess(database, verified.userId);
  const grantedCode = requiredCodes.find(
    (code) => permissionsInclude(access.permissions, code),
  );
  const attribution: ApiAttribution = {
    apiKeyId: null,
    credentialId: verified.credentialId,
    permissionCode: grantedCode ?? requiredCodes[0] ?? null,
    userId: verified.userId,
  };
  if (!grantedCode) {
    return {kind: "forbidden", attribution};
  }
  // "Last used" is recorded by the middleware through `waitUntil` once this
  // decision comes back as `allow` — it still only fires for calls that got
  // through authorization, but no longer costs a round trip on the way out.
  // 权限集合同趟带出（ADR-0049 D11）：middleware 挂进 locals，能力端点复用，
  // 不再各自 resolveUserPermissions。
  return {
    kind: "allow",
    attribution,
    isMember: access.isMember,
    permissions: access.permissions,
    ...(quotaStatement
      ? {quota: {credentialId: verified.credentialId, row: quotaRow}}
      : {}),
  };
}
