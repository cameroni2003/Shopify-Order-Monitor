import { listNeedsAttentionOrders, listOrdersByStatus } from "./db/orders.server";
import { countCommentsForOrders } from "./db/comments.server";
import { getAgeRules, getShowTestOrders } from "./db/settings.server";
import { resolveAgeColor } from "../../shared/age-rules";
import {
  ageInDays,
  formatDaysHoursSince,
  formatMoney,
  numericIdFromGid,
} from "../../shared/format";
import { financialStatusTone, fulfillmentStatusTone } from "../../shared/status-badge";
import type { OrderStatus } from "../../shared/order-status";

const PAGE_SIZE = 50;

/**
 * Shared loader logic for the four order-list pages (Needs attention/Completed/Cancelled/Stale
 * — one page per status now, not tabs on one route; see docs/PLAN.md). Each route file just
 * supplies its own status and basePath and renders <OrderListView> with the result.
 */

function decodeCursorStack(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",");
}

function encodeCursorStack(stack: string[]): string {
  return stack.join(",");
}

function buildPageUrl(basePath: string, params: { cursor?: string; prevCursors?: string[] }): string {
  const search = new URLSearchParams();
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.prevCursors && params.prevCursors.length > 0) {
    search.set("prev", encodeCursorStack(params.prevCursors));
  }
  const qs = search.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export interface LoadOrderListPageOptions {
  shopDomain: string;
  status: OrderStatus;
  url: URL;
  /** This page's own path (e.g. "/app/completed"), used to build Next/Previous page URLs. */
  basePath: string;
}

export async function loadOrderListPage({ shopDomain, status, url, basePath }: LoadOrderListPageOptions) {
  const cursor = url.searchParams.get("cursor") || undefined;
  const prevCursors = decodeCursorStack(url.searchParams.get("prev"));

  const [ageRules, showTestOrders] = await Promise.all([
    getAgeRules(shopDomain),
    getShowTestOrders(shopDomain),
  ]);

  const rows =
    status === "NEEDS_ATTENTION"
      ? await listNeedsAttentionOrders(shopDomain, {
          cursor,
          take: PAGE_SIZE,
          includeTestOrders: showTestOrders,
        })
      : await listOrdersByStatus(shopDomain, status as Exclude<OrderStatus, "DELETED" | "NEEDS_ATTENTION">, {
          cursor,
          take: PAGE_SIZE,
          includeTestOrders: showTestOrders,
        });

  const hasNextPage = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);
  const nextCursor = hasNextPage ? pageRows[pageRows.length - 1]!.shopifyOrderId : null;
  const hasPreviousPage = prevCursors.length > 0 || Boolean(cursor);

  const commentCounts = await countCommentsForOrders(
    shopDomain,
    pageRows.map((r) => r.shopifyOrderId),
  );

  const now = new Date();

  const orders = pageRows.map((row) => {
    const ageDays = ageInDays(row.shopifyCreatedAt, now);
    const numericId = numericIdFromGid(row.shopifyOrderId);
    return {
      id: row.shopifyOrderId,
      name: row.name ?? (numericId ? `#${numericId}` : row.shopifyOrderId),
      ageLabel: ageDays == null ? "—" : `${ageDays}d`,
      ageColor: ageDays == null ? null : resolveAgeColor(ageDays, ageRules),
      financialStatus: row.financialStatus,
      financialTone: financialStatusTone(row.financialStatus),
      fulfillmentStatus: row.fulfillmentStatus,
      fulfillmentTone: fulfillmentStatusTone(row.fulfillmentStatus),
      total: formatMoney(row.totalAmount?.toString() ?? null, row.totalCurrency),
      itemsCount: row.itemsCount,
      lastUpdated: formatDaysHoursSince(row.shopifyUpdatedAt ?? row.lastTriggeredAt, now),
      commentCount: commentCounts[row.shopifyOrderId] ?? 0,
      isTest: row.isTest,
      refundPending: row.refundPending,
      staleSince: row.staleSince,
    };
  });

  return {
    orders,
    hasNextPage,
    hasPreviousPage,
    nextPageUrl: hasNextPage
      ? buildPageUrl(basePath, { cursor: nextCursor ?? undefined, prevCursors: [...prevCursors, cursor ?? ""] })
      : null,
    previousPageUrl: hasPreviousPage
      ? buildPageUrl(basePath, {
          cursor: prevCursors[prevCursors.length - 1] || undefined,
          prevCursors: prevCursors.slice(0, -1),
        })
      : null,
  };
}

export type OrderListPageData = Awaited<ReturnType<typeof loadOrderListPage>>;
