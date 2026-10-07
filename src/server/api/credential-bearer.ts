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
  markLoginCredentialUsed,
  verifyLoginCredentialToken,
} from "@/server/auth/login-credentials";
import {clientAddress} from "@/server/auth/client-address";
import {
  loginThrottleAllows,
  recordLoginFailure,
} from "@/server/auth/login-throttle";
import {
  accountIsBlocked,
  isDeviceRevoked,
  permissionsInclude,
  registerUserDevice,
  resolveUserPermissions,
} from "@/server/rbac/resolve";
import {LOGIN_CREDENTIAL_PREFIX} from "@/shared/LoginCredential";
import {apiPathDetails, type ApiAttribution} from "./access";
import {requiredApiPermission} from "./api-permissions";

/** Throttle bucket for this path; paired with the client address in the key. */
const THROTTLE_KEY_SUFFIX = ":/api/bearer";

export type CredentialBearerDecision =
  | {kind: "allow"; attribution: ApiAttribution}
  | {kind: "deviceRevoked"}
  | {kind: "forbidden"; attribution: ApiAttribution}
  | {kind: "notFound"}
  | {kind: "reference"}
  | {kind: "throttled"}
  | {kind: "unauthorized"};

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
): Promise<CredentialBearerDecision> {
  const details = apiPathDetails(pathname);
  if (!details) return {kind: "notFound"};
  if (details.kind === "reference") return {kind: "reference"};

  // The caller must present a `mflc_…` bearer on every request. There is no
  // hardcoded fallback key: a request without one is rejected as unauthorized.
  const token = providedLoginCredential(request);
  if (!token) return {kind: "unauthorized"};

  // Throttle before the lookup runs: the token is a bearer secret, so this path
  // is guessable material in exactly the way the sign-in endpoint already is.
  // B13: with no client address, skip the IP dimension instead of falling back
  // to a shared "unknown" bucket that would lock out every addressless caller.
  const ip = clientAddress(request);
  const throttleKey = ip ? `${ip}${THROTTLE_KEY_SUFFIX}` : null;
  if (throttleKey && !await loginThrottleAllows(database, throttleKey)) {
    return {kind: "throttled"};
  }

  const verified = await verifyLoginCredentialToken(database, token);
  if (!verified) {
    if (throttleKey) await recordLoginFailure(database, throttleKey);
    return {kind: "unauthorized"};
  }

  // Only an unresolvable token counts as a brute-force failure; a valid token
  // whose permissions fall short is an authorization outcome, not a guess.
  if (await accountIsBlocked(database, verified.userId)) {
    return {kind: "unauthorized"};
  }

  // Device registration + revocation for login-credential API calls (ADR-0006).
  // This path never called `resolveRbacContext`, so without these two calls an
  // App device never reached the admin board, and a revoked device kept reading
  // data.
  //
  // Scope note: this is deliberately **not** narrowed to `/api/AppBookRequest/*`.
  // Revocation is a property of the calling *device*, so applying it on every
  // credential-backed integration path keeps one device from being blocked on
  // the App content endpoints while still reading through `/api/content/*` with
  // the same credential. The admin branch already behaves this way for every
  // admin request (`resolveRbacContext`). Callers that send no `x-device-id`
  // (everyone today except the App) are unaffected.
  //
  // Revocation is checked before the upsert so a revoked row stays revoked.
  if (await isDeviceRevoked(database, verified.userId, request)) {
    return {kind: "deviceRevoked"};
  }
  await registerUserDevice(database, verified.userId, request);

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
  // than silently allowing it.
  const permissionCode = requiredApiPermission(pathname, request.method);
  const permissions = await resolveUserPermissions(database, verified.userId);
  const attribution: ApiAttribution = {
    apiKeyId: null,
    credentialId: verified.credentialId,
    permissionCode,
    userId: verified.userId,
  };
  const granted =
    permissionCode !== null && permissionsInclude(permissions, permissionCode);
  if (!granted) {
    return {kind: "forbidden", attribution};
  }
  // "Last used" means a call this credential actually got through, so it is
  // recorded only once authorization has passed.
  await markLoginCredentialUsed(database, verified.credentialId);
  return {kind: "allow", attribution};
}
