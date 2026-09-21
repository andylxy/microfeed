import {
  previewAdminWebhookExplorerEvent,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

export const POST = withWebhookGuard(previewAdminWebhookExplorerEvent);
