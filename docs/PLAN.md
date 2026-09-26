# Unfulfilled Orders Monitor — plan

This is the agreed plan from the pre-implementation research/design conversation. It's the
source of truth for scope and decisions; update it if a decision changes during implementation.

## What the app does

App Home dashboard (Polaris/App Bridge, embedded) showing orders that haven't reached a fully
closed state, oldest first. Order data arrives via Shopify's Events framework, delivered to AWS
EventBridge → SQS, processed by a Node worker, and persisted to our own Postgres database. The UI
always reads our database, never Shopify's API, on every page load. Backfilling pre-existing
orders on install is out of scope — only orders that receive an event after install appear.

## Ground truth from shopify.dev (verified live during research)

- Events is developer-preview, `unstable` only. Acceptable for this learning project (explicit
  user decision — no classic-webhook fallback).
- Order topic actions: `create`, `update`, `delete`. Valid triggers used:
  `order.displayFinancialStatus`, `order.displayFulfillmentStatus`, `order.cancellation`.
  No `closed`/`closedAt` trigger exists — auto-updated timestamps aren't triggerable. Required
  scope: `read_orders` (or one of the marketplace/quick-sale variants).
- Payload: `data.order` (query result), `fields_changed: {added, updated, removed}` (dot-notation
  paths with embedded GIDs, all three arrays always present), `query_variables.orderId` (flat
  GID). `delete` events have `data.order: null`.
- Overflow: EventBridge caps deliveries at 256 KB. Above that, a thin payload arrives
  (`topic, action, handle, payload_url, payload_size_bytes, expires_at`) and the full body must be
  fetched from `payload_url` before it expires.
- Headers: `shopify-shop-domain`, `shopify-webhook-id`, `shopify-topic`, `shopify-action`,
  `shopify-handle`, `shopify-triggered-at`. `shopify-webhook-id` is used for dedup (delivery is
  at-least-once).
- **No HMAC verification for EventBridge/PubSub deliveries** — confirmed explicitly on
  shopify.dev/docs/apps/build/events/verify-deliveries: "HMAC verification applies to HTTPS
  deliveries only... Google Cloud Pub/Sub and Amazon EventBridge deliveries don't require it."
- **60-day order window**: `read_orders` can only read orders created in the last 60 days. An
  Events `query` for an order older than that can come back with `data.order: null` /
  `errors`. `read_all_orders` (Partner Dashboard approval) removes this limit but isn't requested
  for this project. Handled via the `STALE` status below instead.
- Order `closed`/`closedAt`: closing (aka archiving) is a separate concept from financial +
  fulfillment status. Auto-archive (on by default) fires when an order is paid and fulfilled, or
  fully refunded. Merchants can also archive manually or via `orderClose`, independent of any
  status field. **No event fires when only `closed` changes** (no trigger for it) — so an order
  archived by hand with no other change stays in `NEEDS_ATTENTION` until its next real status
  event. Accepted tradeoff, not a bug to chase.
- AWS EventBridge/SQS infrastructure (partner event source, bus, rule, queue, DLQ) is already
  configured by the user outside this repo. The app only needs environment variables
  (`AWS_REGION`, `SQS_QUEUE_URL`, credentials via the default AWS SDK chain).

## Decision table — order status

Evaluated top to bottom, first match wins (`shared/order-status.ts::evaluateOrderStatus`):

| # | Condition | `orderStatus` | Notes |
|---|---|---|---|
| 0 | `action = delete` | `DELETED` | Tombstone, hidden from all tabs, retained forever (comments too) |
| 1 | Order is 60+ days old and the event's `data.order` came back null/errored | `STALE` | Own tab, last-known values kept |
| 2 | `cancellation != null` or `cancelledAt != null` | `CANCELLED` | `refundPending = true` when financial status is `PAID`, `PARTIALLY_PAID`, `PARTIALLY_REFUNDED`, or `AUTHORIZED` |
| 3 | `closed = true` | `COMPLETED` | Shopify says it's closed/archived |
| 4 | `displayFinancialStatus = REFUNDED` | `COMPLETED` | Matches auto-archive's "fully refunded" |
| 5 | `displayFulfillmentStatus` in `{FULFILLED, FULFILLMENT_NOT_REQUIRED}` and `displayFinancialStatus` in `{PAID, PARTIALLY_REFUNDED}` | `COMPLETED` | Matches auto-archive's "paid and fulfilled" |
| 6 | anything else, including unrecognized enum values | `NEEDS_ATTENTION` | Default-safe: unknown stays visible |

## Multi-tenancy (shop scoping) — enforced in three layers

1. **Schema**: every tenant table's primary key starts with `shopDomain`
   (`*.myshopify.com`, validated with a regex before any query). No row is addressable by an
   order/comment/setting ID alone.
2. **Database (Postgres row-level security)**: every tenant table has
   `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` and a policy
   `USING ("shopDomain" = current_setting('app.shop_domain', true))`. The app connects as a
   non-superuser role (`app`, no `BYPASSRLS`) so `FORCE` actually applies to it. All access goes
   through `withShop(shopDomain, fn)`, which opens a transaction and does
   `SELECT set_config('app.shop_domain', $1, true)` (parameterized — no injection risk) before
   running `fn`. Forgetting a `WHERE shopDomain = …` clause returns zero rows instead of another
   shop's data, because `current_setting` defaults to unset → no match → default-deny.
   - `Session` (owned by the Shopify session-storage library, which doesn't call `withShop`) is
     intentionally **excluded** from RLS — enabling it would silently break login. Documented,
     not an oversight.
   - `Shop` itself is excluded from RLS too — it's the tenant-identity table and is always looked
     up by its own exact primary key (the shop domain), so there's no "other tenant's row" to
     leak.
3. **Code**: tenant tables are only reachable through `app/lib/db/*.server.ts`, which use
   `withShop`. An ESLint rule flags direct `db.order` / `db.orderComment` / `db.shopSetting` /
   `db.processedDelivery` access outside that directory as a guardrail (best-effort; the real
   enforcement is layer 2).

## Data model (Postgres)

- `Shop(shopDomain PK, installedAt, uninstalledAt?)`
- `Order(shopDomain, shopifyOrderId, name, financialStatus, fulfillmentStatus, isCancelled,
  cancelledAt?, refundPending, shopifyClosed, shopifyClosedAt?, isTest, totalAmount, totalCurrency,
  itemsCount, shopifyCreatedAt?, shopifyUpdatedAt?, lastTriggeredAt?, orderStatus, staleSince?,
  firstSeenAt, deletedAt?)` — PK `(shopDomain, shopifyOrderId)`, indexed on
  `(shopDomain, orderStatus, shopifyCreatedAt, shopifyOrderId)` for the main tab and
  `(shopDomain, orderStatus, shopifyUpdatedAt)` for the others.
- `OrderComment(id, shopDomain, shopifyOrderId, body, authorUserId?, authorName?, createdAt,
  editedAt?, deletedAt?, deletedByUserId?)` — edit/delete columns exist now but are inert; gated
  behind `COMMENT_EDITING_ENABLED` (currently `false`). No UI for it yet.
- `ProcessedDelivery(shopDomain, webhookId, processedAt)` — dedup log, PK
  `(shopDomain, webhookId)`, purged after 14 days (SQS's own max retention) — this is plumbing,
  not history, so it's the one thing that's actually deleted.
- `ShopSetting(shopDomain, key, value: Json, updatedAt)` — general per-shop settings table, PK
  `(shopDomain, key)`. Used for `ageRules` (color rules) and `showTestOrders`.

Orders and comments are **retained forever**, including deleted-in-Shopify orders (tombstones)
and orders that later go stale — explicit user decision, for historical purposes. The only actual
deletion path is the mandatory `shop/redact` compliance webhook, which wipes a shop's data on
Shopify's instruction (not on uninstall — uninstall only sets `uninstalledAt`).

## Queue provider (AWS SQS only for now)

- `QueueProvider` interface: `start()`, `stop()`, constructed with a
  `MessageHandler = (event: NormalizedEvent) => Promise<void>`. `createQueueProvider()` switches
  on `QUEUE_PROVIDER` (only `"aws"` valid today).
- `NormalizedEvent`: `shopDomain`, `webhookId`, `triggeredAt`, `topic`, `action`, `handle`,
  `orderId`, `order` (`data.order` or `null`), `fieldsChanged`, `errors?`,
  `source: "inline" | "overflow"`.
- Pipeline: SQS provider parses the EventBridge envelope → unwraps headers/body → shared
  `normalizeShopifyDelivery` checks for `payload_url` and fetches-and-merges overflow before
  producing a `NormalizedEvent`. Business logic never sees a raw SQS message.
- `AwsSqsProvider` uses `sqs-consumer` + `@aws-sdk/client-sqs`. A thrown handler error leaves the
  message on the queue (sqs-consumer default) for retry and eventual DLQ routing — no silent
  drops.
- Order upsert: look up by `(shopDomain, shopifyOrderId)`; dedup via `ProcessedDelivery`; guard
  out-of-order delivery by comparing `data.order.updatedAt` (falling back to
  `shopify-triggered-at`) against the stored version, skipping (but still acking) stale writes;
  merge only fields present in `data.order`; recompute `orderStatus` via `evaluateOrderStatus`;
  `delete` actions tombstone the row (`orderStatus = DELETED`, values retained).

## App Home

- Tabs, each independently paginated (keyset/cursor, 50/page):
  - **Needs attention** (main tab) — `orderStatus = NEEDS_ATTENTION`, oldest first.
  - **Completed** — newest first.
  - **Cancelled** — newest first, "Refund pending" badge where `refundPending`.
  - **Stale (60+ days)** — newest first, shows last-known status values.
- Columns: Order (name, links to admin), Age in days (colored per the shop's age rules), Payment
  status, Fulfillment status, Total, Items, Last updated (days + hours), Comments (chat icon +
  count, links to the order page).
- Row badges (not columns): Test, Refund pending, Stale since.
- Settings page: arbitrary number of age rules (`{id, thresholdDays, color}`), evaluated
  highest-threshold-reached-wins (sorted descending, first match), each with a hex color picker;
  "Show test orders" toggle (default on).
- Order detail page (`app.orders.$orderId.tsx`, opened from the comment icon): header card with
  what we know about the order (including "Deleted in Shopify" / stale badges), a comment
  textarea + post button, then comments newest-first with "Load more". Editing/deleting comments
  is implemented in the service layer and gated off by `COMMENT_EDITING_ENABLED`.
- Comment authorship uses **online access tokens** (`useOnlineTokens: true`) so `authorName` can
  be captured from the session's staff name fields at write time (baked into the row, not
  re-derived later).

## Compliance & uninstall

- `customers/data_request`, `customers/redact`, `shop/redact` declared in `[webhooks]` /
  `compliance_topics`. The app stores no customer PII, so `customers/*` handlers just acknowledge.
  `shop/redact` deletes all of that shop's rows in one transaction.
- `app/uninstalled` only sets `Shop.uninstalledAt` — data is kept in case of reinstall.

## Milestones

1. **Done**: Postgres via docker-compose, schema + migrations with RLS, shop-scoping data access
   layer, `evaluateOrderStatus` with full decision-table unit tests.
2. **Done** (with one open item — see below): queue provider abstraction
   (`worker/queue/queue-provider.ts`), the AWS SQS implementation (`sqs-consumer` +
   `@aws-sdk/client-sqs`), delivery normalization with payload_url overflow handling
   (`shared/shopify-delivery.ts`), and the order-upsert write path
   (`shared/order-write-plan.ts` + `app/lib/db/orders.server.ts::applyOrderEvent`) — verified
   end-to-end against the real local Postgres (create → dedup → status transition →
   out-of-order-delivery rejection, all as designed).

   **Open item**: the exact shape EventBridge uses to wrap an Events delivery into an SQS message
   body isn't published for the (developer-preview) Events framework specifically.
   `worker/eventbridge-envelope.ts` assumes the same `detail.metadata`/`detail.payload` wrapper
   documented for classic Shopify webhooks over EventBridge, and is written to fail with a
   diagnostic dump rather than silently misreading a message if that's wrong. `worker/scripts/
   peek-queue.ts` non-destructively inspects one real message on the queue to confirm or correct
   this — run it (`bun run worker:peek`) after triggering a real order status change, with AWS
   credentials available, and adjust `eventbridge-envelope.ts` if the real shape differs.
3. App Home tabs + table.
4. Order detail page + comments.
5. Settings page.
6. Uninstall + compliance webhooks.
