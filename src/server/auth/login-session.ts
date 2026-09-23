/**
 * Establish a better-auth session for a user without a password or passkey.
 *
 * This is the "credential sign-in" primitive: the caller has already verified a
 * login credential and resolved `userId`, and this module turns that into a real
 * `auth_session` row plus the matching session cookie — so every downstream
 * consumer (middleware, RBAC resolution, account pages) sees an ordinary
 * session and none of them need to know about login credentials.
 *
 * Why the cookie is hand-serialized: better-auth's own `setSessionCookie` needs
 * the per-request endpoint context (`ctx.setSignedCookie`), which does not exist
 * outside `auth.handler`. Its runtime uses `better-call`'s signing, which is a
 * plain `HMAC-SHA256(secret, value)` appended as `value.<base64>`. We reproduce
 * that here and pin the round trip with a worker test that feeds the produced
 * cookie back through `auth.api.getSession` — if better-auth ever changes the
 * scheme, that test fails instead of production sessions silently breaking.
 */

import {createMicrofeedAuth} from "@/server/auth/better-auth";

const encoder = new TextEncoder();

/** The subset of better-auth's context we depend on (typed narrowly on purpose). */
interface LoginSessionContext {
  authCookies: {
    sessionToken: {
      attributes: {
        domain?: string;
        httpOnly?: boolean;
        maxAge?: number;
        path?: string;
        sameSite?: "lax" | "none" | "strict";
        secure?: boolean;
      };
      name: string;
    };
  };
  internalAdapter: {
    createSession(
      userId: string,
      dontRememberMe?: boolean,
    ): Promise<{token: string} | null>;
  };
  secret: string;
  sessionConfig: {expiresIn: number};
}

async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {hash: "SHA-256", name: "HMAC"},
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  const base64 = btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  );
  return encodeURIComponent(`${value}.${base64}`);
}

function serializeCookie(
  name: string,
  value: string,
  attributes: LoginSessionContext["authCookies"]["sessionToken"]["attributes"],
): string {
  let cookie = `${name}=${value}`;
  if (typeof attributes.maxAge === "number" && attributes.maxAge >= 0) {
    cookie += `; Max-Age=${Math.floor(attributes.maxAge)}`;
  }
  if (attributes.domain) cookie += `; Domain=${attributes.domain}`;
  if (attributes.path) cookie += `; Path=${attributes.path}`;
  if (attributes.httpOnly) cookie += "; HttpOnly";
  if (attributes.secure) cookie += "; Secure";
  if (attributes.sameSite) {
    cookie +=
      `; SameSite=${attributes.sameSite.charAt(0).toUpperCase()}${
        attributes.sameSite.slice(1)
      }`;
  }
  return cookie;
}

/**
 * Create a session for `userId` and return the `Set-Cookie` values the caller
 * must attach to its response. Throws when better-auth refuses to create the
 * session.
 */
export async function createLoginSessionCookies(
  runtimeEnv: Env,
  request: Request,
  userId: string,
): Promise<string[]> {
  const auth = createMicrofeedAuth(runtimeEnv, request) as unknown as {
    $context: Promise<LoginSessionContext>;
  };
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId, false);
  if (!session) {
    throw new Error("Unable to create a session for this login credential.");
  }
  const cookie = context.authCookies.sessionToken;
  const value = await signCookieValue(session.token, context.secret);
  return [
    serializeCookie(cookie.name, value, {
      ...cookie.attributes,
      maxAge: context.sessionConfig.expiresIn,
    }),
  ];
}
