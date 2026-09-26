import { describe, expect, it } from "vitest";
import { extractShopifyDelivery } from "./eventbridge-envelope";

describe("extractShopifyDelivery", () => {
  it("extracts headers and body from the assumed detail.metadata/detail.payload shape", () => {
    const raw = JSON.stringify({
      version: "0",
      id: "abc",
      "detail-type": "shopifyWebhook",
      source: "aws.partner/shopify.com/427319918593/shopify-order-monitor",
      detail: {
        metadata: {
          "X-Shopify-Shop-Domain": "test-shop.myshopify.com",
          "X-Shopify-Webhook-Id": "webhook-1",
        },
        payload: { topic: "Order", action: "update", handle: "order_status_changes" },
      },
    });
    const { headers, body } = extractShopifyDelivery(raw);
    expect(headers).toEqual({
      "shopify-shop-domain": "test-shop.myshopify.com",
      "shopify-webhook-id": "webhook-1",
    });
    expect(body).toEqual({ topic: "Order", action: "update", handle: "order_status_changes" });
  });

  it("falls back to treating detail as the body when there's no metadata/payload split", () => {
    const raw = JSON.stringify({
      detail: {
        topic: "Order",
        action: "update",
        "shopify-shop-domain": "test-shop.myshopify.com",
      },
    });
    const { headers, body } = extractShopifyDelivery(raw);
    expect(headers).toEqual({ "shopify-shop-domain": "test-shop.myshopify.com" });
    expect(body).toEqual({
      topic: "Order",
      action: "update",
      "shopify-shop-domain": "test-shop.myshopify.com",
    });
  });

  it("treats an already-unwrapped body as-is", () => {
    const raw = JSON.stringify({ topic: "Order", action: "update" });
    const { headers, body } = extractShopifyDelivery(raw);
    expect(headers).toEqual({});
    expect(body).toEqual({ topic: "Order", action: "update" });
  });

  it("throws a diagnostic error for invalid JSON", () => {
    expect(() => extractShopifyDelivery("not json")).toThrow(/not valid JSON/);
  });

  it("throws a diagnostic error for an unrecognized shape", () => {
    expect(() => extractShopifyDelivery(JSON.stringify({ nonsense: true }))).toThrow(
      /Unrecognized SQS message envelope/,
    );
  });
});
