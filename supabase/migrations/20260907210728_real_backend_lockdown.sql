-- real_backend_lockdown: applied to production on 2026-09-07, before migrations were kept in
-- this folder. Its SQL is in production's migration history
-- (supabase_migrations.schema_migrations), and what it did is part of
-- supabase-schema.sql — which is how a new database is set up
-- (docs/OPERATIONS.md, "Staging"). This file keeps the version in step with
-- production, so `supabase db push` applies only the migrations after it.
select 1;
