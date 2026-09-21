import {
  createAdminWebhookEndpoint,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export {listAdminWebhookEndpoints as GET} from "@/server/admin/webhook-handlers";

export const POST = withWebhookGuard(createAdminWebhookEndpoint);
