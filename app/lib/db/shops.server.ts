import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { assertValidShopDomain, withShop } from "./shop-scope.server";

/**
 * The Shop table is not row-level-secured (see prisma/schema.prisma) — every function here is
 * still required to key strictly off an exact, validated shop domain, never a caller-supplied
 * filter/pattern, so there's nothing for RLS to need to catch in the first place.
 */

export async function ensureShop(shopDomain: string) {
  assertValidShopDomain(shopDomain);
  return db.shop.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: { uninstalledAt: null }, // reinstall within the retention window
  });
}

export async function markShopUninstalled(shopDomain: string) {
  assertValidShopDomain(shopDomain);
  // upsert, not update: nothing guarantees ensureShop() has run before app/uninstalled arrives
  // (e.g. a shop that installs and uninstalls before ever triggering an order event or visiting
  // Settings), so the row may not exist yet.
  return db.shop.upsert({
    where: { shopDomain },
    create: { shopDomain, uninstalledAt: new Date() },
    update: { uninstalledAt: new Date() },
  });
}

/**
 * shop/redact compliance webhook (milestone 6): permanently deletes everything for this shop.
 * This is the one place the "retain forever" policy in docs/PLAN.md is deliberately overridden,
 * because Shopify requires it. Relies on Order/OrderComment/ProcessedDelivery/ShopSetting all
 * having `onDelete: Restrict` back to Shop, so deleting Shop only succeeds after this cascade —
 * that's intentional: it forces this function to stay the single, explicit deletion path instead
 * of an implicit FK cascade doing it as a side effect of something else.
 *
 * Goes through withShop() (not a bare `db.<table>.deleteMany`) even though these are already
 * filtered by shopDomain: row-level security is FORCE-enabled on these tables, so without
 * `app.shop_domain` set, the policy's `USING` clause would match zero rows and every deleteMany
 * below would silently no-op instead of deleting anything.
 */
export async function deleteShopData(shopDomain: string) {
  assertValidShopDomain(shopDomain);
  await withShop(shopDomain, async (tx) => {
    await tx.orderComment.deleteMany({ where: { shopDomain } });
    await tx.processedDelivery.deleteMany({ where: { shopDomain } });
    await tx.shopSetting.deleteMany({ where: { shopDomain } });
    await tx.order.deleteMany({ where: { shopDomain } });
  });
  try {
    await db.shop.delete({ where: { shopDomain } });
  } catch (err) {
    // shop/redact delivery is at-least-once, and could in principle arrive for a shop that was
    // never actually registered (e.g. uninstalled before ensureShop ever ran) — either way,
    // "already gone" is success here, not an error to surface/retry.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return;
    }
    throw err;
  }
}
