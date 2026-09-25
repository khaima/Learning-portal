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
-- The programme's counties are a fixed list; the schools in each are
-- managed by the education team and feed every County → School dropdown.
-- Each school gets a code from its county (NRK-001 = Narok's first
-- school: NRK Narok, LKP Laikipia, MRU Meru, ISL Isiolo). Everyone placed
-- in a school — teachers, heads, learners — gets a personal code under it
-- (NRK-001-T01, NRK-001-H01, NRK-001-L0001). school_code_counters only
-- ever count up, so a code someone once had is never given to anyone
-- else. A school with people in it can't be deleted (on delete restrict).
create table if not exists public.schools (
  id text primary key,
  name text not null,
  county text not null check (county in ('Narok','Laikipia','Meru','Isiolo')),
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
-- password; this table holds the app-level profile. Role is assigned at
-- onboarding (self-selected in this build — a real deployment would gate
-- it behind an admin). No email is sent: the `api` /auth/register route
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
  form_id text not null references public.forms(id) on delete cascade,
  respondent_id uuid not null references public.profiles(id) on delete cascade,
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
  teacher_id uuid not null references public.profiles(id) on delete cascade,
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
  expires_at timestamptz not null default (now() + interval '30 days')
);
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
  officer_id uuid not null references public.profiles(id) on delete cascade,
  school text not null,
  county text not null,
  visit_type text not null,
  school_id text references public.schools(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists field_reports_officer_id_idx on public.field_reports (officer_id);

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
  kobo_form_id text not null references public.kobo_forms(id) on delete cascade,
  officer_id uuid not null references public.profiles(id) on delete cascade,
  kobo_submission_id text,
  source text not null default 'sync' check (source in ('sync','manual')),
  submitted_at timestamptz not null default now(),
  primary key (kobo_form_id, officer_id)
);
create index if not exists kobo_submissions_officer_idx on public.kobo_submissions (officer_id);

-- ---------------------------------------------------------------- lock everything down
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
