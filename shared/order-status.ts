/**
 * Pure decision-table logic for classifying an order's status. No I/O, no Prisma — shared
 * between the React Router app (for recomputation/tests) and the queue worker (the actual write
 * path). See docs/PLAN.md, "Decision table — order status" for the rationale behind each row.
 */

export type OrderStatus =
  | "NEEDS_ATTENTION"
  | "COMPLETED"
  | "CANCELLED"
  | "STALE"
  | "DELETED";

export type EventAction = "create" | "update" | "delete";

export interface OrderStatusInput {
  action: EventAction;
  /** Order.displayFinancialStatus, verbatim from Shopify (or null if unknown). */
  financialStatus: string | null;
  /** Order.displayFulfillmentStatus, verbatim from Shopify (or null if unknown). */
  fulfillmentStatus: string | null;
  /** True when `cancellation != null` or `cancelledAt != null` on the order snapshot. */
  isCancelled: boolean;
  /** Order.closed from the snapshot. */
  closed: boolean;
  /**
   * True when this is an `update` whose `data.order` came back null/errored AND the order is
   * known to be 60+ days old (the read_orders window) — see docs/PLAN.md. Never derive this from
   * `financialStatus`/`fulfillmentStatus` being null on their own; a query can also fail for
   * other reasons the caller should surface as a real error instead of silently going stale.
   */
  isStale: boolean;
}

export interface OrderStatusResult {
  status: OrderStatus;
  /** Only meaningful when status === "CANCELLED"; false in every other case. */
  refundPending: boolean;
}

/** displayFinancialStatus values where money is still captured or held on a cancelled order. */
const MONEY_STILL_HELD = new Set([
  "PAID",
  "PARTIALLY_PAID",
  "PARTIALLY_REFUNDED",
  "AUTHORIZED",
]);

/** displayFulfillmentStatus values meaning there's no fulfillment work left. */
const FULFILLMENT_DONE = new Set(["FULFILLED", "FULFILLMENT_NOT_REQUIRED"]);

/** displayFinancialStatus values that pair with FULFILLMENT_DONE to match Shopify's auto-archive
 * rule ("paid and fulfilled"). REFUNDED is handled separately (row 4) since it's done regardless
 * of fulfillment status. */
const FINANCIAL_DONE_WITH_FULFILLMENT = new Set(["PAID", "PARTIALLY_REFUNDED"]);

export function evaluateOrderStatus(input: OrderStatusInput): OrderStatusResult {
  // Row 0: tombstone. Overrides everything else.
  if (input.action === "delete") {
    return { status: "DELETED", refundPending: false };
  }

  // Row 1: can't get current data for an order past the read_orders window.
  if (input.isStale) {
    return { status: "STALE", refundPending: false };
  }

  // Row 2: cancelled. Still needs attention if money hasn't been fully returned.
  if (input.isCancelled) {
    const refundPending =
      input.financialStatus != null && MONEY_STILL_HELD.has(input.financialStatus);
    return { status: "CANCELLED", refundPending };
  }

  // Row 3: Shopify itself says this order is closed/archived.
  if (input.closed) {
    return { status: "COMPLETED", refundPending: false };
  }

  // Row 4: fully refunded — matches auto-archive's "fully refunded" condition.
  if (input.financialStatus === "REFUNDED") {
    return { status: "COMPLETED", refundPending: false };
  }

  // Row 5: paid and fulfilled — matches auto-archive's "paid and fulfilled" condition.
  if (
    input.fulfillmentStatus != null &&
    FULFILLMENT_DONE.has(input.fulfillmentStatus) &&
    input.financialStatus != null &&
    FINANCIAL_DONE_WITH_FULFILLMENT.has(input.financialStatus)
  ) {
    return { status: "COMPLETED", refundPending: false };
  }

  // Row 6: default-safe. Includes every not-yet-done combination and any enum value this app
  // doesn't recognize (the unstable API can add values) — when in doubt, stay visible.
  return { status: "NEEDS_ATTENTION", refundPending: false };
}
