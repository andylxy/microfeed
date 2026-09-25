import {listAdminWebhookDeliveries, withWebhookGuard} from "@/server/admin/webhook-handlers";

export const GET = withWebhookGuard(listAdminWebhookDeliveries);
