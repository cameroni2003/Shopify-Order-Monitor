/**
 * Unwraps an EventBridge event (as it arrives in an SQS message body) into headers + a Shopify
 * Events delivery body, ready for shared/shopify-delivery.ts::normalizeShopifyDelivery.
 *
 * IMPORTANT — this shape is a best-effort guess, not a documented one. shopify.dev's Events
 * (developer-preview) docs don't publish the EventBridge→SQS envelope shape. The closest
 * documented reference is for *classic* Shopify webhooks over EventBridge, which wrap the
 * delivery as `{ "detail-type": "shopifyWebhook", detail: { metadata: {...headers}, payload:
 * {...body} }, ... }` (per community/blog examples referencing `event.detail.payload` in a
 * Lambda handler). Events deliveries are assumed to follow the same wrapper. This function is
 * deliberately tolerant of a couple of shapes and throws with a diagnostic dump rather than
 * silently misreading a message — see docs/PLAN.md, milestone 2, and worker/scripts/peek-queue.ts
 * for capturing a real message to confirm or correct this against.
 */

export interface ExtractedDelivery {
  headers: Record<string, string>;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeHeaderKeys(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    out[key.toLowerCase().replace(/^x-/, "")] = value;
  }
  return out;
}

function pickShopifyKeys(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(detail)) {
    if (key.toLowerCase().includes("shopify")) out[key] = detail[key];
  }
  return out;
}

export function extractShopifyDelivery(rawMessageBody: string): ExtractedDelivery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessageBody);
  } catch (err) {
    throw new Error(`SQS message body is not valid JSON: ${(err as Error).message}`);
  }

  if (isRecord(parsed) && isRecord(parsed.detail)) {
    const detail = parsed.detail;
    if (isRecord(detail.metadata) && "payload" in detail) {
      return { headers: normalizeHeaderKeys(detail.metadata), body: detail.payload };
    }
    // No metadata/payload split — assume `detail` IS the Shopify body directly (e.g. an
    // EventBridge rule input transformer flattened it), and recover any shopify-* keys that
    // happen to be present on it. This will usually be missing shop-domain/webhook-id/
    // triggered-at, which normalizeShopifyDelivery will report clearly rather than guess at.
    return { headers: normalizeHeaderKeys(pickShopifyKeys(detail)), body: detail };
  }

  if (isRecord(parsed) && "topic" in parsed && "action" in parsed) {
    // Already-unwrapped body (e.g. a manual test message, or a rule that delivers the payload
    // as-is with headers as SQS message attributes instead — see aws-sqs-provider.ts, which
    // merges those in separately).
    return { headers: {}, body: parsed };
  }

  throw new Error(
    "Unrecognized SQS message envelope — expected an EventBridge event with a `detail` object " +
      `(or an already-unwrapped Shopify delivery body). Raw body (first 500 chars): ` +
      rawMessageBody.slice(0, 500),
  );
}
