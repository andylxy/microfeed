import {getAdminWebhookDelivery, withWebhookGuard} from "@/server/admin/webhook-handlers";

export const GET = withWebhookGuard(getAdminWebhookDelivery);
