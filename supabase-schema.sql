-- HPF Digital Learning Portal — database schema
--
-- Its own, separate Supabase project — a different system from
-- HPF-digital-portal-2026 (the production portal).
--
-- ACCESS MODEL — the database is locked down. The browser has NO direct
-- access: every table has RLS enabled with ZERO policies, and the
-- anon/authenticated roles have had all privileges revoked. The only way
-- in is the `api` Edge Function (supabase/functions/api), which:
--   * authenticates the caller — staff via a Supabase Auth JWT
--     (email + password; the function creates accounts pre-confirmed so
--     no email is ever sent), learners via a PIN-issued session token,
--   * reads their role from `public.profiles` / `public.learners`
--     (never a JWT claim),
--   * does all data access with the service-role key, which bypasses RLS.
--
-- The advisors report `rls_enabled_no_policy` (INFO) for every table —
-- that is the intended state here, not a finding to fix: these tables
-- are service-role-only by design.
--
-- Safe to re-run against a fresh project.

-- ---------------------------------------------------------------- schools & codes
-- The counties (with their 2–4 letter code prefix) and the schools in each
-- are managed by the education team and feed every County → School dropdown.
-- Each school gets a code from its county (NRK-001 = Narok's first
-- school: NRK Narok, LKP Laikipia, MRU Meru, ISL Isiolo). Everyone placed
-- in a school — teachers, heads, learners — gets a personal code under it
-- (NRK-001-T01, NRK-001-H01, NRK-001-L0001). school_code_counters only
-- ever count up, so a code someone once had is never given to anyone
-- else. A school with people in it can't be deleted (on delete restrict).
create table if not exists public.counties (
  name text primary key,
  code text not null unique check (code ~ '^[A-Z]{2,4}$'),
  created_by text not null default '',
  created_at timestamptz not null default now()
);
insert into public.counties (name, code) values
  ('Narok','NRK'), ('Laikipia','LKP'), ('Meru','MRU'), ('Isiolo','ISL')
on conflict (name) do nothing;

create table if not exists public.schools (
  id text primary key,
  name text not null,
  county text not null references public.counties(name) on update cascade on delete restrict,
  code text not null unique,
  seq int not null,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  unique (county, seq)
);
create unique index if not exists schools_county_name_uidx on public.schools (county, lower(name));

create table if not exists public.school_code_counters (
  school_id text not null references public.schools(id) on delete cascade,
  kind text not null check (kind in ('T','H','L')),
  last int not null,
  primary key (school_id, kind)
);

-- ---------------------------------------------------------------- accounts
-- Staff accounts. Supabase Auth (`auth.users`) holds the email +
-- password; this table holds the app-level profile. A new account picks
-- teacher, school_leader or field_officer at onboarding; education_team is
-- only ever granted by an existing Education Team member (the API refuses
-- it at onboarding). No email is sent: the `api` /auth/register route
-- creates the auth user already-confirmed.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('teacher','learner','school_leader','field_officer','education_team')),
  full_name text not null default '',
  email text not null default '',
  school text not null default '',
  county text not null default '',
  grade text not null default '',
  -- Kenyan teacher employment type, self-declared at onboarding. Null for
  -- non-teachers and for teachers who skipped it — the Portal impact
  -- dashboard folds unset into "Not specified" rather than guessing.
  teacher_type text check (teacher_type in ('BOM','TSC')),
  -- Teachers and heads: their school from the list + personal code. The
  -- plain school/county text above is kept in sync with the school row.
  school_id text references public.schools(id) on delete restrict,
  user_code text unique,
  created_at timestamptz not null default now()
);
create index if not exists profiles_role_idx on public.profiles (role);

-- ---------------------------------------------------------------- content library
-- Optional organizational grouping ("Grade 4 Maths", "Term 2 Science…") —
-- separate from `is_folder` below, which is about an uploaded FOLDER OF
-- FILES becoming one item. A library_folder is just a named bucket the
-- education team sorts existing/new items into; deleting a folder never
-- deletes its contents (`on delete set null` — items fall back to
-- "Unfiled"). Same 3-destination audience as items, and an item placed in
-- a folder must share the folder's audience (enforced in the API).
create table if not exists public.library_folders (
  id text primary key,
  name text not null,
  audience text not null default 'library' check (audience in ('staff','library','school_leader')),
  created_by text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.library_items (
  id text primary key,
  title text not null,
  subject text not null,
  type text not null,
  -- where this content goes:
  --   'staff'         -> Teacher Resources: teachers + head of institution only
  --   'school_leader' -> For School Head: head of institution only, not teachers
  --   'library'       -> Digital Library: for learners, also visible to
  --                      teachers + head of institution
  audience text not null default 'library' check (audience in ('staff','library','school_leader')),
  description text not null default '',
  uploaded_by text not null default '',
  uploaded_at timestamptz not null default now(),
  -- real file/folder uploads: bytes live in the private `library` Storage
  -- bucket; `files` is the manifest the API signs download URLs from —
  -- [{ "name", "path", "size" }, ...]. Metadata-only items keep files='[]'.
  file_name text,
  file_size bigint not null default 0,
  is_folder boolean not null default false,
  files jsonb not null default '[]'::jsonb,
  -- An item can point at an external site instead of an uploaded file —
  -- a YouTube video, an article, another platform's course page. Mutually
  -- exclusive with `files` in practice (the upload form offers one or the
  -- other), but nothing at the DB layer forces that.
  external_url text,
  -- Drafts default false: real the instant it's uploaded (the education
  -- team's own /library call shows drafts), but invisible to every other
  -- role until explicitly published (PATCH /library/:id).
  published boolean not null default false,
  folder_id text references public.library_folders(id) on delete set null
);
create index if not exists library_items_folder_idx on public.library_items (folder_id);

-- One row per "someone opened a resource". `completed_at`/`duration_seconds`
-- fill in only if they come back to this tab (see nav.js) — "Open to read"
-- launches a signed URL in a NEW tab, often a PDF/image/video the browser
-- renders natively, so there is no way to observe what happens in it. This
-- is an honest wall-clock proxy for engagement, not literal reading time.
create table if not exists public.library_interactions (
  id text primary key,
  library_item_id text not null references public.library_items(id) on delete cascade,
  actor_kind text not null check (actor_kind in ('staff','learner')),
  actor_id uuid not null,
  role text not null,
  full_name text not null default '',
  school text not null default '',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_seconds integer
);
create index if not exists library_interactions_item_idx on public.library_interactions (library_item_id);
create index if not exists library_interactions_actor_idx on public.library_interactions (actor_id);
create index if not exists library_interactions_school_idx on public.library_interactions (school);

-- Earned once a viewer session on one resource crosses the engagement
-- threshold (see nav.js) while still open — a real, one-time celebration
-- per resource per person, not a repeatable farm. `badge` is a slug so
-- more kinds can be added later without a schema change.
create table if not exists public.library_badges (
  id text primary key,
  library_item_id text not null references public.library_items(id) on delete cascade,
  actor_kind text not null check (actor_kind in ('staff','learner')),
  actor_id uuid not null,
  badge text not null default 'focused_reader',
  seconds_engaged integer not null default 0,
  awarded_at timestamptz not null default now(),
  unique (library_item_id, actor_id, badge)
);
create index if not exists library_badges_actor_idx on public.library_badges (actor_id);

-- ---------------------------------------------------------------- forms & responses
create table if not exists public.forms (
  id text primary key,
  title text not null,
  description text not null default '',
  audience text not null check (audience in ('teacher','school_leader','field_officer')),
  created_by text not null default '',
  created_at timestamptz not null default now(),
  questions jsonb not null default '[]'::jsonb
);

create table if not exists public.responses (
  id text primary key,
  form_id text not null references public.forms(id) on delete restrict,
  respondent_id uuid not null references public.profiles(id) on delete restrict,
  respondent_name text not null default '',
  respondent_role text not null default '',
  submitted_at timestamptz not null default now(),
  answers jsonb not null default '[]'::jsonb,
  unique (form_id, respondent_id)
);
create index if not exists responses_form_id_idx on public.responses (form_id);

-- ---------------------------------------------------------------- learners
-- Learners are children who mostly have no email. Their account is a
-- username + 4-digit PIN, created and managed by their teacher — NOT a
-- Supabase Auth user. The `api` Edge Function verifies the PIN
-- (scrypt-hashed, lockout after 5 tries) and issues an opaque session
-- token stored in learner_sessions. Deliberately low-security: this
-- gates coursework/library access, nothing sensitive.
create table if not exists public.learners (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  username text not null unique,
  pin_hash text not null,
  pin_salt text not null,
  full_name text not null default '',
  grade text not null default '',
  school text not null default '',
  county text not null default '',
  -- Always the creating teacher's school, with a personal code under it.
  school_id text references public.schools(id) on delete restrict,
  user_code text unique,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists learners_teacher_id_idx on public.learners (teacher_id);

create table if not exists public.learner_sessions (
  token text primary key,
  learner_id uuid not null references public.learners(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '12 hours')
);
-- Shared school devices: one school day, not 30 days (the API also
-- enforces this from created_at).
alter table public.learner_sessions alter column expires_at set default (now() + interval '12 hours');
create index if not exists learner_sessions_learner_id_idx on public.learner_sessions (learner_id);

-- ---------------------------------------------------------------- learner assignments
create table if not exists public.assignments (
  id text primary key,
  learner_id uuid not null references public.learners(id) on delete cascade,
  title text not null,
  subject text not null,
  due text not null default '',
  done boolean not null default false
);
create index if not exists assignments_learner_id_idx on public.assignments (learner_id);

-- ---------------------------------------------------------------- field reports
create table if not exists public.field_reports (
  id text primary key,
  officer_id uuid not null references public.profiles(id) on delete restrict,
  school text not null,
  county text not null,
  visit_type text not null,
  school_id text references public.schools(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists field_reports_officer_id_idx on public.field_reports (officer_id);
-- The visit's id from the officer's device: sending the same visit twice
-- (a retry, or the offline queue) returns the saved one, never a duplicate.
alter table public.field_reports add column if not exists client_ref text;
create unique index if not exists field_reports_client_ref_uidx on public.field_reports (client_ref) where client_ref is not null;

-- ---------------------------------------------------------------- form kinds, targeting & visit forms
-- A form is built in the portal (kind 'questions'), an uploaded file
-- ('file' — stored at library/forms/{id}/…) or a link to another site
-- ('link'). It reaches only its audience role, in one county or all
-- (county null). A field-officer form may be tied to a visit type: it
-- then appears inside every visit of that type (for schools in its
-- county) and is answered as part of the visit report, so the response
-- carries the visit and the school. General forms keep one response per
-- person; visit forms get one per visit. Filled copies of file forms
-- live at library/form-responses/{formId}/{respondentId}/….
alter table public.forms add column if not exists kind text not null default 'questions' check (kind in ('questions','file','link'));
alter table public.forms add column if not exists county text references public.counties(name) on update cascade on delete restrict;
alter table public.forms add column if not exists visit_type text;
alter table public.forms add column if not exists files jsonb not null default '[]'::jsonb;
alter table public.forms add column if not exists external_url text;
alter table public.responses add column if not exists visit_id text references public.field_reports(id) on delete restrict;
alter table public.responses add column if not exists school text not null default '';
alter table public.responses add column if not exists files jsonb not null default '[]'::jsonb;
alter table public.responses drop constraint if exists responses_form_id_respondent_id_key;
drop index if exists public.responses_form_respondent_idx;
create unique index if not exists responses_general_uidx on public.responses (form_id, respondent_id) where visit_id is null;
create unique index if not exists responses_visit_uidx on public.responses (form_id, visit_id) where visit_id is not null;
create index if not exists responses_visit_idx on public.responses (visit_id);

-- ---------------------------------------------------------------- KoboToolbox field surveys
-- The Education Team runs field surveys in KoboToolbox. They connect the
-- account once (`kobo_config`, single row) — the API token is stored here
-- server-side ONLY and is never returned to the browser. They then attach
-- a deployed survey (`kobo_forms`), which shows up on every Field Officer
-- dashboard with an "Open survey" button. That button opens Kobo's own
-- Enketo web form with the officer's profile id prefilled into a HIDDEN
-- question whose data column name is `kobo_config.officer_field`
-- (default 'officer_ref'). The submission goes straight to KoboToolbox;
-- the portal then matches it back to the officer — by polling the Kobo
-- data API (`?query={"<officer_field>":"<id>"}`) on dashboard load and on
-- the Education Team's "Sync now" — and records it in `kobo_submissions`.
-- A manual "I've submitted this" button is the fallback (source 'manual').
--
-- The Education Team dashboard also reads live aggregated results
-- (GET /api/kobo/forms/:id/results): the API pulls the survey schema +
-- every submission from KoboToolbox on demand and tallies each question
-- into chart data. Nothing is stored here — kobo_submissions only tracks
-- who has responded, not the answers.
create table if not exists public.kobo_config (
  id int primary key default 1 check (id = 1),
  base_url text not null default 'https://eu.kobotoolbox.org',
  api_token text not null,                 -- server-side only, never returned
  officer_field text not null default 'officer_ref',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.kobo_forms (
  id text primary key,                     -- kb_<rand>
  asset_uid text not null unique,
  title text not null default '',
  enketo_url text,                          -- deployment offline/main link
  active boolean not null default true,
  submission_count int not null default 0,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  synced_at timestamptz
);

create table if not exists public.kobo_submissions (
  kobo_form_id text not null references public.kobo_forms(id) on delete restrict,
  officer_id uuid not null references public.profiles(id) on delete restrict,
  kobo_submission_id text,
  source text not null default 'sync' check (source in ('sync','manual')),
  submitted_at timestamptz not null default now(),
  primary key (kobo_form_id, officer_id)
);
create index if not exists kobo_submissions_officer_idx on public.kobo_submissions (officer_id);

-- ---------------------------------------------------------------- keep history
-- Responses, field visits, learners and Kobo submission records are
-- programme history, so nothing deletes them as a side effect any more:
--   * a form with responses is archived (archived_at), not deleted — it
--     stops reaching anyone but keeps every response;
--   * a Kobo survey is archived with kobo_forms.active = false;
--   * the links below are ON DELETE RESTRICT, so deleting a form, a visit
--     or a staff account (including from the Supabase dashboard, which
--     cascades auth.users -> profiles) is refused while records still
--     point at it.
alter table public.forms add column if not exists archived_at timestamptz;

do $$
declare r record;
begin
  for r in select * from (values
    ('responses',        'responses_form_id_fkey',             'form_id',      'public.forms(id)'),
    ('responses',        'responses_respondent_id_fkey',       'respondent_id','public.profiles(id)'),
    ('responses',        'responses_visit_id_fkey',            'visit_id',     'public.field_reports(id)'),
    ('field_reports',    'field_reports_officer_id_fkey',      'officer_id',   'public.profiles(id)'),
    ('learners',         'learners_teacher_id_fkey',           'teacher_id',   'public.profiles(id)'),
    ('kobo_submissions', 'kobo_submissions_kobo_form_id_fkey', 'kobo_form_id', 'public.kobo_forms(id)'),
    ('kobo_submissions', 'kobo_submissions_officer_id_fkey',   'officer_id',   'public.profiles(id)')
  ) as t(tbl, con, col, ref)
  loop
    execute format('alter table public.%I drop constraint if exists %I', r.tbl, r.con);
    execute format('alter table public.%I add constraint %I foreign key (%I) references %s on delete restrict',
                   r.tbl, r.con, r.col, r.ref);
  end loop;
end $$;

-- ---------------------------------------------------------------- lock everything down
alter table public.counties         enable row level security;
alter table public.schools          enable row level security;
alter table public.school_code_counters enable row level security;
alter table public.profiles         enable row level security;
alter table public.learners         enable row level security;
alter table public.learner_sessions enable row level security;
alter table public.library_folders  enable row level security;
alter table public.library_items    enable row level security;
alter table public.library_interactions enable row level security;
alter table public.library_badges   enable row level security;
alter table public.forms            enable row level security;
alter table public.responses        enable row level security;
alter table public.assignments      enable row level security;
alter table public.field_reports    enable row level security;
alter table public.kobo_config      enable row level security;
alter table public.kobo_forms       enable row level security;
alter table public.kobo_submissions enable row level security;
-- No policies on purpose. Only the service-role key (the Edge Function)
-- reaches these tables.

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all routines  in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- ---------------------------------------------------------------- storage
-- Content-library files. PRIVATE bucket: the API issues short-lived
-- signed upload URLs (education team) and signed download URLs (everyone
-- who may see the item). No object-level policies — service-role only.
insert into storage.buckets (id, name, public, file_size_limit)
values ('library', 'library', false, 52428800)  -- 50 MB per file
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- No seed data. The first real account is created by signing in with a
-- magic link and completing onboarding.

-- ---------------------------------------------------------------- role governance
-- Roles, account states, staff invitations and the audit log. Also shipped
-- as supabase/migrations/20261001120000_role_governance.sql for existing
-- databases; repeated here so a fresh install matches. Safe to re-run.
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

-- ---------------------------------------------------------------- school / class enrollment
-- School -> academic year -> term -> class -> teacher assignment -> learner
-- enrollment. Also shipped as
-- supabase/migrations/20261001150000_school_class_enrollment.sql for existing
-- databases; repeated here so a fresh install matches. Safe to re-run.
-- ============================================================
-- Learners move from "owned by the teacher who created them" to
-- school- and class-based management:
--
--   school → academic year → term → class → class teachers
--          → learner enrollments (history) → learner (current state)
--
-- Additive only: no row is deleted, no column is dropped. Every existing
-- learner keeps its id, sign-in, school, code, assignments and library
-- history, and gets an ACTIVE enrollment for the current year/term. Their
-- creating teacher stays linked (learners.teacher_id), so every teacher
-- still sees exactly the learners they see today until classes are set up.
--
-- Learners are never hard-deleted any more: leaving is an enrollment
-- status (TRANSFERRED, DROPPED_OUT, COMPLETED, INACTIVE) with a date and
-- reason, and every enrollment is kept as history.
--
-- Safe to re-run.
-- ============================================================

-- ---------------------------------------------------------------- 1. academic calendar
-- One national calendar for all schools. Term dates follow the rule the
-- portal already uses everywhere (Jan–Apr, May–Aug, Sep–Dec); an
-- administrator can change them later.
create table if not exists public.academic_years (
  id          text primary key check (id ~ '^[0-9]{4}$'),
  label       text not null,
  starts_on   date not null,
  ends_on     date not null,
  is_current  boolean not null default false,
  created_at  timestamptz not null default now(),
  check (ends_on > starts_on)
);
create unique index if not exists academic_years_one_current on public.academic_years ((true)) where is_current;

create table if not exists public.terms (
  id                text primary key,            -- e.g. 2026-T3
  academic_year_id  text not null references public.academic_years(id) on delete restrict,
  term_no           int  not null check (term_no between 1 and 3),
  starts_on         date not null,
  ends_on           date not null,
  unique (academic_year_id, term_no),
  check (ends_on > starts_on)
);

insert into public.academic_years (id, label, starts_on, ends_on, is_current)
values ('2026', '2026', '2026-01-01', '2026-12-31', true)
on conflict (id) do nothing;
insert into public.terms (id, academic_year_id, term_no, starts_on, ends_on) values
  ('2026-T1', '2026', 1, '2026-01-01', '2026-04-30'),
  ('2026-T2', '2026', 2, '2026-05-01', '2026-08-31'),
  ('2026-T3', '2026', 3, '2026-09-01', '2026-12-31')
on conflict (id) do nothing;

-- ---------------------------------------------------------------- 2. classes
-- A class belongs to one school and one academic year, at one grade.
-- Classes are archived, never deleted.
create table if not exists public.classes (
  id                text primary key,
  school_id         text not null references public.schools(id) on delete restrict,
  academic_year_id  text not null references public.academic_years(id) on delete restrict,
  grade             text not null check (grade in (
                      'PP1', 'PP2', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
                      'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12')),
  name              text not null,               -- e.g. "Grade 4 East"
  created_by        uuid,
  created_at        timestamptz not null default now(),
  archived_at       timestamptz,
  archived_by       uuid
);
create unique index if not exists classes_name_uidx
  on public.classes (school_id, academic_year_id, lower(name)) where archived_at is null;
create index if not exists classes_school_idx on public.classes (school_id, academic_year_id);

-- ---------------------------------------------------------------- 3. class teachers
-- Who teaches a class. Ending an assignment sets ended_at; rows are kept.
create table if not exists public.class_teachers (
  id           text primary key,
  class_id     text not null references public.classes(id) on delete restrict,
  teacher_id   uuid not null references public.profiles(id) on delete restrict,
  role         text not null default 'class_teacher' check (role in ('class_teacher', 'subject_teacher')),
  assigned_at  timestamptz not null default now(),
  assigned_by  uuid,
  ended_at     timestamptz,
  ended_by     uuid
);
create unique index if not exists class_teachers_open_uidx
  on public.class_teachers (class_id, teacher_id) where ended_at is null;
-- At most one current class teacher per class.
create unique index if not exists class_teachers_one_class_teacher_uidx
  on public.class_teachers (class_id) where ended_at is null and role = 'class_teacher';
create index if not exists class_teachers_teacher_idx on public.class_teachers (teacher_id) where ended_at is null;

-- ---------------------------------------------------------------- 4. learners: current state
-- teacher_id becomes optional: it now means "the teacher who first added
-- this learner" (and keeps today's rosters working); a class decides who
-- teaches a learner from here on.
alter table public.learners alter column teacher_id drop not null;

alter table public.learners
  add column if not exists learner_code        text,     -- permanent; survives transfers (user_code is school-coded and changes)
  add column if not exists class_id            text references public.classes(id) on delete restrict,
  add column if not exists current_teacher_id  uuid references public.profiles(id) on delete restrict,
  add column if not exists academic_year_id    text references public.academic_years(id) on delete restrict,
  add column if not exists term_id             text references public.terms(id) on delete restrict,
  add column if not exists enrollment_status   text not null default 'ACTIVE',
  add column if not exists enrollment_date     date,
  add column if not exists exit_date           date,
  add column if not exists exit_reason         text,
  add column if not exists updated_at          timestamptz not null default now();

alter table public.learners drop constraint if exists learners_enrollment_status_check;
alter table public.learners add constraint learners_enrollment_status_check
  check (enrollment_status in ('ACTIVE', 'TRANSFERRED', 'DROPPED_OUT', 'COMPLETED', 'INACTIVE'));
create unique index if not exists learners_learner_code_uidx on public.learners (learner_code) where learner_code is not null;
create index if not exists learners_school_status_idx on public.learners (school_id, enrollment_status);
create index if not exists learners_class_idx on public.learners (class_id);

-- Existing learners: their current school code becomes their permanent
-- learner code; their creating teacher is their current teacher; they're
-- enrolled in the current year and the term they joined in.
update public.learners l set
  learner_code       = coalesce(l.learner_code, l.user_code),
  current_teacher_id = coalesce(l.current_teacher_id, l.teacher_id),
  academic_year_id   = coalesce(l.academic_year_id, '2026'),
  term_id            = coalesce(l.term_id, (
                         select t.id from public.terms t
                          where t.academic_year_id = '2026'
                            and l.created_at::date between t.starts_on and t.ends_on
                          limit 1), '2026-T3'),
  enrollment_date    = coalesce(l.enrollment_date, l.created_at::date);

-- ---------------------------------------------------------------- 5. enrollment history
-- One row per period a learner spent in a school (and class). The ACTIVE
-- row is the current one; every closed row stays, with how and why it
-- ended — which is what "transferred learners keep their history" means.
create table if not exists public.learner_enrollments (
  id                text primary key,
  learner_id        uuid not null references public.learners(id) on delete restrict,
  school_id         text not null references public.schools(id) on delete restrict,
  class_id          text references public.classes(id) on delete restrict,
  academic_year_id  text not null references public.academic_years(id) on delete restrict,
  term_id           text references public.terms(id) on delete restrict,
  grade             text not null default '',
  teacher_id        uuid,                         -- the learner's teacher at the time
  status            text not null default 'ACTIVE'
                    check (status in ('ACTIVE', 'TRANSFERRED', 'DROPPED_OUT', 'COMPLETED', 'INACTIVE')),
  enrollment_date   date not null default current_date,
  exit_date         date,
  exit_reason       text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  closed_by         uuid,
  closed_at         timestamptz,
  check (status = 'ACTIVE' or exit_date is not null)
);
create unique index if not exists learner_enrollments_one_active_uidx
  on public.learner_enrollments (learner_id) where status = 'ACTIVE';
create index if not exists learner_enrollments_learner_idx on public.learner_enrollments (learner_id, enrollment_date desc);
create index if not exists learner_enrollments_school_idx  on public.learner_enrollments (school_id, status);
create index if not exists learner_enrollments_class_idx   on public.learner_enrollments (class_id);

insert into public.learner_enrollments
  (id, learner_id, school_id, class_id, academic_year_id, term_id, grade, teacher_id, status, enrollment_date)
select 'enr_' || substr(md5(l.id::text), 1, 12), l.id, l.school_id, null, l.academic_year_id, l.term_id,
       l.grade, l.teacher_id, 'ACTIVE', l.enrollment_date
  from public.learners l
 where l.school_id is not null
   and not exists (select 1 from public.learner_enrollments e where e.learner_id = l.id);

-- ---------------------------------------------------------------- 6. never hard-delete a learner
-- Deleting a learner used to remove their sessions and assignments with
-- them. Nothing in the app deletes learners any more; these make the
-- database refuse it too.
alter table public.assignments drop constraint if exists assignments_learner_id_fkey;
alter table public.assignments add constraint assignments_learner_id_fkey
  foreign key (learner_id) references public.learners(id) on delete restrict;

-- ---------------------------------------------------------------- 7. lock down (same as every other table)
alter table public.academic_years      enable row level security;
alter table public.terms               enable row level security;
alter table public.classes             enable row level security;
alter table public.class_teachers      enable row level security;
alter table public.learner_enrollments enable row level security;
revoke all on public.academic_years, public.terms, public.classes, public.class_teachers,
              public.learner_enrollments from anon, authenticated;
