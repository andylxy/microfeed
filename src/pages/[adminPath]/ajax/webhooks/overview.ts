import {getWebhookOverview, withWebhookGuard} from "@/server/admin/webhook-handlers";

export const GET = withWebhookGuard(getWebhookOverview);
