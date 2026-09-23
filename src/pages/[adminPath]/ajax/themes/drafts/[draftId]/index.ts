import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {appErrorResponse, jsonResponse, localizedError, localizedTextError} from "@/server/http";
import {AppError} from "@/shared/errors";
import {mediaBucket} from "@/server/media/storage";
import ThemeStore from "@/server/themes/ThemeStore";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_SETTINGS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const draft = await new ThemeStore(env.FEED_DB).getDraft(params.draftId ?? "");
  return draft
    ? jsonResponse({draft})
    : localizedTextError(request, "errors.theme.draftNotFound", 404);
};

export const PUT: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_SETTINGS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input) return localizedError(request, "errors.theme.draftRequired", 400);
  try {
    const draft = await new ThemeStore(env.FEED_DB).saveDraft(
      params.draftId ?? "",
      {bundle: input.bundle as never, manifest: input.manifest as never},
    );
    return jsonResponse({draft});
  } catch (error) {
    if (error instanceof AppError) return appErrorResponse(request, error);
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
    }, {status: 400});
  }
};

export const POST: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_SETTINGS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (input?.action !== "publish") {
    return localizedError(request, "errors.theme.unknownDraftAction", 400);
  }
  try {
    const theme = await new ThemeStore(env.FEED_DB).publishDraft(
      params.draftId ?? "",
    );
    return jsonResponse({theme}, {status: 201});
  } catch (error) {
    if (error instanceof AppError) return appErrorResponse(request, error);
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
    }, {status: 400});
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_SETTINGS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  await new ThemeStore(env.FEED_DB).discardDraft(
    params.draftId ?? "",
    mediaBucket(env),
  );
  return jsonResponse({});
};
