import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markShopUninstalled } from "../lib/db/shops.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Orders/comments/settings are deliberately retained (not deleted) here, in case of a
  // reinstall — see docs/PLAN.md, "Compliance & uninstall". Only shop/redact (which Shopify
  // sends independently, ~48h later, only if the shop stays uninstalled) actually deletes data.
  await markShopUninstalled(shop);

  return new Response();
};
