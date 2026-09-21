import {
  rotateAdminWebhookEndpointSecret,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const POST = withWebhookGuard(rotateAdminWebhookEndpointSecret);
