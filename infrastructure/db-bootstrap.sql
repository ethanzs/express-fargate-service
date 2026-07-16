-- One-time database bootstrap for IAM authentication. Idempotent — safe to
-- re-run. Run it manually as the MASTER user after the first apply (and again
-- only if the user model changes); see README.md § "Database bootstrap".
--
-- Creates the passwordless per-service users the api and hydrator
-- authenticate as with IAM tokens:
--   hydrator — owns the schema: CREATE (migrations, the drizzle schema) + DML
--   api      — DML only, incl. on tables the hydrator creates later
--
-- User names must match db_service_users in locals.tf.

-- Passwordless service users (Postgres has no CREATE USER IF NOT EXISTS).
DO $$ BEGIN CREATE USER hydrator; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE USER api; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The RDS master user isn't a superuser: it must be a member of a role to
-- manage that role's default privileges below.
GRANT hydrator TO CURRENT_USER;
GRANT api TO CURRENT_USER;

-- rds_iam flips a user to token-only auth. The role only exists on RDS; a run
-- against plain Postgres (e.g. the local compose stack) skips it with a notice.
DO $$ BEGIN
  GRANT rds_iam TO hydrator;
  GRANT rds_iam TO api;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'rds_iam role not present (not RDS?) — skipped';
END $$;

-- hydrator owns DDL (drizzle migrations also create the "drizzle" schema).
GRANT CREATE ON DATABASE app TO hydrator; -- database name matches locals.tf db_name
GRANT USAGE, CREATE ON SCHEMA public TO hydrator;

-- api: DML only — on what exists now and on whatever hydrator creates later.
GRANT USAGE ON SCHEMA public TO api;
ALTER DEFAULT PRIVILEGES FOR ROLE hydrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO api;
ALTER DEFAULT PRIVILEGES FOR ROLE hydrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
