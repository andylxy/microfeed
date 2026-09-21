import {
  revealAdminWebhookEndpointSecret,
  withWebhookGuard,
} from "@/server/admin/webhook-handlers";

// A GET, but it discloses the endpoint signing secret, so it is gated like a
// write rather than left at "logged in is enough" (plan §8.1 reads).
export const GET = withWebhookGuard(revealAdminWebhookEndpointSecret);
