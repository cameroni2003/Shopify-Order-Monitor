/**
 * Pure display-formatting helpers for App Home's order table. No I/O, no Shopify/Prisma types —
 * just Date/string/number in, string out, so they're trivially unit-testable.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Whole days elapsed between `from` and `now`, or null if `from` is unknown. Used for the Age
 * column and for evaluating age-rule thresholds (shared/age-rules.ts). */
export function ageInDays(from: Date | null, now: Date): number | null {
  if (from == null) return null;
  return Math.floor((now.getTime() - from.getTime()) / DAY_MS);
}

/**
 * "just now" / "45m" / "6h" / "3d" — a single unit at a time, escalating as the gap grows
 * (minutes under an hour, hours under a day, days from then on), rather than combining units
 * (no "3d 5h"). Used for the Last updated column.
 *
 * The previous version bucketed anything under an hour as flatly "just now" regardless of
 * whether it was 1 minute or 59 — a real bug (an order updated 40 minutes ago looked identical
 * to one updated 40 seconds ago), not just a formatting preference.
 */
export function formatTimeSince(from: Date | null, now: Date): string {
  if (from == null) return "—";
  const elapsedMs = Math.max(0, now.getTime() - from.getTime());

  const minutes = Math.floor(elapsedMs / MINUTE_MS);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(elapsedMs / HOUR_MS);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(elapsedMs / DAY_MS);
  return `${days}d`;
}

/** "$84.50 USD" — Shopify's Money `amount` arrives as a decimal string; avoid float math on it. */
export function formatMoney(amount: string | null, currencyCode: string | null): string {
  if (amount == null) return "—";
  const num = Number(amount);
  const formattedAmount = Number.isFinite(num) ? num.toFixed(2) : amount;
  return currencyCode ? `${formattedAmount} ${currencyCode}` : formattedAmount;
}

/** Extracts the numeric id from a Shopify GID (e.g. "gid://shopify/Order/123" -> "123"), for
 * building admin.shopify.com/store links. Returns null if the GID doesn't match the expected
 * shape rather than guessing. */
export function numericIdFromGid(gid: string): string | null {
  const match = /\/(\d+)$/.exec(gid);
  return match ? match[1] : null;
}

/**
 * A `https://{shop}.myshopify.com/admin/orders/{id}` link. Shopify redirects this legacy-style
 * URL to the current admin domain regardless of which one the merchant actually uses, so it's a
 * safe link to build without knowing the shop's admin.shopify.com handle. Returns null if the
 * numeric id can't be extracted from the GID.
 */
export function buildAdminOrderUrl(shopDomain: string, shopifyOrderId: string): string | null {
  const numericId = numericIdFromGid(shopifyOrderId);
  return numericId ? `https://${shopDomain}/admin/orders/${numericId}` : null;
}
