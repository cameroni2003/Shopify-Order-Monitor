import { describe, expect, it } from "vitest";
import { evaluateOrderStatus, type OrderStatusInput } from "./order-status";

const base: OrderStatusInput = {
  action: "update",
  financialStatus: null,
  fulfillmentStatus: null,
  isCancelled: false,
  closed: false,
  isStale: false,
};

describe("evaluateOrderStatus", () => {
  // Row 0
  it("classifies delete actions as DELETED regardless of any other field", () => {
    expect(
      evaluateOrderStatus({
        ...base,
        action: "delete",
        isStale: true,
        isCancelled: true,
        closed: true,
        financialStatus: "PAID",
        fulfillmentStatus: "FULFILLED",
      }),
    ).toEqual({ status: "DELETED", refundPending: false });
  });

  // Row 1
  it("classifies a stale update (60+ days, null/errored data.order) as STALE", () => {
    expect(evaluateOrderStatus({ ...base, isStale: true })).toEqual({
      status: "STALE",
      refundPending: false,
    });
  });

  it("stale takes priority over cancelled/closed/financial status", () => {
    expect(
      evaluateOrderStatus({
        ...base,
        isStale: true,
        isCancelled: true,
        closed: true,
        financialStatus: "REFUNDED",
      }),
    ).toEqual({ status: "STALE", refundPending: false });
  });

  // Row 2
  it.each(["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "AUTHORIZED"])(
    "classifies a cancelled order with financial status %s as CANCELLED with refundPending",
    (financialStatus) => {
      expect(
        evaluateOrderStatus({ ...base, isCancelled: true, financialStatus }),
      ).toEqual({ status: "CANCELLED", refundPending: true });
    },
  );

  it.each(["REFUNDED", "VOIDED", "EXPIRED", "PENDING"])(
    "classifies a cancelled order with financial status %s as CANCELLED without refundPending",
    (financialStatus) => {
      expect(
        evaluateOrderStatus({ ...base, isCancelled: true, financialStatus }),
      ).toEqual({ status: "CANCELLED", refundPending: false });
    },
  );

  it("treats a cancelled order with unknown/null financial status as no refund pending", () => {
    expect(
      evaluateOrderStatus({ ...base, isCancelled: true, financialStatus: null }),
    ).toEqual({ status: "CANCELLED", refundPending: false });
  });

  it("cancelled takes priority over closed and financial-status-based completion", () => {
    expect(
      evaluateOrderStatus({
        ...base,
        isCancelled: true,
        closed: true,
        financialStatus: "PAID",
        fulfillmentStatus: "FULFILLED",
      }),
    ).toEqual({ status: "CANCELLED", refundPending: true });
  });

  // Row 3
  it("classifies closed=true as COMPLETED even with an unfinished-looking status", () => {
    expect(
      evaluateOrderStatus({
        ...base,
        closed: true,
        financialStatus: "PENDING",
        fulfillmentStatus: "UNFULFILLED",
      }),
    ).toEqual({ status: "COMPLETED", refundPending: false });
  });

  // Row 4
  it("classifies REFUNDED as COMPLETED regardless of fulfillment status", () => {
    expect(
      evaluateOrderStatus({
        ...base,
        financialStatus: "REFUNDED",
        fulfillmentStatus: "UNFULFILLED",
      }),
    ).toEqual({ status: "COMPLETED", refundPending: false });
  });

  // Row 5
  it.each(["FULFILLED", "FULFILLMENT_NOT_REQUIRED"])(
    "classifies %s + PAID as COMPLETED",
    (fulfillmentStatus) => {
      expect(
        evaluateOrderStatus({ ...base, fulfillmentStatus, financialStatus: "PAID" }),
      ).toEqual({ status: "COMPLETED", refundPending: false });
    },
  );

  it("classifies FULFILLED + PARTIALLY_REFUNDED as COMPLETED", () => {
    expect(
      evaluateOrderStatus({
        ...base,
        fulfillmentStatus: "FULFILLED",
        financialStatus: "PARTIALLY_REFUNDED",
      }),
    ).toEqual({ status: "COMPLETED", refundPending: false });
  });

  it("does not complete FULFILLED + PARTIALLY_PAID (money still owed)", () => {
    expect(
      evaluateOrderStatus({
        ...base,
        fulfillmentStatus: "FULFILLED",
        financialStatus: "PARTIALLY_PAID",
      }),
    ).toEqual({ status: "NEEDS_ATTENTION", refundPending: false });
  });

  // Row 6 — everything still open
  it.each([
    "PENDING",
    "AUTHORIZED",
    "PARTIALLY_PAID",
    "VOIDED",
    "EXPIRED",
  ])("classifies uncancelled, unfulfilled financial status %s as NEEDS_ATTENTION", (financialStatus) => {
    expect(
      evaluateOrderStatus({ ...base, financialStatus, fulfillmentStatus: "UNFULFILLED" }),
    ).toEqual({ status: "NEEDS_ATTENTION", refundPending: false });
  });

  it.each([
    "UNFULFILLED",
    "PARTIALLY_FULFILLED",
    "IN_PROGRESS",
    "ON_HOLD",
    "SCHEDULED",
    "REQUEST_DECLINED",
    "OPEN", // deprecated, replaced by UNFULFILLED
    "PENDING_FULFILLMENT", // deprecated, replaced by IN_PROGRESS
    "RESTOCKED", // deprecated, replaced by UNFULFILLED
  ])("classifies fulfillment status %s (paid) as NEEDS_ATTENTION", (fulfillmentStatus) => {
    expect(
      evaluateOrderStatus({ ...base, fulfillmentStatus, financialStatus: "PAID" }),
    ).toEqual({ status: "NEEDS_ATTENTION", refundPending: false });
  });

  it("defaults an unrecognized enum value to NEEDS_ATTENTION rather than erroring", () => {
    expect(
      evaluateOrderStatus({
        ...base,
        financialStatus: "SOME_FUTURE_VALUE",
        fulfillmentStatus: "SOME_FUTURE_VALUE",
      }),
    ).toEqual({ status: "NEEDS_ATTENTION", refundPending: false });
  });

  it("defaults an order with no status data at all to NEEDS_ATTENTION", () => {
    expect(evaluateOrderStatus(base)).toEqual({
      status: "NEEDS_ATTENTION",
      refundPending: false,
    });
  });
});
