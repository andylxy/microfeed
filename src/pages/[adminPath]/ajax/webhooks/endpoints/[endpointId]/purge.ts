import {
  purgeAdminWebhookEndpoint,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const POST = withWebhookGuard(purgeAdminWebhookEndpoint);
