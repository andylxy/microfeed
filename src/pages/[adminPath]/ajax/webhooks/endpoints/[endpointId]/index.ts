import {
  deleteAdminWebhookEndpoint,
  getAdminWebhookEndpoint,
  updateAdminWebhookEndpoint,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const GET = withWebhookGuard(getAdminWebhookEndpoint);

export const PUT = withWebhookGuard(updateAdminWebhookEndpoint);
export const DELETE = withWebhookGuard(deleteAdminWebhookEndpoint);
