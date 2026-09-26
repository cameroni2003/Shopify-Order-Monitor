import { describe, expect, it } from "vitest";
import { planOrderWrite, type StoredOrderRow } from "./order-write-plan";
import type { NormalizedEvent, OrderSnapshot } from "./shopify-delivery";

const NOW = new Date("2026-09-26T12:00:00.000Z");

function snapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: "gid://shopify/Order/1",
    name: "#1001",
    displayFinancialStatus: "PENDING",
    displayFulfillmentStatus: "UNFULFILLED",
    cancellation: null,
    cancelledAt: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    closed: false,
    closedAt: null,
    test: false,
    currentTotalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
    currentSubtotalLineItemsQuantity: 2,
    ...overrides,
  };
}

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    shopDomain: "test-shop.myshopify.com",
    webhookId: "webhook-1",
    triggeredAt: "2026-09-25T00:00:01.000Z",
    topic: "Order",
    action: "update",
    handle: "order_status_changes",
    orderId: "gid://shopify/Order/1",
    order: snapshot(),
    fieldsChanged: { added: [], updated: [], removed: [] },
    source: "inline",
    ...overrides,
  };
}

function storedRow(overrides: Partial<StoredOrderRow> = {}): StoredOrderRow {
  return {
    name: "#1001",
    financialStatus: "PENDING",
    fulfillmentStatus: "UNFULFILLED",
    isCancelled: false,
    cancelledAt: null,
    refundPending: false,
    shopifyClosed: false,
    shopifyClosedAt: null,
    isTest: false,
    totalAmount: "50.00",
    totalCurrency: "USD",
    itemsCount: 2,
    shopifyCreatedAt: new Date("2026-09-20T00:00:00.000Z"),
    shopifyUpdatedAt: new Date("2026-09-24T00:00:00.000Z"),
    lastTriggeredAt: new Date("2026-09-24T00:00:01.000Z"),
    orderStatus: "NEEDS_ATTENTION",
    staleSince: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("planOrderWrite", () => {
  it("tombstones a delete action, retaining last-known status fields", () => {
    const existing = storedRow({ orderStatus: "NEEDS_ATTENTION" });
    const plan = planOrderWrite(existing, event({ action: "delete", order: null }), NOW);
    expect(plan.action).toBe("write");
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.orderStatus).toBe("DELETED");
    expect(plan.fields.deletedAt).toEqual(NOW);
    expect(plan.fields.financialStatus).toBe("PENDING"); // retained, not wiped
  });

  it("creates a fresh row from a create action with no existing row", () => {
    const plan = planOrderWrite(null, event({ action: "create" }), NOW);
    expect(plan.action).toBe("write");
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.orderStatus).toBe("NEEDS_ATTENTION");
    expect(plan.fields.name).toBe("#1001");
  });

  it("rejects missing data.order on an order confirmed under 60 days old", () => {
    const existing = storedRow({ shopifyCreatedAt: new Date("2026-09-01T00:00:00.000Z") }); // 25 days old
    const plan = planOrderWrite(existing, event({ order: null }), NOW);
    expect(plan.action).toBe("reject_missing_data");
  });

  it("classifies missing data.order as STALE when the order is 60+ days old", () => {
    const existing = storedRow({ shopifyCreatedAt: new Date("2026-06-01T00:00:00.000Z") }); // ~117 days
    const plan = planOrderWrite(existing, event({ order: null }), NOW);
    expect(plan.action).toBe("write");
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.orderStatus).toBe("STALE");
    expect(plan.fields.financialStatus).toBe(existing.financialStatus); // retained
  });

  it("classifies missing data.order as STALE for a never-seen order (age unknowable)", () => {
    const plan = planOrderWrite(null, event({ order: null }), NOW);
    expect(plan.action).toBe("write");
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.orderStatus).toBe("STALE");
    expect(plan.fields.name).toBeNull();
  });

  it("treats a non-empty errors array the same as null data.order", () => {
    const existing = storedRow({ shopifyCreatedAt: new Date("2026-06-01T00:00:00.000Z") });
    const plan = planOrderWrite(
      existing,
      event({ order: snapshot(), errors: [{ message: "boom" }] }),
      NOW,
    );
    expect(plan.action).toBe("write");
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.orderStatus).toBe("STALE");
  });

  it("skips an out-of-order delivery older than the stored version", () => {
    const existing = storedRow({ shopifyUpdatedAt: new Date("2026-09-25T12:00:00.000Z") });
    const stale = event({ order: snapshot({ updatedAt: "2026-09-25T00:00:00.000Z" }) }); // earlier
    expect(planOrderWrite(existing, stale, NOW).action).toBe("skip_stale_delivery");
  });

  it("applies an update at or after the stored version", () => {
    const existing = storedRow({ shopifyUpdatedAt: new Date("2026-09-25T00:00:00.000Z") });
    const fresh = event({ order: snapshot({ updatedAt: "2026-09-25T00:00:00.000Z" }) }); // equal — applies
    expect(planOrderWrite(existing, fresh, NOW).action).toBe("write");
  });

  it("falls back to lastTriggeredAt for the stored version when shopifyUpdatedAt is unset (e.g. recovering from STALE)", () => {
    const existing = storedRow({
      shopifyUpdatedAt: null,
      lastTriggeredAt: new Date("2026-09-25T12:00:00.000Z"),
      orderStatus: "STALE",
    });
    const olderEvent = event({ order: snapshot({ updatedAt: "2026-09-25T00:00:00.000Z" }) });
    expect(planOrderWrite(existing, olderEvent, NOW).action).toBe("skip_stale_delivery");
  });

  it("classifies a cancelled order with money still held as CANCELLED + refundPending", () => {
    const plan = planOrderWrite(
      null,
      event({ order: snapshot({ cancelledAt: "2026-09-24T00:00:00.000Z", displayFinancialStatus: "PAID" }) }),
      NOW,
    );
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.orderStatus).toBe("CANCELLED");
    expect(plan.fields.refundPending).toBe(true);
  });

  it("classifies closed:true as COMPLETED", () => {
    const plan = planOrderWrite(null, event({ order: snapshot({ closed: true }) }), NOW);
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.orderStatus).toBe("COMPLETED");
  });

  it("recovers a STALE/DELETED row when a real snapshot arrives later", () => {
    const existing = storedRow({ orderStatus: "DELETED", deletedAt: NOW, staleSince: null });
    const plan = planOrderWrite(existing, event({ order: snapshot({ updatedAt: "2026-09-27T00:00:00.000Z" }) }), NOW);
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.deletedAt).toBeNull();
    expect(plan.fields.staleSince).toBeNull();
    expect(plan.fields.orderStatus).toBe("NEEDS_ATTENTION");
  });

  it("retains the last-known total/currency/items when a later snapshot omits them", () => {
    const existing = storedRow({ totalAmount: "50.00", totalCurrency: "USD", itemsCount: 2 });
    const plan = planOrderWrite(
      existing,
      event({
        order: snapshot({ currentTotalPriceSet: null, currentSubtotalLineItemsQuantity: null }),
      }),
      NOW,
    );
    if (plan.action !== "write") throw new Error("unreachable");
    expect(plan.fields.totalAmount).toBe("50.00");
    expect(plan.fields.itemsCount).toBe(2);
  });
});
