-- ============================================================
-- Role governance: roles, account states, invitations, audit log.
--
-- Additive only. No row is deleted and no existing column is dropped.
-- Every existing staff account keeps its role and becomes `active`, so
-- everyone who can sign in today can still sign in afterwards.
--
-- Role names (the stored value is what the API and the app use):
--   SUPER_ADMIN    -> super_admin     (new)
--   ADMIN          -> admin           (new)
--   EDUCATION_TEAM -> education_team  (existing)
--   ME             -> me              (new, monitoring & evaluation)
--   FIELD_OFFICER  -> field_officer   (existing)
--   SCHOOL_HEAD    -> school_leader   (existing value kept, so every
--                                      current head of school keeps
--                                      working; shown as "School Head")
--   TEACHER        -> teacher         (existing)
--   LEARNER        -> the separate `learners` table (unchanged)
--
-- Safe to re-run.
-- ============================================================

begin;

-- ---------------------------------------------------------------- 1. roles
-- 'learner' is dropped from the staff role list: learners live in their
-- own table and no profile has ever had it (checked: 0 rows).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in (
  'super_admin', 'admin', 'education_team', 'me',
  'field_officer', 'school_leader', 'teacher'
));

-- ---------------------------------------------------------------- 2. account states
-- Added with default 'active' so every EXISTING account is active; the
-- default then becomes 'pending' for accounts created from now on
-- without an invitation.
alter table public.profiles
  add column if not exists status text not null default 'active';
alter table public.profiles alter column status set default 'pending';
alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check
  check (status in ('pending', 'active', 'suspended', 'rejected', 'deactivated'));

alter table public.profiles
  add column if not exists requested_role    text,          -- what a self-registered user asked for
  add column if not exists status_reason     text,          -- e.g. why an account was rejected or suspended
  add column if not exists status_changed_at timestamptz,
  add column if not exists status_changed_by uuid,          -- no FK: history must survive account removal
  add column if not exists approved_at       timestamptz,
  add column if not exists approved_by       uuid,
  add column if not exists invited_by        uuid;

create index if not exists profiles_status_idx on public.profiles (status);

-- ---------------------------------------------------------------- 3. staff invitations
-- The link sent to a new staff member carries a random token; only its
-- SHA-256 hash is stored, so the table never holds a usable link.
create table if not exists public.staff_invitations (
  id          text primary key,
  email       text not null,
  role        text not null check (role in (
                'super_admin', 'admin', 'education_team', 'me',
                'field_officer', 'school_leader', 'teacher')),
  county      text references public.counties(name) on update cascade on delete set null,
  school_id   text references public.schools(id) on delete set null,
  token_hash  text not null unique,
  invited_by  uuid,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at  timestamptz,
  revoked_by  uuid
);
-- At most one open invitation per email address.
create unique index if not exists staff_invitations_open_email_uidx
  on public.staff_invitations (lower(email))
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------- 4. audit log
-- Append-only record of account and learner changes, written by the API.
-- No foreign keys on purpose: an entry must outlive the account it's about.
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,          -- null for the system / this migration
  actor_kind  text not null default 'staff' check (actor_kind in ('staff', 'learner', 'system')),
  actor_role  text,
  action      text not null, -- e.g. account.approved, role.changed, learner.deleted
  target_type text not null, -- 'profile' | 'learner' | 'invitation'
  target_id   text,
  details     jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_at_idx     on public.audit_log (at desc);
create index if not exists audit_log_target_idx on public.audit_log (target_type, target_id, at desc);
create index if not exists audit_log_actor_idx  on public.audit_log (actor_id, at desc);

-- Not even the service role (which bypasses RLS) can edit or delete an entry.
create or replace function public.audit_log_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only';
end $$;
drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();
revoke all on function public.audit_log_append_only() from public, anon, authenticated;

-- ---------------------------------------------------------------- 5. lock down (same as every other table)
alter table public.staff_invitations enable row level security;
alter table public.audit_log         enable row level security;
revoke all on public.staff_invitations from anon, authenticated;
revoke all on public.audit_log         from anon, authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;

-- ---------------------------------------------------------------- 6. first Super Admin
-- Someone must hold the new top role, or nobody could approve or invite
-- anyone. The portal owner's Education Team account becomes Super Admin;
-- every other account keeps its current role. REVIEW THIS LINE.
update public.profiles
   set role = 'super_admin', status_changed_at = now()
 where email = 'patrick@humanpractice.org' and role = 'education_team';

insert into public.audit_log (actor_kind, action, target_type, target_id, details)
select 'system', 'role.changed', 'profile', id::text,
       jsonb_build_object('from', 'education_team', 'to', 'super_admin',
                          'reason', 'role governance migration: first Super Admin')
  from public.profiles
 where email = 'patrick@humanpractice.org' and role = 'super_admin'
   and not exists (select 1 from public.audit_log a
                    where a.target_id = profiles.id::text and a.action = 'role.changed'
                      and a.details->>'to' = 'super_admin');

commit;
