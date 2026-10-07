-- Role-based access: data scope assignments and explicit permission grants.
-- See docs/RBAC.md. Additive only — no existing row is changed or removed,
-- no role is renamed. Safe to re-run.
--
-- 1. staff_scopes — the counties / schools a staff member's data is limited
--    to. Admin, M&E and Education Team see everything until given an
--    assignment; field officers see only what they're assigned. A county
--    covers every school in it, including schools added later. Assignments
--    are never deleted or edited: they're ended (who, when) and new ones added.
-- 2. permission_grants — one extra management permission for one person,
--    given by a Super Admin with a reason, revoked (never deleted).
-- 3. Field officers: the free-text county on each officer's profile becomes
--    a county assignment when it names a county in the list (letter case
--    ignored). One that doesn't (e.g. a town) is NOT guessed: that officer
--    has no schools until an administrator assigns them.
-- 4. Trigger functions are not callable by the browser roles.

create table if not exists public.staff_scopes (
  id          text primary key,
  profile_id  uuid not null references public.profiles(id) on delete restrict,
  scope_type  text not null check (scope_type in ('county', 'school')),
  county      text references public.counties(name) on update cascade on delete restrict,
  school_id   text references public.schools(id) on delete restrict,
  note        text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid,          -- null: this migration
  ended_at    timestamptz,
  ended_by    uuid,
  check ((scope_type = 'county' and county is not null and school_id is null)
      or (scope_type = 'school' and school_id is not null and county is null))
);
create unique index if not exists staff_scopes_open_county_uidx
  on public.staff_scopes (profile_id, county) where ended_at is null and scope_type = 'county';
create unique index if not exists staff_scopes_open_school_uidx
  on public.staff_scopes (profile_id, school_id) where ended_at is null and scope_type = 'school';
create index if not exists staff_scopes_profile_idx on public.staff_scopes (profile_id) where ended_at is null;

create or replace function public.staff_scopes_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Scope assignments are kept: end the assignment instead of deleting it';
  end if;
  -- (county may follow a county rename through the foreign key)
  if (new.id, new.profile_id, new.scope_type, new.school_id, new.note, new.created_at, new.created_by)
     is distinct from (old.id, old.profile_id, old.scope_type, old.school_id, old.note, old.created_at, old.created_by) then
    raise exception 'A scope assignment cannot be changed: end it and add a new one';
  end if;
  if old.ended_at is not null and (new.ended_at, new.ended_by) is distinct from (old.ended_at, old.ended_by) then
    raise exception 'This assignment has already ended';
  end if;
  return new;
end $$;
drop trigger if exists staff_scopes_guard on public.staff_scopes;
create trigger staff_scopes_guard before update or delete on public.staff_scopes
  for each row execute function public.staff_scopes_guard();

create table if not exists public.permission_grants (
  id            text primary key,
  profile_id    uuid not null references public.profiles(id) on delete restrict,
  permission    text not null check (permission ~ '^[a-z_]+(\.[a-z_]+)+$'),
  reason        text not null check (length(btrim(reason)) between 3 and 500),
  granted_by    uuid not null,
  granted_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_reason text
);
create unique index if not exists permission_grants_open_uidx
  on public.permission_grants (profile_id, permission) where revoked_at is null;
create index if not exists permission_grants_profile_idx on public.permission_grants (profile_id) where revoked_at is null;

create or replace function public.permission_grants_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Permission grants are kept: revoke the grant instead of deleting it';
  end if;
  if (new.id, new.profile_id, new.permission, new.reason, new.granted_by, new.granted_at)
     is distinct from (old.id, old.profile_id, old.permission, old.reason, old.granted_by, old.granted_at) then
    raise exception 'A permission grant cannot be changed: revoke it and grant again';
  end if;
  if old.revoked_at is not null and (new.revoked_at, new.revoked_by, new.revoke_reason)
     is distinct from (old.revoked_at, old.revoked_by, old.revoke_reason) then
    raise exception 'This grant has already been revoked';
  end if;
  return new;
end $$;
drop trigger if exists permission_grants_guard on public.permission_grants;
create trigger permission_grants_guard before update or delete on public.permission_grants
  for each row execute function public.permission_grants_guard();

alter table public.staff_scopes      enable row level security;
alter table public.permission_grants enable row level security;
revoke all on public.staff_scopes, public.permission_grants from anon, authenticated;

-- 3. Field officers' counties, where they name a real county.
insert into public.staff_scopes (id, profile_id, scope_type, county, note)
select 'scp_' || substr(md5(p.id::text || ':' || c.name), 1, 20), p.id, 'county', c.name,
       'From the county on their profile ("' || btrim(p.county) || '")'
from public.profiles p
join public.counties c on lower(btrim(c.name)) = lower(btrim(p.county))
where p.role = 'field_officer'
  and not exists (select 1 from public.staff_scopes s where s.profile_id = p.id)
on conflict do nothing;

insert into public.audit_log (actor_kind, action, target_type, target_id, details)
select 'system', 'scope.assigned', 'profile', s.profile_id::text,
       jsonb_build_object('county', s.county, 'source', 'county on the profile', 'migration', '20261004090000_rbac_scopes_grants')
from public.staff_scopes s
where s.created_by is null
  and not exists (select 1 from public.audit_log a
                  where a.action = 'scope.assigned' and a.target_id = s.profile_id::text
                    and a.details->>'migration' = '20261004090000_rbac_scopes_grants');

-- 4. Trigger functions: only the database calls them.
revoke all on function public.notification_events_append_only() from public, anon, authenticated;
revoke all on function public.notifications_guard() from public, anon, authenticated;
revoke all on function public.staff_scopes_guard() from public, anon, authenticated;
revoke all on function public.permission_grants_guard() from public, anon, authenticated;
