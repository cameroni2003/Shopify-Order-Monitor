import { z } from "zod";
import type { EventAction } from "./order-status";

/**
 * The order snapshot shape produced by the Events subscription's `query` in shopify.app.toml.
 * Field names match the GraphQL Admin API's Order object, verified against the live `unstable`
 * schema during research — see docs/PLAN.md.
 */
export interface OrderSnapshot {
  id: string;
  name: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  cancellation: unknown | null;
  cancelledAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closed: boolean | null;
  closedAt: string | null;
  test: boolean | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
  currentSubtotalLineItemsQuantity: number | null;
}

export interface FieldsChanged {
  added: string[];
  updated: string[];
  removed: string[];
}

/** The shape business logic actually consumes — never a raw SQS message or HTTP body. */
export interface NormalizedEvent {
  shopDomain: string;
  webhookId: string;
  triggeredAt: string; // ISO 8601, from the shopify-triggered-at header
  topic: string;
  action: EventAction;
  handle: string;
  orderId: string; // flat GID, from query_variables.orderId
  order: OrderSnapshot | null; // data.order; null on delete, and on a failed/stale query
  fieldsChanged: FieldsChanged;
  errors?: unknown[];
  source: "inline" | "overflow";
}

const orderSnapshotSchema: z.ZodType<OrderSnapshot> = z.object({
  id: z.string(),
  name: z.string().nullable().default(null),
  displayFinancialStatus: z.string().nullable().default(null),
  displayFulfillmentStatus: z.string().nullable().default(null),
  cancellation: z.unknown().nullable().default(null),
  cancelledAt: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  closed: z.boolean().nullable().default(null),
  closedAt: z.string().nullable().default(null),
  test: z.boolean().nullable().default(null),
  currentTotalPriceSet: z
    .object({ shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }) })
    .nullable()
    .default(null),
  currentSubtotalLineItemsQuantity: z.number().nullable().default(null),
});

const fieldsChangedSchema: z.ZodType<FieldsChanged> = z.object({
  added: z.array(z.string()),
  updated: z.array(z.string()),
  removed: z.array(z.string()),
});

const inlineBodySchema = z.object({
  topic: z.string(),
  action: z.enum(["create", "update", "delete"]),
  handle: z.string(),
  data: z
    .object({ order: orderSnapshotSchema.nullable() })
    .nullable()
    .optional(),
  fields_changed: fieldsChangedSchema,
  query_variables: z.object({ orderId: z.string() }).passthrough(),
  errors: z.array(z.unknown()).optional(),
});

const overflowPointerSchema = z.object({
  topic: z.string(),
  action: z.enum(["create", "update", "delete"]),
  handle: z.string(),
  payload_url: z.string(),
  payload_size_bytes: z.number().optional(),
  expires_at: z.string(),
});

export interface NormalizeContext {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `new Date()`. */
  now?: () => Date;
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

/**
 * Turns a raw Shopify Events delivery body + headers into a NormalizedEvent. Handles the
 * payload_url overflow case (fetch-and-merge before validating) per docs/PLAN.md. This is the
 * only place that should ever read fields_changed/query_variables/data directly — everything
 * downstream works with NormalizedEvent.
 */
export async function normalizeShopifyDelivery(
  rawBody: unknown,
  headers: Record<string, string>,
  ctx: NormalizeContext = {},
): Promise<NormalizedEvent> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const now = ctx.now ?? (() => new Date());
  const h = lowercaseHeaders(headers);

  let body: unknown = rawBody;
  let source: "inline" | "overflow" = "inline";

  const pointer = overflowPointerSchema.safeParse(rawBody);
  if (pointer.success) {
    const expiresAt = new Date(pointer.data.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now().getTime()) {
      throw new Error(
        `Overflow payload_url already expired (expires_at=${pointer.data.expires_at}) for webhook ${
          h["shopify-webhook-id"] ?? "unknown"
        }; the full delivery content is unrecoverable.`,
      );
    }
    const res = await fetchImpl(pointer.data.payload_url);
    if (!res.ok) {
      throw new Error(`Failed to fetch overflow payload_url: HTTP ${res.status} ${res.statusText}`);
    }
    const overflowBody = await res.json();
    // The pointer already has topic/action/handle; the fetched body supplies
    // fields_changed/query_variables/data, per docs/PLAN.md.
    body = { ...pointer.data, ...(overflowBody as Record<string, unknown>) };
    source = "overflow";
  }

  const parsed = inlineBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Unrecognized Shopify Events delivery body shape: ${parsed.error.message}`);
  }

  const shopDomain = h["shopify-shop-domain"];
  const webhookId = h["shopify-webhook-id"];
  const triggeredAt = h["shopify-triggered-at"];
  const missing = [
    !shopDomain && "shopify-shop-domain",
    !webhookId && "shopify-webhook-id",
    !triggeredAt && "shopify-triggered-at",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Shopify Events header(s): ${missing.join(", ")}. Got headers: ${JSON.stringify(h)}`,
    );
  }

  return {
    shopDomain,
    webhookId,
    triggeredAt,
    topic: parsed.data.topic,
    action: parsed.data.action,
    handle: parsed.data.handle,
    orderId: parsed.data.query_variables.orderId,
    order: parsed.data.data?.order ?? null,
    fieldsChanged: parsed.data.fields_changed,
    errors: parsed.data.errors,
    source,
  };
}
