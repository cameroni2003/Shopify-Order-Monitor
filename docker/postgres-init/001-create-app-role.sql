-- Creates a non-superuser application role that owns the database.
--
-- Row-level security (see the RLS migration) only restricts *non-superusers without the
-- BYPASSRLS attribute*, even with FORCE ROW LEVEL SECURITY set on a table. The default
-- `postgres` role created by the postgres image is a superuser and would silently bypass every
-- tenant-isolation policy, so the app must never connect as it. This role is what
-- DATABASE_URL should point at, for both migrations and runtime.
-- CREATEDB is granted so Prisma Migrate can create its shadow database for `migrate dev`. It
-- does not grant BYPASSRLS, so row-level security is unaffected.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN CREATEDB PASSWORD 'app';
  END IF;
END
$$;

GRANT ALL PRIVILEGES ON DATABASE order_monitor TO app;
ALTER DATABASE order_monitor OWNER TO app;
GRANT ALL ON SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app;
