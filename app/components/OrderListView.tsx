import { useEffect } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { OrderListPageData } from "../lib/order-list.server";

/**
 * App Home reads from our own database, not live from Shopify (docs/PLAN.md), so "real time"
 * here means polling our own (cheap, indexed) query on an interval and letting React Router
 * revalidate the loader in place — no new infra, no websocket/SSE server.
 */
const POLL_INTERVAL_MS = 5000;

export interface OrderListViewProps {
  heading: string;
  data: OrderListPageData;
}

/**
 * Shared table + polling UI for the four order-list pages (Needs attention/Completed/Cancelled/
 * Stale — separate pages, one per status, linked from the app nav, not tabs on one route — see
 * docs/PLAN.md). Each route's default export is just `<OrderListView heading="..." data={...} />`.
 */
export function OrderListView({ heading, data }: OrderListViewProps) {
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
    <s-page heading={heading}>
      <s-section padding="none">
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
                      {order.adminUrl ? (
                        <s-link href={order.adminUrl} target="_blank">
                          {order.name}
                        </s-link>
                      ) : (
                        <s-text>{order.name}</s-text>
                      )}
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
