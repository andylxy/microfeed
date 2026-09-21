import {
  printAdminWebhookExplorerEvent,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const POST = withWebhookGuard(printAdminWebhookExplorerEvent);
