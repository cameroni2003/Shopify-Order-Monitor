import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getAgeRules, getShowTestOrders } from "../lib/db/settings.server";
import { listNeedsAttentionOrders, listOrdersByStatus } from "../lib/db/orders.server";
import { countCommentsForOrders } from "../lib/db/comments.server";
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
 * App Home reads from our own database, not live from Shopify (docs/PLAN.md), so "real time"
 * here means polling our own (cheap, indexed) query on an interval and letting React Router
 * revalidate the loader in place — no new infra, no websocket/SSE server. Order statuses change
 * on the order of seconds after a Shopify event, not sub-second, so a 5s interval is "real enough
 * time" without hammering Postgres.
 */
const POLL_INTERVAL_MS = 5000;

interface TabDef {
  id: string;
  label: string;
  status: OrderStatus;
}

// Order matches docs/PLAN.md: Needs attention first (it's the primary view), then the three
// history tabs in the order a merchant would care about them.
const TABS: TabDef[] = [
  { id: "needs_attention", label: "Needs attention", status: "NEEDS_ATTENTION" },
  { id: "completed", label: "Completed", status: "COMPLETED" },
  { id: "cancelled", label: "Cancelled", status: "CANCELLED" },
  { id: "stale", label: "Stale (60+ days)", status: "STALE" },
];

/**
 * Cursor-stack encoding for "Previous" support over keyset pagination. Each `prev` param value
 * is a comma-separated stack of ancestor cursors (an empty string element means "first page, no
 * cursor"). Shopify order GIDs never contain commas, so this is a safe, dependency-free encoding
 * — no need for JSON/base64 for something this simple.
 */
function decodeCursorStack(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",");
}

function encodeCursorStack(stack: string[]): string {
  return stack.join(",");
}

function buildPageUrl(params: {
  tabId: string;
  cursor?: string;
  prevCursors?: string[];
}): string {
  const search = new URLSearchParams();
  search.set("tab", params.tabId);
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.prevCursors && params.prevCursors.length > 0) {
    search.set("prev", encodeCursorStack(params.prevCursors));
  }
  return `/app?${search.toString()}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const requestedTabId = url.searchParams.get("tab");
  const tab = TABS.find((t) => t.id === requestedTabId) ?? TABS[0]!;
  const cursor = url.searchParams.get("cursor") || undefined;
  const prevCursors = decodeCursorStack(url.searchParams.get("prev"));

  const [ageRules, showTestOrders] = await Promise.all([
    getAgeRules(shopDomain),
    getShowTestOrders(shopDomain),
  ]);

  const rows =
    tab.id === "needs_attention"
      ? await listNeedsAttentionOrders(shopDomain, {
          cursor,
          take: PAGE_SIZE,
          includeTestOrders: showTestOrders,
        })
      : await listOrdersByStatus(
          shopDomain,
          tab.status as Exclude<OrderStatus, "DELETED" | "NEEDS_ATTENTION">,
          { cursor, take: PAGE_SIZE, includeTestOrders: showTestOrders },
        );

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
    tabId: tab.id,
    tabs: TABS,
    orders,
    hasNextPage,
    hasPreviousPage,
    nextPageUrl: hasNextPage
      ? buildPageUrl({
          tabId: tab.id,
          cursor: nextCursor ?? undefined,
          prevCursors: [...prevCursors, cursor ?? ""],
        })
      : null,
    previousPageUrl: hasPreviousPage
      ? buildPageUrl({
          tabId: tab.id,
          cursor: prevCursors[prevCursors.length - 1] || undefined,
          prevCursors: prevCursors.slice(0, -1),
        })
      : null,
  };
};

export default function AppIndex() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  // Poll for status changes while this page is open, so an order that gets fulfilled/paid/
  // cancelled elsewhere (or by the worker processing a new event) shows up without a manual
  // reload. Paused while the tab isn't visible, and skipped whenever a revalidation (or the
  // initial load) is already in flight, so polls never stack up.
  useEffect(() => {
    const intervalId = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, POLL_INTERVAL_MS);

    function handleVisibilityChange() {
      // Catch up immediately on refocus rather than waiting out the rest of the interval.
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // revalidator's identity is stable across renders; re-running this effect on every
    // revalidator.state change would tear down and restart the interval on each poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <s-page heading="Order monitor">
      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button-group gap="none">
              {data.tabs.map((tab) => (
                <s-button
                  key={tab.id}
                  href={buildPageUrl({ tabId: tab.id })}
                  variant={tab.id === data.tabId ? "primary" : "secondary"}
                >
                  {tab.label}
                </s-button>
              ))}
            </s-button-group>
            {revalidator.state === "loading" && (
              <s-spinner size="base" accessibilityLabel="Refreshing orders"></s-spinner>
            )}
          </s-stack>
        </s-box>

        {data.orders.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No orders in this view.</s-paragraph>
          </s-box>
        ) : (
          <s-table
            paginate
            hasPreviousPage={data.hasPreviousPage}
            hasNextPage={data.hasNextPage}
            onPreviousPage={() => {
              if (data.previousPageUrl) navigate(data.previousPageUrl);
            }}
            onNextPage={() => {
              if (data.nextPageUrl) navigate(data.nextPageUrl);
            }}
          >
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="labeled">Age</s-table-header>
              <s-table-header listSlot="labeled">Payment</s-table-header>
              <s-table-header listSlot="labeled">Fulfillment</s-table-header>
              <s-table-header listSlot="labeled">Total</s-table-header>
              <s-table-header listSlot="labeled">Items</s-table-header>
              <s-table-header listSlot="labeled">Last updated</s-table-header>
              <s-table-header listSlot="inline">Comments</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.orders.map((order) => (
                <s-table-row key={order.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-link href={`/app/orders/${encodeURIComponent(order.id)}`}>
                        {order.name}
                      </s-link>
                      {order.isTest && <s-badge>Test</s-badge>}
                      {order.refundPending && <s-badge tone="warning">Refund pending</s-badge>}
                      {order.staleSince && <s-badge tone="info">Stale</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      {order.ageColor && (
                        <div
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: "50%",
                            background: order.ageColor,
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <s-text>{order.ageLabel}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {order.financialStatus ? (
                      <s-badge {...(order.financialTone ? { tone: order.financialTone } : {})}>
                        {order.financialStatus}
                      </s-badge>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {order.fulfillmentStatus ? (
                      <s-badge {...(order.fulfillmentTone ? { tone: order.fulfillmentTone } : {})}>
                        {order.fulfillmentStatus}
                      </s-badge>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                  <s-table-cell>{order.total}</s-table-cell>
                  <s-table-cell>{order.itemsCount ?? "—"}</s-table-cell>
                  <s-table-cell>{order.lastUpdated}</s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/orders/${encodeURIComponent(order.id)}`}>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-icon type="chat"></s-icon>
                        <s-text>{order.commentCount}</s-text>
                      </s-stack>
                    </s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
