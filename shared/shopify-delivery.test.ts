import { describe, expect, it, vi } from "vitest";
import { normalizeShopifyDelivery } from "./shopify-delivery";

const HEADERS = {
  "shopify-shop-domain": "test-shop.myshopify.com",
  "shopify-webhook-id": "webhook-1",
  "shopify-triggered-at": "2026-09-25T00:00:01.000Z",
  "shopify-topic": "Order",
  "shopify-action": "update",
  "shopify-handle": "order_status_changes",
};

const INLINE_BODY = {
  topic: "Order",
  action: "update",
  handle: "order_status_changes",
  data: {
    order: {
      id: "gid://shopify/Order/1",
      name: "#1001",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      cancellation: null,
      cancelledAt: null,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
      closed: false,
      closedAt: null,
      test: false,
      currentTotalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
      currentSubtotalLineItemsQuantity: 2,
    },
  },
  fields_changed: {
    added: [],
    updated: ["order[id: 'gid://shopify/Order/1'].displayFulfillmentStatus"],
    removed: [],
  },
  query_variables: { orderId: "gid://shopify/Order/1" },
};

describe("normalizeShopifyDelivery", () => {
  it("normalizes an inline delivery", async () => {
    const result = await normalizeShopifyDelivery(INLINE_BODY, HEADERS);
    expect(result).toMatchObject({
      shopDomain: "test-shop.myshopify.com",
      webhookId: "webhook-1",
      triggeredAt: "2026-09-25T00:00:01.000Z",
      action: "update",
      orderId: "gid://shopify/Order/1",
      source: "inline",
    });
    expect(result.order?.displayFinancialStatus).toBe("PAID");
  });

  it("is case-insensitive on header names", async () => {
    const upperHeaders = Object.fromEntries(
      Object.entries(HEADERS).map(([k, v]) => [k.toUpperCase(), v]),
    );
    const result = await normalizeShopifyDelivery(INLINE_BODY, upperHeaders);
    expect(result.shopDomain).toBe("test-shop.myshopify.com");
  });

  it("throws with a clear message when required headers are missing", async () => {
    await expect(normalizeShopifyDelivery(INLINE_BODY, {})).rejects.toThrow(/shopify-shop-domain/);
  });

  it("throws on an unrecognized body shape", async () => {
    await expect(normalizeShopifyDelivery({ nonsense: true }, HEADERS)).rejects.toThrow(
      /Unrecognized Shopify Events delivery/,
    );
  });

  it("sets order to null and reflects a delete action", async () => {
    const deleteBody = {
      topic: "Order",
      action: "delete",
      handle: "order_status_changes",
      data: { order: null },
      fields_changed: { added: [], updated: [], removed: ["order[id: 'gid://shopify/Order/1']"] },
      query_variables: { orderId: "gid://shopify/Order/1" },
    };
    const result = await normalizeShopifyDelivery(deleteBody, {
      ...HEADERS,
      "shopify-action": "delete",
    });
    expect(result.action).toBe("delete");
    expect(result.order).toBeNull();
  });

  it("fetches and merges an overflow payload before the pointer expires", async () => {
    const pointer = {
      topic: "Order",
      action: "update",
      handle: "order_status_changes",
      payload_url: "https://example.com/overflow/webhook-1",
      payload_size_bytes: 300_000,
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        data: INLINE_BODY.data,
        fields_changed: INLINE_BODY.fields_changed,
        query_variables: INLINE_BODY.query_variables,
      }),
    })) as unknown as typeof fetch;

    const result = await normalizeShopifyDelivery(pointer, HEADERS, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(pointer.payload_url);
    expect(result.source).toBe("overflow");
    expect(result.order?.displayFinancialStatus).toBe("PAID");
  });

  it("refuses to use an already-expired overflow pointer", async () => {
    const pointer = {
      topic: "Order",
      action: "update",
      handle: "order_status_changes",
      payload_url: "https://example.com/overflow/webhook-1",
      expires_at: "2020-01-01T00:00:00.000Z",
    };
    const fetchImpl = vi.fn();
    await expect(
      normalizeShopifyDelivery(pointer, HEADERS, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/already expired/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a failed overflow fetch as an error", async () => {
    const pointer = {
      topic: "Order",
      action: "update",
      handle: "order_status_changes",
      payload_url: "https://example.com/overflow/webhook-1",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    await expect(normalizeShopifyDelivery(pointer, HEADERS, { fetchImpl })).rejects.toThrow(/404/);
  });
});
