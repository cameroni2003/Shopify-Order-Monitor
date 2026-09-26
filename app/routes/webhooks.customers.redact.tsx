import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance webhook (docs/PLAN.md). This app's schema stores no customer PII at all
 * — no name, email, phone, or address anywhere (see prisma/schema.prisma: Order has no customer
 * fields) — so there is nothing to redact. Just acknowledge.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(
    `Received ${topic} webhook for ${shop} (customer ${
      (payload as { customer?: { id?: number } }).customer?.id ?? "unknown"
    }) — this app stores no customer data, nothing to redact.`,
  );
  return new Response();
};
