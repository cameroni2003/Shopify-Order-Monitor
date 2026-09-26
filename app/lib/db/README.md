# `app/lib/db`

Tenant tables (`Order`, `OrderComment`, `ProcessedDelivery`, `ShopSetting`) are protected by
Postgres row-level security (see `prisma/migrations/*_row_level_security`), but RLS only helps if
every access sets `app.shop_domain` first. This directory is the only place that's allowed to
happen — everything here goes through `withShop()` from `shop-scope.server.ts`.

**Don't** import `~/db.server`'s raw Prisma client and query `order`, `orderComment`,
`shopSetting`, or `processedDelivery` directly from a route, loader, or the worker. Add a
function here instead. (`.eslintrc.cjs` has a best-effort lint rule flagging this pattern outside
this directory — the real enforcement is the RLS policy itself, the lint rule is just a
guardrail.)

`Session` and `Shop` are intentionally not shop-scoped this way — see the comments on those
models in `prisma/schema.prisma` and "Multi-tenancy" in `docs/PLAN.md`.
