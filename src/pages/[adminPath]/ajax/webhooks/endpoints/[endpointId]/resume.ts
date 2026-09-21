import {
  resumeAdminWebhookEndpoint,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const POST = withWebhookGuard(resumeAdminWebhookEndpoint);
