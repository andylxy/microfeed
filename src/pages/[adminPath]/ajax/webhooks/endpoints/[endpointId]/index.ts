import {
  deleteAdminWebhookEndpoint,
  updateAdminWebhookEndpoint,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export {getAdminWebhookEndpoint as GET} from "@/server/admin/webhook-handlers";

export const PUT = withWebhookGuard(updateAdminWebhookEndpoint);
export const DELETE = withWebhookGuard(deleteAdminWebhookEndpoint);
