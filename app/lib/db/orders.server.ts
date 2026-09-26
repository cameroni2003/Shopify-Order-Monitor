import { Prisma } from "@prisma/client";
import type { OrderStatus } from "../../../shared/order-status";
import { planOrderWrite, type StoredOrderRow } from "../../../shared/order-write-plan";
import type { NormalizedEvent } from "../../../shared/shopify-delivery";
import { withShop } from "./shop-scope.server";
import { ensureShop } from "./shops.server";

/**
 * Read-only queries backing the App Home tabs, plus the event → upsert write path (milestone 2).
 */

type PrismaOrderRow = Awaited<ReturnType<typeof findOrder>>;

function toStoredOrderRow(row: PrismaOrderRow): StoredOrderRow | null {
  if (!row) return null;
  return {
    name: row.name,
    financialStatus: row.financialStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    isCancelled: row.isCancelled,
    cancelledAt: row.cancelledAt,
    refundPending: row.refundPending,
    shopifyClosed: row.shopifyClosed,
    shopifyClosedAt: row.shopifyClosedAt,
    isTest: row.isTest,
    totalAmount: row.totalAmount?.toString() ?? null,
    totalCurrency: row.totalCurrency,
    itemsCount: row.itemsCount,
    shopifyCreatedAt: row.shopifyCreatedAt,
    shopifyUpdatedAt: row.shopifyUpdatedAt,
    lastTriggeredAt: row.lastTriggeredAt,
    orderStatus: row.orderStatus,
    staleSince: row.staleSince,
    deletedAt: row.deletedAt,
  };
}

export type ApplyOrderEventResult =
  | { outcome: "duplicate" }
  | { outcome: "skipped_stale_delivery" }
  | { outcome: "written"; orderStatus: OrderStatus };

/**
 * The write path: dedup → look up existing row → plan the write (shared/order-write-plan.ts,
 * pure and fully unit-tested) → apply it. Dedup and the order write happen in the same
 * transaction, so a crash between them can't record a delivery as processed without its effect
 * having actually landed — see docs/PLAN.md, "Order upsert logic".
 */
export async function applyOrderEvent(
  event: NormalizedEvent,
  now: Date = new Date(),
): Promise<ApplyOrderEventResult> {
  // Shop isn't row-level-secured (see prisma/schema.prisma) and must exist before the Order FK
  // insert below can succeed; ensureShop is idempotent (upsert), so this is safe to call on
  // every event rather than only on install.
  await ensureShop(event.shopDomain);

  return withShop(event.shopDomain, async (tx) => {
    try {
      await tx.processedDelivery.create({
        data: { shopDomain: event.shopDomain, webhookId: event.webhookId },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { outcome: "duplicate" };
      }
      throw err;
    }

    const existingRow = await tx.order.findUnique({
      where: { shopDomain_shopifyOrderId: { shopDomain: event.shopDomain, shopifyOrderId: event.orderId } },
    });

    const plan = planOrderWrite(toStoredOrderRow(existingRow), event, now);

    if (plan.action === "skip_stale_delivery") {
      return { outcome: "skipped_stale_delivery" };
    }
    if (plan.action === "reject_missing_data") {
      // Propagates out of the transaction (rolling back the dedup insert too) so the message
      // retries and eventually reaches the DLQ instead of being silently accepted.
      throw new Error(plan.reason);
    }

    await tx.order.upsert({
      where: { shopDomain_shopifyOrderId: { shopDomain: event.shopDomain, shopifyOrderId: event.orderId } },
      create: { shopDomain: event.shopDomain, shopifyOrderId: event.orderId, ...plan.fields },
      update: { ...plan.fields },
    });

    return { outcome: "written", orderStatus: plan.fields.orderStatus };
  });
}

export async function findOrder(shopDomain: string, shopifyOrderId: string) {
  return withShop(shopDomain, (tx) =>
    tx.order.findUnique({
      where: { shopDomain_shopifyOrderId: { shopDomain, shopifyOrderId } },
    }),
  );
}

export interface ListOrdersOptions {
  cursor?: string;
  take?: number;
  includeTestOrders?: boolean;
}

/** Ascending by createdAt — used only by the Needs attention tab (oldest first). */
export async function listNeedsAttentionOrders(
  shopDomain: string,
  { cursor, take = 50, includeTestOrders = true }: ListOrdersOptions = {},
) {
  return withShop(shopDomain, (tx) =>
    tx.order.findMany({
      where: {
        shopDomain,
        orderStatus: "NEEDS_ATTENTION" satisfies OrderStatus,
        ...(includeTestOrders ? {} : { isTest: false }),
      },
      orderBy: [{ shopifyCreatedAt: "asc" }, { shopifyOrderId: "asc" }],
      take: take + 1,
      ...(cursor ? { cursor: { shopDomain_shopifyOrderId: { shopDomain, shopifyOrderId: cursor } }, skip: 1 } : {}),
    }),
  );
}

/** Descending by updatedAt — used by Completed, Cancelled, and Stale (all newest first). */
export async function listOrdersByStatus(
  shopDomain: string,
  status: Exclude<OrderStatus, "DELETED" | "NEEDS_ATTENTION">,
  { cursor, take = 50, includeTestOrders = true }: ListOrdersOptions = {},
) {
  return withShop(shopDomain, (tx) =>
    tx.order.findMany({
      where: {
        shopDomain,
        orderStatus: status,
        ...(includeTestOrders ? {} : { isTest: false }),
      },
      orderBy: [{ shopifyUpdatedAt: "desc" }, { shopifyOrderId: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { shopDomain_shopifyOrderId: { shopDomain, shopifyOrderId: cursor } }, skip: 1 } : {}),
    }),
  );
}
