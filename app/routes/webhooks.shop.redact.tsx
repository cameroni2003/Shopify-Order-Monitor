import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteShopData } from "../lib/db/shops.server";

/**
 * Mandatory compliance webhook (docs/PLAN.md), sent ~48 hours after uninstall if the shop
 * hasn't reinstalled. This is the one deliberate exception to this app's "retain orders and
 * comments forever" policy — Shopify requires it, so it overrides that policy rather than
 * following it. deleteShopData is idempotent (a retried/duplicate delivery is a no-op, not an
 * error), since this delivery is at-least-once like any other webhook.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop} — deleting all stored data for this shop.`);
  await deleteShopData(shop);
  return new Response();
};
