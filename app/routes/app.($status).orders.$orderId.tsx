import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { findOrder } from "../lib/db/orders.server";
import { addComment, countComments, listComments } from "../lib/db/comments.server";
import {
  ageInDays,
  buildAdminOrderUrl,
  formatAbsoluteDateTime,
  formatTimeSince,
  formatMoney,
  numericIdFromGid,
} from "../../shared/format";
import { financialStatusTone, fulfillmentStatusTone } from "../../shared/status-badge";

const COMMENTS_PAGE_SIZE = 25;

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

async function loadCommentsPage(
  shopDomain: string,
  orderId: string,
  cursor: string | undefined,
  now: Date,
) {
  const [rows, totalCommentCount] = await Promise.all([
    listComments(shopDomain, orderId, { cursor, take: COMMENTS_PAGE_SIZE }),
    countComments(shopDomain, orderId),
  ]);
  const hasMoreComments = rows.length > COMMENTS_PAGE_SIZE;
  const pageRows = rows.slice(0, COMMENTS_PAGE_SIZE);
  return {
    comments: pageRows.map((c) => ({
      id: c.id,
      body: c.body,
      authorName: c.authorName ?? "Unknown",
      // Raw ISO for the client-side absolute-time tooltip (timezone-dependent, so it can't be
      // computed here — see formatAbsoluteDateTime), plus the same "X ago" phrasing the Last
      // updated field uses, computed server-side like everything else's relative time.
      createdAt: c.createdAt.toISOString(),
      createdAtLabel: formatTimeSince(c.createdAt, now),
    })),
    totalCommentCount,
    hasMoreComments,
    nextCommentsCursor: hasMoreComments ? pageRows[pageRows.length - 1]!.id : null,
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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

  const commentsCursor = url.searchParams.get("commentsCursor") || undefined;
  const now = new Date();
  const commentsPage = await loadCommentsPage(shopDomain, orderId, commentsCursor, now);

  return {
    order: serializeOrder(order, shopDomain, now),
    ...commentsPage,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const orderId = params.orderId!;

  const order = await findOrder(shopDomain, orderId);
  if (!order) {
    return { ok: false as const, error: "This order no longer exists." };
  }

  const formData = await request.formData();
  const body = String(formData.get("body") ?? "");

  const user = session.onlineAccessInfo?.associated_user;
  const authorName = user ? [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email : undefined;
  const authorUserId = user ? BigInt(user.id) : undefined;

  try {
    await addComment({ shopDomain, shopifyOrderId: orderId, body, authorUserId, authorName });
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Couldn't add comment." };
  }
};

export default function OrderDetail() {
  const data = useLoaderData<typeof loader>();
  const commentFetcher = useFetcher<typeof action>();
  const moreCommentsFetcher = useFetcher<typeof loader>();
  const shopify = useAppBridge();

  const isSubmitting = commentFetcher.state !== "idle";

  // Bumped only on a successful post, to remount — and thereby clear — the comment form. This
  // uses React's "adjust state during render" pattern (comparing against the last-seen fetcher
  // data and calling setState conditionally in the render body) rather than a setState-in-effect,
  // since a value like Date.now() computed directly in render would change on every render, and
  // an effect would fire the state update one render later than necessary.
  const [formKey, setFormKey] = useState(0);
  const [lastHandledCommentData, setLastHandledCommentData] = useState(commentFetcher.data);
  if (commentFetcher.data !== lastHandledCommentData) {
    setLastHandledCommentData(commentFetcher.data);
    if (commentFetcher.data?.ok) {
      setFormKey((k) => k + 1);
    }
  }

  // Showing a toast is a genuine side effect (an imperative call to App Bridge), so it stays in
  // an effect — it just no longer also carries the setState above.
  useEffect(() => {
    if (!commentFetcher.data) return;
    if (commentFetcher.data.ok) {
      shopify.toast.show("Comment added");
    } else {
      shopify.toast.show(commentFetcher.data.error ?? "Couldn't add comment", { isError: true });
    }
  }, [commentFetcher.data, shopify]);

  // "Load more" comments (docs/PLAN.md: first 25 load, then Load more) — appended into the
  // route's own loader data via a fetcher.load, rather than local component state, so the count
  // stays correct even if a new comment is posted (which revalidates this route's loader) while
  // an older page is already showing.
  const comments =
    moreCommentsFetcher.data && moreCommentsFetcher.data.order.id === data.order.id
      ? [...data.comments, ...moreCommentsFetcher.data.comments]
      : data.comments;
  const hasMoreComments = moreCommentsFetcher.data
    ? moreCommentsFetcher.data.hasMoreComments
    : data.hasMoreComments;
  const nextCommentsCursor = moreCommentsFetcher.data
    ? moreCommentsFetcher.data.nextCommentsCursor
    : data.nextCommentsCursor;

  function loadMoreComments() {
    if (!nextCommentsCursor) return;
    const params = new URLSearchParams({ commentsCursor: nextCommentsCursor });
    moreCommentsFetcher.load(
      `${data.order.statusPage.href}/orders/${encodeURIComponent(data.order.id)}?${params.toString()}`,
    );
  }

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

      <s-section heading={`Comments (${data.totalCommentCount})`}>
        <s-box paddingBlockEnd="base">
          <commentFetcher.Form method="post" key={formKey}>
            <s-stack direction="block" gap="base">
              <s-text-area
                label="Add a comment"
                name="body"
                rows={3}
                maxLength={5000}
                required
              ></s-text-area>
              <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
                Post
              </s-button>
            </s-stack>
          </commentFetcher.Form>
        </s-box>

        <s-stack direction="block" gap="base">
          {comments.length === 0 ? (
            <s-paragraph>No comments yet.</s-paragraph>
          ) : (
            comments.map((comment) => (
              <s-box key={comment.id} padding="base" background="subdued" borderRadius="base">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-text type="strong">{comment.authorName}</s-text>
                  {/* title (a native browser tooltip) is set from the raw ISO timestamp using
                      the viewer's own local timezone — that's inherently a client-side
                      computation (formatAbsoluteDateTime), not something the loader can get
                      right for every viewer. */}
                  <span title={formatAbsoluteDateTime(new Date(comment.createdAt))}>
                    <s-text color="subdued">{comment.createdAtLabel}</s-text>
                  </span>
                </s-stack>
                <s-paragraph>{comment.body}</s-paragraph>
              </s-box>
            ))
          )}
        </s-stack>

        {hasMoreComments && (
          <s-button
            variant="secondary"
            onClick={loadMoreComments}
            {...(moreCommentsFetcher.state !== "idle" ? { loading: true } : {})}
          >
            Load more
          </s-button>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
