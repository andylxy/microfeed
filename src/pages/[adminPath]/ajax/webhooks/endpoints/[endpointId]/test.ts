import {
  testAdminWebhookEndpoint,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const POST = withWebhookGuard(testAdminWebhookEndpoint);
