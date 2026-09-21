import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {
  createMicrofeedAuth,
  withAuthSessionCookies,
} from "@/server/auth/better-auth";
import {jsonResponse, localizedError, localizedTextError} from "@/server/http";
import {clearMustChangePassword} from "@/server/rbac/guard";

export const POST: APIRoute = async ({locals, request}) => {
  if (!locals.authUser?.id) return localizedTextError(request, "errors.account.notFound", 404);
  const body = await request.json().catch(() => null) as {
    currentPassword?: unknown;
    newPassword?: unknown;
    confirmation?: unknown;
  } | null;
  if (typeof body?.currentPassword !== "string" ||
      typeof body.newPassword !== "string" ||
      body.newPassword.length < 12 || body.newPassword.length > 128 ||
      body.newPassword !== body.confirmation) {
    return localizedError(request, "errors.account.passwordMismatch", 400);
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
