-- A copy of the data before the role-based access change (docs/RBAC.md §10).
-- Every public table except live session tokens and the idempotency log is
-- copied into its own schema, locked down like the rest: RLS on, no policies,
-- nothing for the browser roles. Nothing in public is touched. Drop the
-- schema once the change has been confirmed (a person's decision, not code's).
create schema if not exists backup_20261004_rbac;
revoke all on schema backup_20261004_rbac from public, anon, authenticated;
do $$
declare t record;
begin
  for t in select tablename from pg_tables
           where schemaname = 'public' and tablename not in ('learner_sessions', 'sync_requests')
  loop
    execute format('create table if not exists backup_20261004_rbac.%I as table public.%I', t.tablename, t.tablename);
    execute format('alter table backup_20261004_rbac.%I enable row level security', t.tablename);
    execute format('revoke all on backup_20261004_rbac.%I from public, anon, authenticated', t.tablename);
  end loop;
end $$;
