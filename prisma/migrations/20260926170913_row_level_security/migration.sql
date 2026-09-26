-- Row-level security for the tenant tables. See docs/PLAN.md ("Multi-tenancy") and
-- app/lib/db/shop-scope.server.ts for the full rationale.
--
-- FORCE ROW LEVEL SECURITY is required in addition to ENABLE, because by default a table's
-- *owner* bypasses RLS regardless of policies. The `app` role (see
-- docker/postgres-init/001-create-app-role.sql) owns these tables and has no BYPASSRLS
-- attribute, so FORCE makes the policy apply to it too. The app must never connect as a
-- superuser (e.g. `postgres`) — superusers bypass RLS unconditionally, FORCE or not.
--
-- Each policy compares "shopDomain" against `current_setting('app.shop_domain', true)`. That
-- setting is unset outside a withShop() transaction, in which case current_setting returns NULL
-- and "shopDomain" = NULL is never true for any row — i.e. the default is deny-all, not
-- allow-all, if a caller forgets to scope the query.
--
-- Session and Shop are intentionally NOT included — see the model comments in
-- prisma/schema.prisma.

ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Order"
  USING ("shopDomain" = current_setting('app.shop_domain', true))
  WITH CHECK ("shopDomain" = current_setting('app.shop_domain', true));

ALTER TABLE "OrderComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderComment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OrderComment"
  USING ("shopDomain" = current_setting('app.shop_domain', true))
  WITH CHECK ("shopDomain" = current_setting('app.shop_domain', true));

ALTER TABLE "ProcessedDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProcessedDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProcessedDelivery"
  USING ("shopDomain" = current_setting('app.shop_domain', true))
  WITH CHECK ("shopDomain" = current_setting('app.shop_domain', true));

ALTER TABLE "ShopSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopSetting" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ShopSetting"
  USING ("shopDomain" = current_setting('app.shop_domain', true))
  WITH CHECK ("shopDomain" = current_setting('app.shop_domain', true));
