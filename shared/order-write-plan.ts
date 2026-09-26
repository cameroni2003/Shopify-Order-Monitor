import { evaluateOrderStatus, type OrderStatus } from "./order-status";
import type { NormalizedEvent } from "./shopify-delivery";

/**
 * Everything the write path needs to know about the row that's already stored, in a form that
 * doesn't depend on Prisma's generated types (so this stays pure and testable without a
 * database). See app/lib/db/orders.server.ts for the mapping from a real Prisma row.
 */
export interface StoredOrderRow {
  name: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  isCancelled: boolean;
  cancelledAt: Date | null;
  refundPending: boolean;
  shopifyClosed: boolean;
  shopifyClosedAt: Date | null;
  isTest: boolean;
  totalAmount: string | null;
  totalCurrency: string | null;
  itemsCount: number | null;
  shopifyCreatedAt: Date | null;
  shopifyUpdatedAt: Date | null;
  lastTriggeredAt: Date | null;
  orderStatus: OrderStatus;
  staleSince: Date | null;
  deletedAt: Date | null;
}

export type OrderWriteFields = Omit<StoredOrderRow, "lastTriggeredAt"> & { lastTriggeredAt: Date };

export type OrderWritePlan =
  | { action: "skip_stale_delivery" }
  | { action: "reject_missing_data"; reason: string }
  | { action: "write"; fields: OrderWriteFields };

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Carries an existing row's status fields forward unchanged (used by the DELETED and STALE
 * branches, which must never clobber last-known values — see docs/PLAN.md). */
function retainedFields(existing: StoredOrderRow | null): Omit<StoredOrderRow, "orderStatus" | "staleSince" | "deletedAt" | "lastTriggeredAt"> {
  if (existing == null) {
    return {
      name: null,
      financialStatus: null,
      fulfillmentStatus: null,
      isCancelled: false,
      cancelledAt: null,
      refundPending: false,
      shopifyClosed: false,
      shopifyClosedAt: null,
      isTest: false,
      totalAmount: null,
      totalCurrency: null,
      itemsCount: null,
      shopifyCreatedAt: null,
      shopifyUpdatedAt: null,
    };
  }
  const {
    name,
    financialStatus,
    fulfillmentStatus,
    isCancelled,
    cancelledAt,
    refundPending,
    shopifyClosed,
    shopifyClosedAt,
    isTest,
    totalAmount,
    totalCurrency,
    itemsCount,
    shopifyCreatedAt,
    shopifyUpdatedAt,
  } = existing;
  return {
    name,
    financialStatus,
    fulfillmentStatus,
    isCancelled,
    cancelledAt,
    refundPending,
    shopifyClosed,
    shopifyClosedAt,
    isTest,
    totalAmount,
    totalCurrency,
    itemsCount,
    shopifyCreatedAt,
    shopifyUpdatedAt,
  };
}

/**
 * Decides what to write for an order row given the existing stored state (or null for a
 * never-seen order) and an incoming NormalizedEvent. Pure — no I/O — so the full decision space
 * (delete, stale, out-of-order, normal update) is unit-tested without a database. The DB-facing
 * wrapper is app/lib/db/orders.server.ts::applyOrderEvent.
 */
export function planOrderWrite(
  existing: StoredOrderRow | null,
  event: NormalizedEvent,
  now: Date,
): OrderWritePlan {
  const triggeredAt = parseDate(event.triggeredAt) ?? now;

  // Tombstone. Retains last-known status fields per docs/PLAN.md ("retain forever").
  if (event.action === "delete") {
    return {
      action: "write",
      fields: {
        ...retainedFields(existing),
        lastTriggeredAt: triggeredAt,
        orderStatus: "DELETED",
        staleSince: existing?.staleSince ?? null,
        deletedAt: now,
      },
    };
  }

  const dataMissing = event.order == null || (event.errors != null && event.errors.length > 0);

  if (dataMissing) {
    const createdAt = existing?.shopifyCreatedAt ?? null;
    if (createdAt != null) {
      const ageMs = now.getTime() - createdAt.getTime();
      if (ageMs < SIXTY_DAYS_MS) {
        const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
        return {
          action: "reject_missing_data",
          reason:
            `data.order is missing/errored for an order only ${ageDays} days old (under the ` +
            `60-day read_orders window) — treating this as a real query failure, not staleness. ` +
            `See docs/PLAN.md, "60-day order window".`,
        };
      }
    }
    // Either the order is confirmed 60+ days old, or we've never seen it before and can't tell —
    // in both cases docs/PLAN.md says to classify as STALE rather than guess further.
    return {
      action: "write",
      fields: {
        ...retainedFields(existing),
        lastTriggeredAt: triggeredAt,
        orderStatus: "STALE",
        staleSince: existing?.staleSince ?? now,
        deletedAt: existing?.deletedAt ?? null,
      },
    };
  }

  // Out-of-order delivery guard: compare the incoming snapshot's version against what's stored.
  const incomingVersion = parseDate(event.order!.updatedAt) ?? triggeredAt;
  const storedVersion = existing?.shopifyUpdatedAt ?? existing?.lastTriggeredAt ?? null;
  if (storedVersion != null && incomingVersion.getTime() < storedVersion.getTime()) {
    return { action: "skip_stale_delivery" };
  }

  const snapshot = event.order!;
  const isCancelled = snapshot.cancellation != null || snapshot.cancelledAt != null;
  const { status, refundPending } = evaluateOrderStatus({
    action: event.action,
    financialStatus: snapshot.displayFinancialStatus,
    fulfillmentStatus: snapshot.displayFulfillmentStatus,
    isCancelled,
    closed: snapshot.closed === true,
    isStale: false,
  });

  return {
    action: "write",
    fields: {
      name: snapshot.name,
      financialStatus: snapshot.displayFinancialStatus,
      fulfillmentStatus: snapshot.displayFulfillmentStatus,
      isCancelled,
      cancelledAt: parseDate(snapshot.cancelledAt),
      refundPending,
      shopifyClosed: snapshot.closed === true,
      shopifyClosedAt: parseDate(snapshot.closedAt),
      isTest: snapshot.test === true,
      totalAmount: snapshot.currentTotalPriceSet?.shopMoney.amount ?? existing?.totalAmount ?? null,
      totalCurrency: snapshot.currentTotalPriceSet?.shopMoney.currencyCode ?? existing?.totalCurrency ?? null,
      itemsCount: snapshot.currentSubtotalLineItemsQuantity ?? existing?.itemsCount ?? null,
      shopifyCreatedAt: parseDate(snapshot.createdAt) ?? existing?.shopifyCreatedAt ?? null,
      shopifyUpdatedAt: incomingVersion,
      lastTriggeredAt: triggeredAt,
      orderStatus: status,
      // A real snapshot recovers the row from a previous STALE/DELETED classification — it's
      // authoritative over both.
      staleSince: null,
      deletedAt: null,
    },
  };
}
