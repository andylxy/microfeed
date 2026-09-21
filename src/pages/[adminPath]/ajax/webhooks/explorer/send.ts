import {
  sendAdminWebhookExplorerEvent,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const POST = withWebhookGuard(sendAdminWebhookExplorerEvent);
