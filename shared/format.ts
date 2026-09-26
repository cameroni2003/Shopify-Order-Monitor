/**
 * Pure display-formatting helpers for App Home's order table. No I/O, no Shopify/Prisma types —
 * just Date/string/number in, string out, so they're trivially unit-testable.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Whole days elapsed between `from` and `now`, or null if `from` is unknown. Used for the Age
 * column and for evaluating age-rule thresholds (shared/age-rules.ts). */
export function ageInDays(from: Date | null, now: Date): number | null {
  if (from == null) return null;
  return Math.floor((now.getTime() - from.getTime()) / DAY_MS);
}

/** "3d 4h" / "4h" / "just now" — used for the Age and Last updated columns, which the plan
 * calls for in days-and-hours rather than a relative "3 days ago" phrasing. */
export function formatDaysHoursSince(from: Date | null, now: Date): string {
  if (from == null) return "—";
  const elapsedMs = Math.max(0, now.getTime() - from.getTime());
  const days = Math.floor(elapsedMs / DAY_MS);
  const hours = Math.floor((elapsedMs % DAY_MS) / HOUR_MS);
  if (days === 0 && hours === 0) return "just now";
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
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
