import type { Prisma } from "@prisma/client";
import db from "../../db.server";

/**
 * Every tenant table (Order, OrderComment, ProcessedDelivery, ShopSetting) has a Postgres
 * row-level security policy of the form:
 *
 *   USING ("shopDomain" = current_setting('app.shop_domain', true))
 *
 * with FORCE ROW LEVEL SECURITY set, so it applies even to the table owner. withShop() is the
 * only place that sets `app.shop_domain`, and it's the only sanctioned way tenant tables should
 * be touched — see app/lib/db/README.md and the ESLint guard in .eslintrc.cjs. A query that
 * forgets a shopDomain filter still returns zero rows instead of another shop's data, because
 * `current_setting` is unset outside a withShop() transaction.
 *
 * `set_config` is used (not a string-interpolated `SET LOCAL`) so the shop domain is passed as a
 * bound parameter, not spliced into SQL text.
 */
const SHOP_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

export function assertValidShopDomain(shopDomain: string): asserts shopDomain is string {
  if (!SHOP_DOMAIN_RE.test(shopDomain)) {
    throw new Error(`Refusing to scope a query to an invalid shop domain: ${JSON.stringify(shopDomain)}`);
  }
}

export async function withShop<T>(
  shopDomain: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertValidShopDomain(shopDomain);
  return db.$transaction(async (tx) => {
    // The `true` third argument makes this a transaction-local (SET LOCAL-equivalent) setting —
    // it's automatically reset when the transaction ends, so it can never leak onto a pooled
    // connection reused by a later, differently-scoped request.
    await tx.$executeRaw`SELECT set_config('app.shop_domain', ${shopDomain}, true)`;
    return fn(tx);
  });
}
