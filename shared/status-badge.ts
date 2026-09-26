/**
 * Maps Shopify's displayFinancialStatus/displayFulfillmentStatus enum values to an s-badge tone
 * (confirmed valid tones: critical, warning, success, info — see shopify.dev's Badge component
 * docs). `null` means "use the default/neutral badge" (no tone prop), for values not in the map
 * below — including any the unstable API adds later — rather than guessing at a tone for an enum
 * value this app doesn't specifically know about yet.
 */
export type BadgeTone = "success" | "warning" | "critical" | "info";

const FINANCIAL_STATUS_TONE: Record<string, BadgeTone> = {
  PAID: "success",
  PARTIALLY_REFUNDED: "success",
  AUTHORIZED: "info",
  PARTIALLY_PAID: "warning",
  PENDING: "warning",
  REFUNDED: "info",
  VOIDED: "info",
  EXPIRED: "critical",
};

const FULFILLMENT_STATUS_TONE: Record<string, BadgeTone> = {
  FULFILLED: "success",
  FULFILLMENT_NOT_REQUIRED: "info",
  IN_PROGRESS: "info",
  SCHEDULED: "info",
  PARTIALLY_FULFILLED: "warning",
  UNFULFILLED: "warning",
  OPEN: "warning", // deprecated, replaced by UNFULFILLED
  PENDING_FULFILLMENT: "info", // deprecated, replaced by IN_PROGRESS
  RESTOCKED: "warning", // deprecated, replaced by UNFULFILLED
  ON_HOLD: "critical",
  REQUEST_DECLINED: "critical",
};

export function financialStatusTone(status: string | null): BadgeTone | null {
  return status != null ? (FINANCIAL_STATUS_TONE[status] ?? null) : null;
}

export function fulfillmentStatusTone(status: string | null): BadgeTone | null {
  return status != null ? (FULFILLMENT_STATUS_TONE[status] ?? null) : null;
}
