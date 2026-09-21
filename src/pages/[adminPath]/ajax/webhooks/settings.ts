import {
  updateAdminWebhookSettings,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const PATCH = withWebhookGuard(updateAdminWebhookSettings);
