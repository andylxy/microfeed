import {
  createAdminWebhookEndpoint,
  listAdminWebhookEndpoints,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const GET = withWebhookGuard(listAdminWebhookEndpoints);

export const POST = withWebhookGuard(createAdminWebhookEndpoint);
