import {listAdminWebhookExplorerSubjects, withWebhookGuard} from "@/server/admin/webhook-handlers";

export const GET = withWebhookGuard(listAdminWebhookExplorerSubjects);
