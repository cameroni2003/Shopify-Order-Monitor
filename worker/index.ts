import { applyOrderEvent } from "../app/lib/db/orders.server";
import { createQueueProvider } from "./queue/create-queue-provider";
import type { NormalizedEvent } from "../shared/shopify-delivery";

async function handleEvent(event: NormalizedEvent): Promise<void> {
  const result = await applyOrderEvent(event);
  switch (result.outcome) {
    case "duplicate":
      console.log(
        `[worker] skipped duplicate delivery shop=${event.shopDomain} webhookId=${event.webhookId}`,
      );
      return;
    case "skipped_stale_delivery":
      console.log(
        `[worker] skipped out-of-order delivery shop=${event.shopDomain} order=${event.orderId}`,
      );
      return;
    case "written":
      console.log(
        `[worker] wrote shop=${event.shopDomain} order=${event.orderId} action=${event.action} status=${result.orderStatus}`,
      );
      return;
  }
}

const provider = createQueueProvider(handleEvent);

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, stopping...`);
  await provider.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`[worker] starting with QUEUE_PROVIDER=${process.env.QUEUE_PROVIDER ?? "(unset)"}`);
await provider.start();
console.log("[worker] running");
