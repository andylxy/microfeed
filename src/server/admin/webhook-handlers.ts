import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {requireRbac} from "@/server/rbac/guard";
import {
  jsonResponse,
  localizedError,
  localizedServiceError,
} from "@/server/http";
import {
  createWebhookTestDelivery,
  redeliverWebhookDelivery,
} from "@/server/webhooks/events";
import {
  listWebhookExplorerSubjects,
  parseWebhookExplorerSelection,
  previewWebhookExplorerEvent,
  printWebhookExplorerEvent,
  sendWebhookExplorerEvent,
} from "@/server/webhooks/explorer";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookDelivery,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  revealWebhookEndpointSecret,
  resumeWebhookEndpoint,
  rotateWebhookEndpointSecret,
  updateWebhookEndpoint,
  updateWebhookSettings,
  webhookOverview,
} from "@/server/webhooks/store";
import {
  WebhookEndpointLimitError,
  WebhookRequestError,
  WebhookUnavailableError,
} from "@/server/webhooks/validation";

function errorResponse(
  request: Request | undefined,
  error: unknown,
): Response | undefined {
  if (error instanceof WebhookUnavailableError) {
    return localizedServiceError(error, 503, request);
  }
  if (error instanceof WebhookEndpointLimitError) {
    return localizedServiceError(error, 409, request);
  }
  if (error instanceof WebhookRequestError) {
    return localizedServiceError(error, 400, request);
  }
  // No catch-all AppError branch: unclassified errors must keep propagating to
  // a 500 exactly as before. Guessing a status here would silently turn a 500
  // into a 400.
  return undefined;
}

/**
 * Compose the system-domain RBAC gate around an admin webhook handler
 * (plan §8.1: `webhooks/*` -> `system:webhook:manage`). Route files wrap their
 * write handlers with this so the gate is stated once instead of per handler.
 */
export function withWebhookGuard(handler: APIRoute): APIRoute {
  return async (context) => {
    const denied = await requireRbac(
      context.locals,
      "system:webhook:manage",
      context.request,
      env.FEED_DB,
    );
    if (denied) return denied;
    return handler(context);
  };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WebhookRequestError("errors.webhook.jsonObjectRequired");
  }
  return input as Record<string, unknown>;
}

function explorerBody(
  input: Record<string, unknown>,
  allowEndpoint = false,
): Record<string, unknown> {
  const allowed = new Set([
    "event_type",
    "source_mode",
    "subject_id",
    ...(allowEndpoint ? ["endpoint_id"] : []),
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new WebhookRequestError(
      "errors.webhook.explorerFieldsOnly",
    );
  }
  return input;
}

async function respond(
  request: Request | undefined,
  action: () => Promise<unknown>,
  init?: ResponseInit,
): Promise<Response> {
  try {
    return jsonResponse(await action(), init);
  } catch (error) {
    const response = errorResponse(request, error);
    if (response) return response;
    throw error;
  }
}

export const getWebhookOverview: APIRoute = async ({request}) =>
  respond(request, () => webhookOverview(env));

export const updateAdminWebhookSettings: APIRoute = async ({request}) =>
  respond(request, async () => {
    const input = await body(request);
    const allowed = new Set(["dailyDeliveryLimit", "highCostAcknowledged"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw new WebhookRequestError(
        "errors.webhook.settingsFieldsOnly",
      );
    }
    return {
      settings: await updateWebhookSettings(env.FEED_DB, {
        dailyDeliveryLimit: input.dailyDeliveryLimit,
        highCostAcknowledged: input.highCostAcknowledged,
      }),
    };
  });

export const listAdminWebhookExplorerSubjects: APIRoute = async ({request}) => {
  const search = new URL(request.url).searchParams;
  return respond(request, () =>
    listWebhookExplorerSubjects(
      env,
      request,
      search.get("event_type"),
      search.get("q"),
    )
  );
};

export const previewAdminWebhookExplorerEvent: APIRoute = async ({request}) =>
  respond(request, async () => {
    const input = explorerBody(await body(request));
    return previewWebhookExplorerEvent(
      env,
      request,
      parseWebhookExplorerSelection(input),
    );
  });

export const printAdminWebhookExplorerEvent: APIRoute = async ({request}) =>
  respond(request, async () => {
    const input = explorerBody(await body(request));
    return printWebhookExplorerEvent(
      env,
      request,
      parseWebhookExplorerSelection(input),
    );
  });

export const sendAdminWebhookExplorerEvent: APIRoute = async ({request}) =>
  respond(request, async () => {
    const input = explorerBody(await body(request), true);
    const endpointId = typeof input.endpoint_id === "string"
      ? input.endpoint_id
      : "";
    const selection = parseWebhookExplorerSelection(input);
    const endpoint = endpointId
      ? await getWebhookEndpoint(env.FEED_DB, endpointId)
      : null;
    const subscriptionMismatch = Boolean(
      endpoint && selection.eventType !== "webhook.test" &&
        !endpoint.events.includes(selection.eventType),
    );
    return {
      ...await sendWebhookExplorerEvent(
        env,
        request,
        selection,
        endpointId,
      ),
      subscriptionMismatch,
    };
  });

export const listAdminWebhookEndpoints: APIRoute = async ({request}) =>
  respond(request, () => listWebhookEndpoints(env.FEED_DB));

export const createAdminWebhookEndpoint: APIRoute = async ({request}) =>
  respond(request, async () => {
    const input = await body(request);
    const result = await createWebhookEndpoint(env, {
      events: input.events,
      name: input.name,
      url: input.url,
    }, new URL(request.url).origin);
    return result;
  });

export const getAdminWebhookEndpoint: APIRoute = async ({params, request}) => {
  const endpoint = params.endpointId
    ? await getWebhookEndpoint(env.FEED_DB, params.endpointId)
    : null;
  return endpoint
    ? jsonResponse(endpoint)
    : localizedError(request, "errors.webhook.endpointNotFound", 404);
};

export const updateAdminWebhookEndpoint: APIRoute = async ({params, request}) =>
  respond(request, async () => {
    if (!params.endpointId) {
      throw new WebhookRequestError("errors.webhook.chooseEndpoint");
    }
    const input = await body(request);
    const endpoint = await updateWebhookEndpoint(
      env,
      params.endpointId,
      input,
      new URL(request.url).origin,
    );
    if (!endpoint) throw new WebhookRequestError("errors.webhook.endpointNotFound");
    return endpoint;
  });

export const deleteAdminWebhookEndpoint: APIRoute = async ({params, request}) => {
  if (!params.endpointId ||
    !await deleteWebhookEndpoint(env.FEED_DB, params.endpointId)) {
    return localizedError(request, "errors.webhook.endpointNotFound", 404);
  }
  return jsonResponse({});
};

export const revealAdminWebhookEndpointSecret: APIRoute = async ({params, request}) =>
  respond(request, async () => {
    if (!params.endpointId) {
      throw new WebhookRequestError("errors.webhook.chooseEndpoint");
    }
    const secret = await revealWebhookEndpointSecret(env, params.endpointId);
    if (!secret) throw new WebhookRequestError("errors.webhook.endpointNotFound");
    return {secret};
  }, {headers: {"cache-control": "private, no-store"}});

export const rotateAdminWebhookEndpointSecret: APIRoute = async ({params, request}) =>
  respond(request, async () => {
    if (!params.endpointId) {
      throw new WebhookRequestError("errors.webhook.chooseEndpoint");
    }
    const result = await rotateWebhookEndpointSecret(env, params.endpointId);
    if (!result) throw new WebhookRequestError("errors.webhook.endpointNotFound");
    return result;
  });

export const testAdminWebhookEndpoint: APIRoute = async ({params, request}) =>
  respond(request, async () => {
    if (!params.endpointId) {
      throw new WebhookRequestError("errors.webhook.chooseEndpoint");
    }
    return createWebhookTestDelivery(env, request, params.endpointId);
  });

export const resumeAdminWebhookEndpoint: APIRoute = async ({params, request}) =>
  respond(request, async () => {
    if (!params.endpointId) {
      throw new WebhookRequestError("errors.webhook.chooseEndpoint");
    }
    const endpoint = await resumeWebhookEndpoint(env.FEED_DB, params.endpointId);
    if (!endpoint) throw new WebhookRequestError("errors.webhook.endpointNotFound");
    return endpoint;
  });

export const listAdminWebhookDeliveries: APIRoute = async ({request}) => {
  const search = new URL(request.url).searchParams;
  return respond(request, () => listWebhookDeliveries(env.FEED_DB, {
    endpointId: search.get("endpoint_id") ?? undefined,
    eventType: search.get("event_type") ?? undefined,
    status: search.get("status") ?? undefined,
  }));
};

export const getAdminWebhookDelivery: APIRoute = async ({params, request}) => {
  const delivery = params.deliveryId
    ? await getWebhookDelivery(env.FEED_DB, params.deliveryId)
    : null;
  return delivery
    ? jsonResponse(delivery)
    : localizedError(request, "errors.webhook.deliveryNotFound", 404);
};

export const redeliverAdminWebhookDelivery: APIRoute = async (
  {params, request},
) => respond(request, async () => {
  if (!params.deliveryId) {
    throw new WebhookRequestError("errors.webhook.chooseDelivery");
  }
  return redeliverWebhookDelivery(env, request, params.deliveryId);
});
