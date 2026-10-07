import {handle} from "@astrojs/cloudflare/handler";

import {processWebhookMessage, type WebhookQueueMessage} from "@/server/webhooks/delivery";
import {runScheduledMaintenance} from "@/server/maintenance";

export default {
  fetch(request, runtimeEnv, context) {
    return handle(request, runtimeEnv, context);
  },
  async queue(batch, runtimeEnv) {
    for (const message of batch.messages) {
      try {
        await processWebhookMessage(runtimeEnv, message);
      } catch (error) {
        console.error(JSON.stringify({
          deliveryId: message.body?.deliveryId,
          error: error instanceof Error ? error.message : String(error),
          message: "Unhandled webhook consumer error",
        }));
        message.retry();
      }
    }
  },
  async scheduled(controller, runtimeEnv) {
    await runScheduledMaintenance(runtimeEnv, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env, WebhookQueueMessage>;
