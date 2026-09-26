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

/**
 * A second capture from the same dev store (2026-09-26, ~9 minutes later), after Protected
 * Customer Data access was granted in the Partner Dashboard — confirming data.order now comes
 * back populated instead of ACCESS_DENIED. Same order as above (id 18906468024599), now visible
 * with real field values: PAID + ON_HOLD, a $749.95 test order.
 */
const LIVE_MESSAGE_BODY_ACCESS_GRANTED = JSON.stringify({
  version: "0",
  id: "2dadca56-4c1e-2ed1-a69d-427bc49a090d",
  "detail-type": "shopifyWebhook",
  source: "aws.partner/shopify.com/427319918593/shopify-order-monitor",
  account: "000000000000",
  time: "2026-09-26T18:01:25Z",
  region: "us-east-2",
  resources: [],
  detail: {
    payload: {
      topic: "Order",
      action: "update",
      handle: "order_status_changes",
      data: {
        order: {
          id: "gid://shopify/Order/18906468024599",
          name: "#1001",
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: "ON_HOLD",
          cancellation: null,
          cancelledAt: null,
          createdAt: "2026-09-26T17:49:20Z",
          updatedAt: "2026-09-26T18:01:25Z",
          closed: false,
          closedAt: null,
          test: true,
          currentTotalPriceSet: { shopMoney: { amount: "749.95", currencyCode: "USD" } },
          currentSubtotalLineItemsQuantity: 1,
        },
      },
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
      "shopify-triggered-at": "2026-09-26T18:01:25.238833Z",
      "shopify-action": "update",
      "shopify-webhook-id": "1dfa49e3-b93c-3fde-897b-78412fc4aa05",
      "shopify-handle": "order_status_changes",
      "shopify-shop-id": "gid://shopify/Shop/000000000000",
      "shopify-api-key": "0000000000000000000000000000000",
    },
  },
});

describe("live EventBridge payload (captured 2026-09-26, access denied)", () => {
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

describe("live EventBridge payload (captured 2026-09-26, access granted)", () => {
  it("normalizes end-to-end with a real, populated order snapshot", async () => {
    const { headers, body } = extractShopifyDelivery(LIVE_MESSAGE_BODY_ACCESS_GRANTED);
    const event = await normalizeShopifyDelivery(body, headers);
    expect(event.errors).toBeUndefined();
    expect(event.order).toMatchObject({
      name: "#1001",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "ON_HOLD",
      test: true,
      currentTotalPriceSet: { shopMoney: { amount: "749.95", currencyCode: "USD" } },
    });
  });

  it("classifies PAID + ON_HOLD as NEEDS_ATTENTION, not COMPLETED", async () => {
    const { headers, body } = extractShopifyDelivery(LIVE_MESSAGE_BODY_ACCESS_GRANTED);
    const event = await normalizeShopifyDelivery(body, headers);
    const plan = planOrderWrite(null, event, new Date("2026-09-26T18:05:00.000Z"));
    expect(plan.action).toBe("write");
    if (plan.action !== "write") throw new Error("unreachable");
    // ON_HOLD isn't a "fulfillment done" status, so PAID alone doesn't complete the order —
    // there's still fulfillment work blocked, which is exactly what "needs attention" means here.
    expect(plan.fields.orderStatus).toBe("NEEDS_ATTENTION");
    expect(plan.fields.totalAmount).toBe("749.95");
    expect(plan.fields.isTest).toBe(true);
  });
});
