import { useState, useSyncExternalStore } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { findOrder } from "../lib/db/orders.server";
import {
  ageInDays,
  buildAdminOrderUrl,
  formatAbsoluteDateTime,
  formatTimeSince,
  formatMoney,
  numericIdFromGid,
} from "../../shared/format";
import { financialStatusTone, fulfillmentStatusTone } from "../../shared/status-badge";

// Below this viewport width the timeline drops under the comments and the comments list becomes
// collapsible. Keep in sync with the container-query breakpoint on the two-column s-grid below.
const NARROW_QUERY = "(max-width: 900px)";

function subscribeNarrow(onChange: () => void) {
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function useIsNarrow() {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

const TIMELINE_QUERY = `#graphql
  query OrderTimeline($id: ID!) {
    order(id: $id) {
      events(first: 100, reverse: true) {
        nodes {
          __typename
          id
          message
          createdAt
          ... on CommentEvent {
            rawMessage
            edited
          }
        }
      }
    }
  }
`;

type TimelineNode = {
  __typename: string;
  id: string;
  message: string | null;
  createdAt: string;
  rawMessage?: string;
  edited?: boolean;
};

/** Event messages are HTML snippets (links etc.); strip tags so they render as plain text. */
function stripHtml(html: string | null) {
  return (html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * The order's timeline straight from Shopify (there's no local copy), split into staff comments
 * (CommentEvent — the single source of truth for comments, managed in Shopify admin) and the
 * remaining events. Failures degrade to an empty result with an error flag rather than breaking
 * the page.
 */
async function loadTimeline(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  orderId: string,
  now: Date,
) {
  try {
    const response = await admin.graphql(TIMELINE_QUERY, { variables: { id: orderId } });
    const json = await response.json();
    if ("errors" in json && json.errors) throw new Error("Timeline query returned errors");
    const nodes: TimelineNode[] = json.data?.order?.events?.nodes ?? [];
    const toItem = (e: TimelineNode, message: string) => ({
      id: e.id,
      message,
      createdAt: e.createdAt,
      createdAtLabel: formatTimeSince(new Date(e.createdAt), now),
    });
    return {
      timelineError: false,
      comments: nodes
        .filter((e) => e.__typename === "CommentEvent")
        .map((e) => ({ ...toItem(e, e.rawMessage ?? stripHtml(e.message)), edited: !!e.edited })),
      timeline: nodes
        .filter((e) => e.__typename !== "CommentEvent")
        .map((e) => toItem(e, stripHtml(e.message))),
    };
  } catch (err) {
    console.error("Failed to load order timeline", err);
    return { timelineError: true, comments: [], timeline: [] };
  }
}

/**
 * Where the breadcrumb should go back to, and — via this route's optional $status segment — what
 * makes the left nav highlight the right item, since it's whichever status page this order
 * actually lives on, not a hardcoded "Needs attention". DELETED orders aren't listed on any page,
 * so they fall back to Needs attention (there's no correct destination for them).
 */
const STATUS_PAGE: Record<string, { href: string; label: string }> = {
  NEEDS_ATTENTION: { href: "/app", label: "Needs attention" },
  COMPLETED: { href: "/app/completed", label: "Completed" },
  CANCELLED: { href: "/app/cancelled", label: "Cancelled" },
  STALE: { href: "/app/stale", label: "Stale" },
  DELETED: { href: "/app", label: "Needs attention" },
};

function serializeOrder(
  order: NonNullable<Awaited<ReturnType<typeof findOrder>>>,
  shopDomain: string,
  now: Date,
) {
  const numericId = numericIdFromGid(order.shopifyOrderId);
  const ageDays = ageInDays(order.shopifyCreatedAt, now);
  return {
    id: order.shopifyOrderId,
    name: order.name ?? (numericId ? `#${numericId}` : order.shopifyOrderId),
    adminUrl: buildAdminOrderUrl(shopDomain, order.shopifyOrderId),
    financialStatus: order.financialStatus,
    financialTone: financialStatusTone(order.financialStatus),
    fulfillmentStatus: order.fulfillmentStatus,
    fulfillmentTone: fulfillmentStatusTone(order.fulfillmentStatus),
    total: formatMoney(order.totalAmount?.toString() ?? null, order.totalCurrency),
    itemsCount: order.itemsCount,
    ageLabel: ageDays == null ? "—" : `${ageDays}d`,
    lastUpdated: formatTimeSince(order.shopifyUpdatedAt ?? order.lastTriggeredAt, now),
    isTest: order.isTest,
    refundPending: order.refundPending,
    isDeleted: order.orderStatus === "DELETED",
    isStale: order.orderStatus === "STALE",
    staleSince: order.staleSince ? order.staleSince.toISOString() : null,
    statusPage: STATUS_PAGE[order.orderStatus] ?? STATUS_PAGE.NEEDS_ATTENTION!,
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const orderId = params.orderId!;

  const order = await findOrder(shopDomain, orderId);
  if (!order) {
    // Also covers another shop's order id: findOrder is RLS-scoped to shopDomain, so a
    // cross-tenant id looks identical to a nonexistent one — see docs/PLAN.md.
    throw new Response("Order not found", { status: 404 });
  }

  const url = new URL(request.url);

  // The URL's status segment (if any) is what makes the left nav highlight the right item —
  // s-app-nav has no "active" override, it just matches the current path against each s-link's
  // href, so this page's path has to actually fall under the right one. Canonicalize it here
  // rather than trusting the link that got the visitor here (a bookmark, or an order whose
  // status changed after the list page rendered the link).
  const statusPage = STATUS_PAGE[order.orderStatus] ?? STATUS_PAGE.NEEDS_ATTENTION!;
  const canonicalPath = `${statusPage.href}/orders/${encodeURIComponent(orderId)}`;
  if (url.pathname !== canonicalPath) {
    throw redirect(`${canonicalPath}${url.search}`);
  }

  const now = new Date();
  const timelinePage =
    order.orderStatus === "DELETED"
      ? { timelineError: false, comments: [], timeline: [] }
      : await loadTimeline(admin, orderId, now);

  return {
    order: serializeOrder(order, shopDomain, now),
    ...timelinePage,
  };
};

// True only after hydration, so timezone-dependent text (times, "Today") is rendered client-side
// instead of mismatching the server's render.
function useHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function dayLabel(date: Date, now: Date) {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return dayFormat.format(date);
}

type TimelineItem = { id: string; message: string; createdAt: string; createdAtLabel: string };

function Timeline({ events }: { events: TimelineItem[] }) {
  const hydrated = useHydrated();
  const now = new Date();
  // Consecutive events sharing a local calendar day sit under one heading, like Shopify's own.
  const groups: { label: string; events: TimelineItem[] }[] = [];
  for (const event of events) {
    const label = hydrated ? dayLabel(new Date(event.createdAt), now) : "";
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.events.push(event);
    else groups.push({ label, events: [event] });
  }

  return (
    <>
      <style>{`
        .tl { position: relative; margin: 0; padding: 0; list-style: none; }
        .tl::before { content: ""; position: absolute; left: 5px; top: 8px; bottom: 8px; width: 2px; background: rgba(128,128,128,.3); }
        .tl-day { margin: 12px 0 4px 24px; font-size: 13px; opacity: .65; }
        .tl-day:first-child { margin-top: 0; }
        .tl-item { position: relative; display: flex; justify-content: space-between; gap: 12px; padding: 8px 0 8px 24px; }
        .tl-item::before { content: ""; position: absolute; left: 0; top: 13px; width: 12px; height: 12px; box-sizing: border-box; border-radius: 50%; background: currentColor; opacity: .75; border: 2px solid transparent; }
        .tl-msg { flex: 1; min-width: 0; overflow-wrap: anywhere; }
        .tl-time { flex: none; font-size: 13px; opacity: .65; white-space: nowrap; }
      `}</style>
      <div className="tl">
        {groups.map((group, i) => (
          <div key={`${group.label}-${i}`}>
            {group.label && <div className="tl-day">{group.label}</div>}
            {group.events.map((event) => {
              const date = new Date(event.createdAt);
              return (
                <div key={event.id} className="tl-item">
                  <span className="tl-msg">{event.message}</span>
                  <span className="tl-time" title={formatAbsoluteDateTime(date)}>
                    {hydrated ? timeFormat.format(date) : event.createdAtLabel}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

export default function OrderDetail() {
  const data = useLoaderData<typeof loader>();

  const isNarrow = useIsNarrow();
  const [commentsCollapsed, setCommentsCollapsed] = useState(false);
  const showCommentList = !isNarrow || !commentsCollapsed;
  const comments = data.comments;

  return (
    <s-page heading={data.order.name}>
      <s-link slot="breadcrumb-actions" href={data.order.statusPage.href}>
        {data.order.statusPage.label}
      </s-link>

      <s-section>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-heading>Order details</s-heading>
          {data.order.isTest && <s-badge>Test</s-badge>}
        </s-stack>
        {(data.order.refundPending || data.order.isStale || data.order.isDeleted) && (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {data.order.refundPending && <s-badge tone="warning">Refund pending</s-badge>}
            {data.order.isStale && <s-badge tone="info">Stale</s-badge>}
            {data.order.isDeleted && <s-badge tone="critical">Deleted in Shopify</s-badge>}
          </s-stack>
        )}

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(10rem, 1fr))" gap="base">
          <s-box>
            <s-text color="subdued">Payment</s-text>
            <br />
            {data.order.financialStatus ? (
              <s-badge {...(data.order.financialTone ? { tone: data.order.financialTone } : {})}>
                {data.order.financialStatus}
              </s-badge>
            ) : (
              "—"
            )}
          </s-box>
          <s-box>
            <s-text color="subdued">Fulfillment</s-text>
            <br />
            {data.order.fulfillmentStatus ? (
              <s-badge {...(data.order.fulfillmentTone ? { tone: data.order.fulfillmentTone } : {})}>
                {data.order.fulfillmentStatus}
              </s-badge>
            ) : (
              "—"
            )}
          </s-box>
          <s-box>
            <s-text color="subdued">Total</s-text>
            <s-paragraph>{data.order.total}</s-paragraph>
          </s-box>
          <s-box>
            <s-text color="subdued">Items</s-text>
            <s-paragraph>{data.order.itemsCount ?? "—"}</s-paragraph>
          </s-box>
          <s-box>
            <s-text color="subdued">Age</s-text>
            <s-paragraph>{data.order.ageLabel}</s-paragraph>
          </s-box>
          <s-box>
            <s-text color="subdued">Last updated</s-text>
            <s-paragraph>{data.order.lastUpdated}</s-paragraph>
          </s-box>
        </s-grid>

        {data.order.adminUrl && (
          <s-box paddingBlockStart="base">
            <s-link href={data.order.adminUrl} target="_blank">
              View Order
            </s-link>
          </s-box>
        )}
      </s-section>

      <s-grid gridTemplateColumns="@container (inline-size > 900px) 1fr 1fr, 1fr" gap="base">
      <s-section heading={`Comments (${comments.length})`}>
        {/* Comments live on the order's Shopify timeline, so this is the one place to add them. */}
        {data.order.adminUrl && (
          <s-box paddingBlockEnd="base">
            <s-button variant="primary" href={data.order.adminUrl} target="_blank">
              Add a comment
            </s-button>
          </s-box>
        )}

        {isNarrow && comments.length > 0 && (
          <s-box paddingBlockEnd="base">
            <s-button variant="secondary" onClick={() => setCommentsCollapsed((c) => !c)}>
              {commentsCollapsed ? `Show comments (${comments.length})` : "Hide comments"}
            </s-button>
          </s-box>
        )}

        {showCommentList && (
          <s-stack direction="block" gap="base">
            {comments.length === 0 ? (
              <s-paragraph>No comments yet.</s-paragraph>
            ) : (
              comments.map((comment) => (
                <s-box key={comment.id} padding="base" background="subdued" borderRadius="base">
                  <span title={formatAbsoluteDateTime(new Date(comment.createdAt))}>
                    <s-text color="subdued">
                      {comment.createdAtLabel}
                      {comment.edited ? " (edited)" : ""}
                    </s-text>
                  </span>
                  <s-paragraph>{comment.message}</s-paragraph>
                </s-box>
              ))
            )}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Timeline">
        {data.timelineError ? (
          <s-paragraph>Couldn't load the timeline from Shopify.</s-paragraph>
        ) : data.timeline.length === 0 ? (
          <s-paragraph>No timeline events.</s-paragraph>
        ) : (
          <Timeline events={data.timeline} />
        )}
      </s-section>
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
