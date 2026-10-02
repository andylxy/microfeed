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
  RBAC_WILDCARD,
  resolveUserPermissions,
} from "@/server/rbac/resolve";
import {LOGIN_CREDENTIAL_PREFIX} from "@/shared/LoginCredential";
import {apiPathDetails, type ApiAttribution} from "./access";
import {requiredApiPermission} from "./api-permissions";

/**
 * Fallback login credential used by the mobile app. The legacy .NET backend
 * served the `/api/AppBookRequest/*` content endpoints without requiring the
 * app to present a bearer on every call; the app therefore does not always send
 * `Authorization: Bearer mflc_…`. When such a request arrives without a
 * credential, the middleware injects this default key so the request still
 * resolves to a user that holds `app:mobile:access` and the app keeps working.
 * Reference: user instruction to "add the default key when the request carries
 * no `Authorization: Bearer mflc_`". No new endpoint or feature is introduced.
 */
export const DEFAULT_APP_LOGIN_CREDENTIAL =
  "mflc_4ee17b881c8aaf49005522b1254950727985a9260321247c4cd0b8ebdc655a82";

/** Throttle bucket for this path; paired with the client address in the key. */
const THROTTLE_KEY_SUFFIX = ":/api/bearer";

export type CredentialBearerDecision =
  | {kind: "allow"; attribution: ApiAttribution}
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
  defaultKey: string | null = null,
): Promise<CredentialBearerDecision> {
  const details = apiPathDetails(pathname);
  if (!details) return {kind: "notFound"};
  if (details.kind === "reference") return {kind: "reference"};

  // A caller-supplied `mflc_…` bearer wins; otherwise fall back to the default
  // app key (see {@link DEFAULT_APP_LOGIN_CREDENTIAL}) so the mobile app, which
  // may omit the header, is still attributed to a user with `app:mobile:access`.
  const token = providedLoginCredential(request) ?? defaultKey;
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
    permissionCode !== null &&
    (permissions.has(RBAC_WILDCARD) || permissions.has(permissionCode));
  if (!granted) {
    return {kind: "forbidden", attribution};
  }
  // "Last used" means a call this credential actually got through, so it is
  // recorded only once authorization has passed.
  await markLoginCredentialUsed(database, verified.credentialId);
  return {kind: "allow", attribution};
}
