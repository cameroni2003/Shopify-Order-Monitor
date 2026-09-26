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

- Four separate pages (linked from `s-app-nav`), not tabs on one route — see "Design change:
  tabs → separate pages" below for why. Each independently paginated (keyset/cursor, 50/page):
  - **Needs attention** (`/app`) — `orderStatus = NEEDS_ATTENTION`, oldest first.
  - **Completed** (`/app/completed`) — newest first.
  - **Cancelled** (`/app/cancelled`) — newest first, "Refund pending" badge where `refundPending`.
  - **Stale (60+ days)** (`/app/stale`) — newest first, shows last-known status values.
- Columns: Order (name, links to admin), Age in days (colored per the shop's age rules), Payment
  status, Fulfillment status, Total, Items, Last updated (single-unit: minutes, then hours from
  60m, then days from 24h — `shared/format.ts::formatTimeSince`), Comments (chat icon +
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
2. **Done**: queue provider abstraction (`worker/queue/queue-provider.ts`), the AWS SQS
   implementation (`sqs-consumer` + `@aws-sdk/client-sqs`), delivery normalization with
   payload_url overflow handling (`shared/shopify-delivery.ts`), and the order-upsert write path
   (`shared/order-write-plan.ts` + `app/lib/db/orders.server.ts::applyOrderEvent`) — verified
   end-to-end against the real local Postgres (create → dedup → status transition →
   out-of-order-delivery rejection, all as designed).

   The EventBridge→SQS envelope shape (undocumented for the Events developer-preview framework)
   was confirmed against a real captured delivery: `detail.metadata` (headers, already lowercase,
   no `X-` prefix) + `detail.payload` (the Shopify body) — exactly what
   `worker/eventbridge-envelope.ts` assumed. Locked in as a permanent fixture test,
   `worker/live-payload.test.ts`.

   That same capture also caught this app not yet having Protected Customer Data access — every
   Order query came back `data.order: null` with a `GraphQL errors[].extensions.code:
   "ACCESS_DENIED"`, indistinguishable from genuine 60-day staleness to our dataMissing/STALE
   logic. `worker/index.ts` detects that specific error code and logs a loud, distinct warning
   rather than let it look like an age issue. **Resolved**: access was granted via Partner
   Dashboard → API access → Protected customer data (self-serve, immediate on a dev store), and a
   second live capture (also in `worker/live-payload.test.ts`) confirms `data.order` now comes
   back fully populated — real financial/fulfillment status, totals, everything. The full
   pipeline (EventBridge → SQS → normalize → plan → write) is confirmed working end to end
   against a live Shopify delivery, not just synthetic tests.
3. **Done**: App Home tabs + table (`app/routes/app._index.tsx`). Four URL-backed tabs (Needs
   attention/Completed/Cancelled/Stale — no native tabs component in Polaris App Home, so this
   follows shopify.dev's documented migration pattern: a segmented `s-button-group` of links,
   each a real navigable URL). Columns: Order (name + Test/Refund pending/Stale badges), Age
   (colored via the shop's age rules, highest-threshold-reached-wins), Payment, Fulfillment,
   Total, Items, Last updated, Comments (icon + count, linking to the not-yet-built order page).
   Keyset/cursor pagination via `s-table`'s built-in `paginate`/`hasPreviousPage`/`hasNextPage`,
   wired to real URLs (a comma-encoded ancestor-cursor stack in a `prev` param supports "back").
   Verified against the real local Postgres: seeded orders across all four statuses plus a
   never-seen STALE order, confirmed correct sort order, a real two-page pagination round trip,
   bulk comment counts, and age-rule color resolution, all through the exact query functions the
   loader calls.

   Also fixed along the way: `@shopify/app-bridge-types`'s global JSX augmentation (which is what
   makes `<s-app-nav>` etc. typecheck) was only ever being pulled into the program because the
   old demo `app._index.tsx` happened to import `@shopify/app-bridge-react` — nothing declared
   that dependency explicitly. Replacing that file broke `app.tsx`'s typecheck as a side effect.
   Fixed by adding `@shopify/app-bridge-types` as an explicit devDependency and registering it in
   `tsconfig.json`'s `types`, so this doesn't silently break again the next time a file with that
   import is removed.

   **Real-time updates** (added post-milestone, on request): App Home reads our own database
   (never Shopify live), so "real time" is client-side polling + React Router revalidation, not a
   websocket/SSE server — no new infra. The page revalidates its own loader every 5s while
   visible (paused via the Page Visibility API when it isn't, and caught up immediately on
   refocus), skipping any tick where a revalidation is already in flight. Originally paired with
   a small spinner as a loading indicator; removed on request (the space it reserved to avoid
   layout shift looked like an odd empty gap above the table) — polling is now silent, and the
   table updates in place with no visible indicator at all.

   **Design change: tabs → separate pages** (post-milestone, on request): the user reported the
   tab row (the `s-button-group` of `s-button href` links) wasn't visible at all. Rather than
   debug that specific component further, switched to four separate pages — `/app`,
   `/app/completed`, `/app/cancelled`, `/app/stale` — linked directly from `s-app-nav`, Settings
   last. Shared logic was factored out so nothing was duplicated four times:
   `app/lib/order-list.server.ts` (the loader logic — pagination, formatting, age-color
   resolution) and `app/components/OrderListView.tsx` (the table + polling UI). Each route file
   is now just its own status/heading/basePath plus a couple of lines wiring the two together.
   This also sidesteps whatever was wrong with the tab-switcher UI, rather than fixing it, since
   the per-page nav links (`s-link` in `s-app-nav`) were already confirmed working (Settings was
   always reachable).
4. **Done**: order detail page + comments (`app/routes/app.orders.$orderId.tsx`, reached from the
   Comments column). Header card with payment/fulfillment badges, total, items, age, last
   updated, a link to the order in the Shopify admin, and Test/Refund pending/Stale/Deleted-in-
   Shopify badges. A comment textarea posts via a fetcher (so the page doesn't reload), shows an
   App Bridge toast, and clears itself on success. Comments load newest-first, 25 at a time, with
   a "Load more" button appending further pages via a second fetcher. A cross-shop or nonexistent
   order id 404s (`findOrder` is RLS-scoped, so the two cases are indistinguishable from outside —
   docs/PLAN.md's multi-tenancy guarantee holding here too).

   Switched the app to online access tokens (`useOnlineTokens: true`) so comments can capture the
   posting staff member's name (`session.onlineAccessInfo.associated_user`) at write time. Offline
   tokens are still saved per Shopify's own docs on this setting, so the worker's needs are
   unaffected (it doesn't call the Admin API today regardless).

   Verified against the real local Postgres: cross-shop lookup correctly returns null, comment
   pagination round-trips correctly across two pages, and posting a comment for a nonexistent
   order correctly fails closed on the `OrderComment` → `Order` foreign key.
5. **Done**: settings page (`app/routes/app.settings.tsx`, linked from `s-app-nav`). Arbitrary
   number of age rules (threshold in days + a color picker), add/remove/edit freely, plus a "Show
   test orders" switch — all through the general-purpose `ShopSetting` table and validated
   `getAgeRules`/`setAgeRules`/`getShowTestOrders`/`setShowTestOrders` built in milestone 1. Uses
   App Bridge's programmatic Save Bar (`shopify.saveBar.show/hide`, an explicit `<ui-save-bar>`),
   driven by a single `hasUnsavedChanges` flag set on any row add/remove/edit, so structural
   changes (not just field edits) reliably surface the save bar.

   **Real bug caught by live-testing this against Postgres, not just unit tests**: `setSetting`
   never ensured the `Shop` row existed before writing to `ShopSetting` (which has a FK to
   `Shop`). Orders never hit this because `applyOrderEvent` always calls `ensureShop` first — but
   a merchant opening Settings before any order event has ever landed for their shop (a very
   normal thing to do right after install) would have hit a hard foreign-key-violation 500 on
   their first save. Fixed by calling `ensureShop` in `setSetting` itself, mirroring the existing
   pattern in `applyOrderEvent`. Also cleaned up: an invalid setting value used to throw a raw,
   JSON-stringified Zod error; `setSetting` now formats a short, readable message per field
   instead.
6. **Done**: uninstall handling and the three mandatory compliance webhooks.
   `webhooks.app.uninstalled.tsx` now also calls `markShopUninstalled` (data retained, per
   docs/PLAN.md — only sets `uninstalledAt`). `webhooks.customers.data_request.tsx` and
   `webhooks.customers.redact.tsx` just acknowledge, since this schema stores no customer PII
   anywhere. `webhooks.shop.redact.tsx` calls `deleteShopData` — the one deliberate exception to
   "retain forever."

   **Two idempotency bugs caught by live-testing against Postgres, not just unit tests**:
   `markShopUninstalled` used a plain `update`, which throws if the `Shop` row doesn't exist yet
   (a shop that installs and uninstalls before ever triggering an order event or visiting
   Settings would never have one) — changed to an `upsert`. `deleteShopData` used a plain
   `delete`, which throws on a second delivery of the same webhook (Shopify's delivery is
   at-least-once) or a shop that was never registered — now catches Prisma's "record not found"
   (P2025) and treats it as success rather than an error to retry. Verified live: a shop with no
   prior row at all handles both webhooks cleanly, a duplicate `shop/redact` delivery is a
   harmless no-op, and a shop with real orders/comments/settings is fully wiped (all three tables
   at zero, `Shop` row gone) by a single call.

## Status

All six milestones are done. Known, deliberate gaps — not bugs, just out of scope for this pass
(see the original conversation for the reasoning behind each):

- **Backfill** for a newly installed shop's pre-existing orders — out of scope from the start,
  planned as a separate feature on a different page later.
- **Comment editing/deleting** — implemented in `app/lib/db/comments.server.ts`, gated off by
  `COMMENT_EDITING_ENABLED=false`, no UI. Flip the flag and add buttons when wanted.
- **`read_all_orders`** hasn't been requested, so an order can go `STALE` once it crosses the
  60-day `read_orders` window rather than staying current — see "60-day order window" above.
- **The worker isn't containerized or process-supervised** — it's `bun run worker`, run manually
  in a separate terminal. Fine for local/dev use; would need a real process manager (or a second
  container/service) for anything longer-running.
- **AWS infrastructure** (partner event source, bus, rule, queue, DLQ) is managed entirely outside
  this repo, per the user's explicit instruction — the app only ever reads environment variables
  for it.
