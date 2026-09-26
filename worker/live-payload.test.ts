import { describe, expect, it } from "vitest";
import { planOrderWrite } from "../shared/order-write-plan";
import { normalizeShopifyDelivery } from "../shared/shopify-delivery";
import { extractShopifyDelivery } from "./eventbridge-envelope";

/**
 * A real EventBridge->SQS message captured from a live dev store via worker/scripts/peek-queue.ts
 * (2026-09-26), confirming worker/eventbridge-envelope.ts's assumed envelope shape
 * (detail.metadata + detail.payload, headers already lowercase with no "X-" prefix). Shop domain
 * and IDs replaced with placeholders; structure and key casing preserved exactly.
 *
 * This capture also happens to be the first real evidence of the "Order object access denied"
 * failure mode documented in worker/index.ts — see the errors array below and docs/PLAN.md.
 */
const LIVE_MESSAGE_BODY = JSON.stringify({
  version: "0",
  id: "ba7d22a3-1b4a-388c-8266-41de410074b7",
  "detail-type": "shopifyWebhook",
  source: "aws.partner/shopify.com/427319918593/shopify-order-monitor",
  account: "000000000000",
  time: "2026-09-26T17:52:56Z",
  region: "us-east-2",
  resources: [],
  detail: {
    payload: {
      topic: "Order",
      action: "update",
      handle: "order_status_changes",
      data: { order: null },
      errors: [
        {
          message:
            "This app is not approved to access the Order object. See https://shopify.dev/docs/apps/launch/protected-customer-data for more details.",
          locations: [{ line: 2, column: 5 }],
          extensions: {
            code: "ACCESS_DENIED",
            documentation: "https://shopify.dev/docs/apps/launch/protected-customer-data",
          },
          path: ["order"],
        },
      ],
      fields_changed: {
        added: [],
        updated: ["order[id: 'gid://shopify/Order/18906468024599'].displayFulfillmentStatus"],
        removed: [],
      },
      query_variables: { orderId: "gid://shopify/Order/18906468024599" },
    },
    metadata: {
      "content-type": "application/json",
      "shopify-topic": "Order",
      "shopify-api-version": "unstable",
      "shopify-shop-domain": "test-shop.myshopify.com",
      "shopify-triggered-at": "2026-09-26T17:52:55.805612Z",
      "shopify-action": "update",
      "shopify-webhook-id": "c00b3a6e-ce90-34a5-a80d-2eddf238d458",
      "shopify-handle": "order_status_changes",
      "shopify-shop-id": "gid://shopify/Shop/000000000000",
      "shopify-api-key": "0000000000000000000000000000000",
    },
  },
});

describe("live EventBridge payload (captured 2026-09-26)", () => {
  it("extracts headers and body via the assumed detail.metadata/detail.payload shape", () => {
    const { headers, body } = extractShopifyDelivery(LIVE_MESSAGE_BODY);
    expect(headers["shopify-shop-domain"]).toBe("test-shop.myshopify.com");
    expect(headers["shopify-webhook-id"]).toBe("c00b3a6e-ce90-34a5-a80d-2eddf238d458");
    expect(headers["shopify-triggered-at"]).toBe("2026-09-26T17:52:55.805612Z");
    expect(body).toMatchObject({ topic: "Order", action: "update" });
  });

  it("normalizes end-to-end into a NormalizedEvent with the ACCESS_DENIED error preserved", async () => {
    const { headers, body } = extractShopifyDelivery(LIVE_MESSAGE_BODY);
    const event = await normalizeShopifyDelivery(body, headers);
    expect(event.shopDomain).toBe("test-shop.myshopify.com");
    expect(event.orderId).toBe("gid://shopify/Order/18906468024599");
    expect(event.order).toBeNull();
    expect(event.errors?.[0]).toMatchObject({
      extensions: { code: "ACCESS_DENIED" },
    });
  });

  it("classifies a never-seen order as STALE rather than crashing when data.order is denied", async () => {
    const { headers, body } = extractShopifyDelivery(LIVE_MESSAGE_BODY);
    const event = await normalizeShopifyDelivery(body, headers);
    const plan = planOrderWrite(null, event, new Date("2026-09-26T18:00:00.000Z"));
    expect(plan.action).toBe("write");
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.orderStatus).toBe("STALE");
  });
});
