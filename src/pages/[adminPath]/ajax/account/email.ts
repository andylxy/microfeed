import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {jsonResponse, localizedError, localizedTextError} from "@/server/http";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const POST: APIRoute = async ({locals, request}) => {
  const userId = locals.authUser?.id;
  if (!userId) return localizedTextError(request, "errors.account.notFound", 404);
  const body = await request.json().catch(() => null) as {
    currentPassword?: unknown;
    email?: unknown;
  } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || typeof body?.currentPassword !== "string") {
    return localizedError(request, "errors.account.emailRequired", 400);
  }
  try {
    await createMicrofeedAuth(env, request).api.verifyPassword({
      body: {password: body.currentPassword},
      headers: request.headers,
    });
    await env.FEED_DB.batch([
      env.FEED_DB.prepare(
        `UPDATE "auth_user" SET "email" = ?1, "name" = ?1, "updatedAt" = ?2
         WHERE "id" = ?3`,
      ).bind(email, new Date().toISOString(), userId),
      env.FEED_DB.prepare(
        `DELETE FROM "auth_session" WHERE "userId" = ?1`,
      ).bind(userId),
    ]);
    return jsonResponse({email});
  } catch {
    return localizedError(request, "errors.account.emailUnavailable", 400);
  }
};
