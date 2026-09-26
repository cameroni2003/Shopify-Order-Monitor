import { applyOrderEvent } from "../app/lib/db/orders.server";
import { createQueueProvider } from "./queue/create-queue-provider";
import type { NormalizedEvent } from "../shared/shopify-delivery";

/**
 * Detects the specific GraphQL error Shopify returns when the app hasn't been granted Protected
 * Customer Data access — the Order query then comes back null/errored for *every* order
 * regardless of age, which planOrderWrite has no way to distinguish from genuine 60-day
 * staleness (see shared/order-write-plan.ts). Surfacing it distinctly here means a misconfigured
 * app shows up as a loud, actionable warning instead of a queue full of misleadingly-labeled
 * "stale" orders. Confirmed against a real captured delivery — see worker/live-payload.test.ts.
 */
function hasProtectedDataAccessDeniedError(event: NormalizedEvent): boolean {
  return (event.errors ?? []).some((e) => {
    const extensions = (e as { extensions?: { code?: string } } | undefined)?.extensions;
    return extensions?.code === "ACCESS_DENIED";
  });
}

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
      if (result.orderStatus === "STALE" && hasProtectedDataAccessDeniedError(event)) {
        console.warn(
          `[worker] order ${event.orderId} (shop=${event.shopDomain}) marked STALE due to a ` +
            `Protected Customer Data ACCESS_DENIED error, not the 60-day window. Grant this app ` +
            `Protected Customer Data access in the Partner Dashboard (API access -> Protected ` +
            `customer data) — for a development store this applies immediately, no review ` +
            `needed. See https://shopify.dev/docs/apps/launch/protected-customer-data`,
        );
      }
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
