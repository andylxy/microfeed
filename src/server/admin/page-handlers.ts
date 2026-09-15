import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";
import * as z from "zod";

import {
  apiPageCreateInputSchema,
  apiPageInputSchema,
  pageInputErrorMessage,
  pageInputErrorParams,
} from "@/shared/ApiSchemas";
import {
  jsonResponse,
  localizedError,
  localizedServiceError,
} from "@/server/http";
import FeedDb from "@/server/feed/FeedDb";
import {
  activeThemeSupportsPages,
  createPage,
  deletePage,
  getPageById,
  listAdminPageSummaries,
  PageConflictError,
  PageRequestError,
  PageThemeUnsupportedError,
  reorderPageNavigation,
  updatePage,
} from "@/server/pages/service";
import {
  contentMutationWebhookCommit,
  singleWebhookEventCommit,
} from "@/server/webhooks/emission";
import {
  isUnpublishedStatus,
  isWebMcpInteraction,
} from "@/shared/WebMcp";

const pageNavigationOrderSchema = z.object({
  page_ids: z.array(z.string().min(1)).max(100),
});

function serviceError(
  request: Request | undefined,
  error: unknown,
): Response | undefined {
  if (error instanceof PageRequestError) {
    return localizedServiceError(error, 400, request);
  }
  if (error instanceof PageConflictError) {
    return localizedServiceError(error, 409, request);
  }
  if (error instanceof PageThemeUnsupportedError) {
    return localizedServiceError(error, 422, request);
  }
  // No catch-all AppError branch: unclassified errors must keep propagating to
  // a 500 exactly as before. Guessing a status here would silently turn a 500
  // into a 400.
  return undefined;
}

function database(request: Request): FeedDb {
  return new FeedDb(env, request, cache);
}

export const listAdminPages: APIRoute = async ({request}) => {
  try {
    const [items, themeSupportsPages] = await Promise.all([
      listAdminPageSummaries(env.FEED_DB),
      activeThemeSupportsPages(env.FEED_DB),
    ]);
    return jsonResponse(
      {items, themeSupportsPages},
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(request, error);
    if (response) return response;
    throw error;
  }
};

export const createAdminPage: APIRoute = async ({request}) => {
  const parsed = apiPageCreateInputSchema.safeParse(await request.json().catch(
    () => null,
  ));
  if (!parsed.success) {
    return localizedError(
      request,
      pageInputErrorMessage(parsed.error),
      400,
      pageInputErrorParams(parsed.error),
    );
  }
  const webMcpInteraction = isWebMcpInteraction(request);
  if (
    webMcpInteraction && !isUnpublishedStatus(parsed.data.status)
  ) {
    return localizedError(request, "errors.page.webmcpCreateOnly", 409);
  }
  try {
    const page = await createPage(database(request), request, parsed.data, {
      adminPath: env.MICROFEED_ADMIN_PATH,
      commit: contentMutationWebhookCommit(env, request, {
        context: {
          origin: webMcpInteraction ? "webmcp" : "dashboard",
        },
        id: (result) => result.id,
        kind: "page",
        mutation: "created",
      }),
    });
    return jsonResponse(page, {status: 201});
  } catch (error) {
    const response = serviceError(request, error);
    if (response) return response;
    throw error;
  }
};

export const getAdminPage: APIRoute = async ({params, request}) => {
  const page = params.pageId
    ? await getPageById(env.FEED_DB, request, params.pageId)
    : null;
  return page
    ? jsonResponse(page)
    : localizedError(request, "errors.page.notFound", 404);
};

export const reorderAdminPageNavigation: APIRoute = async ({request}) => {
  const parsed = pageNavigationOrderSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return jsonResponse(
      {error: "Send each navigation Page once, in the order it should appear."},
      {status: 400},
    );
  }
  try {
    await reorderPageNavigation(
      database(request),
      parsed.data.page_ids,
      singleWebhookEventCommit(env, request, {
        changedFields: ["page_ids"],
        object: {id: "navigation", page_ids: parsed.data.page_ids},
        subjectId: "navigation",
        subjectType: "page",
        type: "page.navigation_updated",
      }, {origin: "dashboard"}),
    );
    return jsonResponse({});
  } catch (error) {
    const response = serviceError(request, error);
    if (response) return response;
    throw error;
  }
};

export const updateAdminPage: APIRoute = async ({params, request}) => {
  const parsed = apiPageInputSchema.safeParse(await request.json().catch(
    () => null,
  ));
  if (!parsed.success) {
    return localizedError(
      request,
      pageInputErrorMessage(parsed.error),
      400,
      pageInputErrorParams(parsed.error),
    );
  }
  if (!params.pageId) {
    return localizedError(request, "errors.page.selectedNotFound", 400);
  }
  const webMcpInteraction = isWebMcpInteraction(request);
  if (
    webMcpInteraction && !isUnpublishedStatus(parsed.data.status)
  ) {
    return localizedError(request, "errors.page.webmcpSaveOnly", 409);
  }
  try {
    const before = await getPageById(
      env.FEED_DB,
      request,
      params.pageId,
    );
    if (
      webMcpInteraction && before &&
      !isUnpublishedStatus(before.status)
    ) {
      return jsonResponse({
        error: "WebMCP cannot change a Page that is no longer unpublished.",
      }, {status: 409});
    }
    const page = await updatePage(
      database(request),
      request,
      params.pageId,
      parsed.data,
      {
        adminPath: env.MICROFEED_ADMIN_PATH,
        commit: contentMutationWebhookCommit(env, request, {
          before: before as unknown as Record<string, unknown> | null,
          context: {
            origin: webMcpInteraction ? "webmcp" : "dashboard",
          },
          id: params.pageId,
          kind: "page",
          mutation: "updated",
        }),
      },
    );
    if (!page) return localizedError(request, "errors.page.notFound", 404);
    return jsonResponse(page);
  } catch (error) {
    const response = serviceError(request, error);
    if (response) return response;
    throw error;
  }
};

export const deleteAdminPage: APIRoute = async ({params, request}) => {
  if (!params.pageId) {
    return localizedError(request, "errors.page.invalidId", 400);
  }
  try {
    const before = await getPageById(env.FEED_DB, request, params.pageId);
    if (!await deletePage(
      database(request),
      params.pageId,
      contentMutationWebhookCommit(env, request, {
        before: before as unknown as Record<string, unknown> | null,
        context: {origin: "dashboard"},
        id: params.pageId,
        kind: "page",
        mutation: "deleted",
      }),
    )) {
      return localizedError(request, "errors.page.notFound", 404);
    }
    return jsonResponse({});
  } catch (error) {
    const response = serviceError(request, error);
    if (response) return response;
    throw error;
  }
};
