import {
  redeliverAdminWebhookDelivery,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const POST = withWebhookGuard(redeliverAdminWebhookDelivery);
