import type { OrderStatus } from "../../../shared/order-status";
import { withShop } from "./shop-scope.server";

/**
 * Read-only queries backing the App Home tabs. The write path (event → upsert →
 * evaluateOrderStatus) is milestone 2 — it needs the queue normalizer's NormalizedEvent shape,
 * which doesn't exist yet, so it isn't stubbed here.
 */

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
