-- Security fixes from the 25 November 2026 audit.
--
-- 1. auth_attempts: the API counts sign-up attempts and wrong learner PINs
--    per network address here, so one address can't keep guessing. Every
--    copy of the function sees the same counts. Rows older than a day are
--    cleared by the API now and then.
-- 2. The KoboToolbox API token moves out of kobo_config into Vault
--    (encrypted). Two functions, callable only with the service role, save
--    and read it; the column is left empty.
-- 3. Two things nothing uses any more are dropped, with the owner's OK
--    (both are in the nightly backup of 25 Nov 2026):
--    - the backup_20261004_rbac schema, a 4 Oct copy of personal data taken
--      before the role changes;
--    - public.assignments_legacy, empty since the LMS tables replaced it.

-- 1. -------------------------------------------------------- auth_attempts
create table if not exists public.auth_attempts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('signup', 'learner_pin')),
  address text not null,
  at_ms bigint not null
);
comment on table public.auth_attempts is
  'Sign-up attempts and wrong learner PINs per network address, for the API''s guessing limits. Kept about a day.';
create index if not exists auth_attempts_kind_address_at_idx on public.auth_attempts (kind, address, at_ms);
alter table public.auth_attempts enable row level security;
revoke all on public.auth_attempts from anon, authenticated;

-- 2. ------------------------------------------------------ Kobo token in Vault
create or replace function public.kobo_token_set(token text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  existing uuid;
begin
  select id into existing from vault.secrets where name = 'kobo_api_token';
  if existing is null then
    perform vault.create_secret(token, 'kobo_api_token', 'KoboToolbox API token, saved from the portal');
  else
    perform vault.update_secret(existing, token);
  end if;
end;
$$;

create or replace function public.kobo_token_get() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'kobo_api_token' limit 1;
$$;

revoke all on function public.kobo_token_set(text) from public, anon, authenticated;
revoke all on function public.kobo_token_get() from public, anon, authenticated;
grant execute on function public.kobo_token_set(text) to service_role;
grant execute on function public.kobo_token_get() to service_role;

-- Move the token that's there now, then empty the column.
do $$
declare
  current_token text;
begin
  select api_token into current_token from public.kobo_config where id = 1;
  if coalesce(current_token, '') <> '' then
    perform public.kobo_token_set(current_token);
    update public.kobo_config set api_token = '' where id = 1;
  end if;
end;
$$;

-- 3. ------------------------------------------------- what nothing uses
drop schema if exists backup_20261004_rbac cascade;
drop table if exists public.assignments_legacy;
