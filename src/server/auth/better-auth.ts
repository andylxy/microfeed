import {oauthProvider} from "@better-auth/oauth-provider";
import {passkey} from "@better-auth/passkey";
import {betterAuth} from "better-auth";
import {username} from "better-auth/plugins";

import {oauthConnectionHandoff} from "@/server/auth/account-security";
import {
  MAX_ADMIN_PASSWORD_LENGTH,
  MAX_ADMIN_USERNAME_LENGTH,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_ADMIN_USERNAME_LENGTH,
} from "@/shared/AdminCredentials";
import {adminUrl, normalizeAdminPath} from "@/shared/AdminPath";
import {
  MICROFEED_OAUTH_CLIENT_ID,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_ACCESS_TOKEN_SECONDS,
  OAUTH_CLIENT_SECRET_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_SECONDS,
  OAUTH_SCOPES,
} from "@/shared/OAuth";

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export function createMicrofeedAuth(
  runtimeEnv: Env,
  request: Request,
) {
  return buildAuth(runtimeEnv, request, false);
}

/**
 * 放开公开注册原语的实例，**只允许邮箱注册链路调用**。
 *
 * 为什么需要它：全站 `disableSignUp: true`，公开注册原语 `signUpEmail` 默认不
 * 可用。匿名邮箱注册链路仍要它——原语由 better-auth 自己完成 `auth_user` 与
 * `auth_account` 双表写入，并带上邮箱唯一的冲突判定与口令哈希，本链路不必再
 * 拼一遍语句。注册只在这里临时打开。
 *
 * 安全边界没有移动：实例是按请求新建的，只有拿到它的调用方才受影响。公开路由
 * `/api/auth/sign-up/email` 由 `[...all].ts` 用默认实例服务，注册保持关闭。
 * 调用前置条件是「刚刚校验通过一条邮箱验证码」，验证码本身就是建号授权。
 *
 * 本函数仅供 `src/server/auth/email-signup.ts` 使用；端点不直接接触它，避免
 * 「临时放开注册」这件事扩散到别处。
 */
export function createSignUpEnabledAuth(
  runtimeEnv: Env,
  request: Request,
) {
  return buildAuth(runtimeEnv, request, true);
}

function buildAuth(
  runtimeEnv: Env,
  request: Request,
  allowSignUp: boolean,
) {
  const origin = new URL(request.url).origin;
  const adminPath = normalizeAdminPath(runtimeEnv.MICROFEED_ADMIN_PATH);
  return betterAuth({
    account: {
      modelName: "auth_account",
    },
    advanced: {
      cookiePrefix: "microfeed",
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      useSecureCookies: new URL(request.url).protocol === "https:",
    },
    basePath: "/api/auth",
    baseURL: origin,
    database: runtimeEnv.FEED_DB,
    disabledPaths: [
      "/oauth2/create-client",
      "/oauth2/delete-client",
      "/oauth2/update-client",
      "/oauth2/client/rotate-secret",
    ],
    emailAndPassword: {
      disableSignUp: !allowSignUp,
      enabled: true,
      // 只做长度门：口令的组合规则 better-auth 没有钩子，由我们自己的校验器
      // 负责。两边都从 `@/shared/AdminCredentials` 取上下限，不会各写一套。
      maxPasswordLength: MAX_ADMIN_PASSWORD_LENGTH,
      minPasswordLength: MIN_ADMIN_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
    },
    plugins: [
      passkey({
        origin,
        rpID: new URL(origin).hostname,
        rpName: "microfeed",
        schema: {
          passkey: {modelName: "passkey"},
        },
      }),
      // Lets an account sign in with a username as well as an address. The
      // plugin owns the two columns (see migration 0039) and re-validates every
      // value it stores, including uniqueness; the bounds come from
      // `@/shared/AdminCredentials` so the admin form cannot accept something
      // this rejects.
      username({
        maxUsernameLength: MAX_ADMIN_USERNAME_LENGTH,
        minUsernameLength: MIN_ADMIN_USERNAME_LENGTH,
      }),
      oauthProvider({
        accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_SECONDS,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        cachedTrustedClients: new Set([MICROFEED_OAUTH_CLIENT_ID]),
        clientPrivileges: () => true,
        clientRegistrationAllowedScopes: [
          OAUTH_SCOPES.READ,
          OAUTH_SCOPES.WRITE,
          OAUTH_SCOPES.OFFLINE,
        ],
        clientRegistrationDefaultScopes: [OAUTH_SCOPES.READ],
        consentPage: adminUrl("api/oauth/consent", adminPath),
        disableJwtPlugin: true,
        grantTypes: ["authorization_code", "refresh_token"],
        loginPage: adminUrl("login", adminPath),
        prefix: {
          clientSecret: OAUTH_CLIENT_SECRET_PREFIX,
          opaqueAccessToken: OAUTH_ACCESS_TOKEN_PREFIX,
          refreshToken: OAUTH_REFRESH_TOKEN_PREFIX,
        },
        postLogin: {
          consentReferenceId: async () =>
            (await oauthConnectionHandoff(
              request,
              runtimeEnv.BETTER_AUTH_SECRET,
            ))?.connectionId,
          page: adminUrl("api/oauth/consent", adminPath),
          shouldRedirect: () => false,
        },
        refreshTokenExpiresIn: OAUTH_REFRESH_TOKEN_SECONDS,
        schema: {
          oauthAccessToken: {modelName: "oauth_access_token"},
          oauthClient: {modelName: "oauth_client"},
          oauthConsent: {modelName: "oauth_consent"},
          oauthRefreshToken: {modelName: "oauth_refresh_token"},
        },
        scopes: [
          OAUTH_SCOPES.READ,
          OAUTH_SCOPES.WRITE,
          OAUTH_SCOPES.OFFLINE,
        ],
        silenceWarnings: {oauthAuthServerConfig: true},
        storeTokens: "hashed",
        validAudiences: [origin],
      }),
    ],
    rateLimit: {
      customRules: {
        "/sign-in/email": {
          max: 5,
          window: 60,
        },
        "/verify-password": {
          max: 5,
          window: 60,
        },
      },
      enabled: true,
      max: 100,
      modelName: "auth_rate_limit",
      storage: "database",
      window: 60,
    },
    secret: runtimeEnv.BETTER_AUTH_SECRET,
    session: {
      expiresIn: THIRTY_DAYS,
      modelName: "auth_session",
      updateAge: 60 * 60 * 24,
    },
    user: {
      modelName: "auth_user",
    },
    verification: {
      modelName: "auth_verification",
    },
    trustedOrigins: [origin],
  });
}

export function withAuthSessionCookies(
  response: Response,
  authHeaders: Headers,
): Response {
  const cookies = authHeaders.getSetCookie();
  if (cookies.length === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  cookies.forEach((cookie) => headers.append("set-cookie", cookie));
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export type MicrofeedAuth = ReturnType<typeof createMicrofeedAuth>;
