import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {
  createMicrofeedAuth,
  withAuthSessionCookies,
} from "@/server/auth/better-auth";
import {jsonResponse, localizedError, localizedTextError} from "@/server/http";
import {clearMustChangePassword} from "@/server/rbac/guard";
import {
  MIN_ADMIN_PASSWORD_LENGTH,
  validateAdminPassword,
} from "@/shared/AdminCredentials";

export const POST: APIRoute = async ({locals, request}) => {
  if (!locals.authUser?.id) return localizedTextError(request, "errors.account.notFound", 404);
  const body = await request.json().catch(() => null) as {
    currentPassword?: unknown;
    newPassword?: unknown;
    confirmation?: unknown;
  } | null;
  if (typeof body?.currentPassword !== "string" ||
      typeof body.newPassword !== "string" ||
      body.newPassword !== body.confirmation) {
    return localizedError(request, "errors.account.passwordMismatch", 400);
  }
  // Same policy as everywhere else that sets a password; better-auth's own
  // `minPasswordLength` only covers the length half of it.
  if (validateAdminPassword(body.newPassword)) {
    return localizedError(request, "errors.password.policy", 400, {
      min: String(MIN_ADMIN_PASSWORD_LENGTH),
    });
  }
  try {
    const changed = await createMicrofeedAuth(env, request).api.changePassword({
      body: {
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        revokeOtherSessions: true,
      },
      headers: request.headers,
      returnHeaders: true,
    });
    await clearMustChangePassword(env.FEED_DB, locals.authUser.id);
    return withAuthSessionCookies(
      jsonResponse({changed: true}),
      changed.headers,
    );
  } catch {
    return localizedError(request, "errors.account.currentPasswordIncorrect", 400);
  }
};
