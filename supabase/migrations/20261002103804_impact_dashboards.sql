-- Impact dashboards: the data three of them need that the portal didn't keep.
--
-- 1. Gender — OPTIONAL, for learners and staff: female / male / prefer not to
--    say (left empty = not recorded). Dashboards only ever show it as totals,
--    with small numbers hidden, never per person.
-- 2. A training register — sessions and the teachers who attended — for the
--    Teacher development dashboard. Attendance is marked, never deleted.
-- 3. M&E indicators can be tagged to appear on a dashboard (e.g. "% of
--    teachers integrating ICT" on Teacher development).
-- Additive only; safe to re-run.

alter table public.learners add column if not exists gender text
  check (gender is null or gender in ('female', 'male', 'prefer_not_to_say'));
alter table public.profiles add column if not exists gender text
  check (gender is null or gender in ('female', 'male', 'prefer_not_to_say'));

create table if not exists public.trainings (
  id          text primary key,
  title       text not null check (length(btrim(title)) between 1 and 200),
  topic       text not null default '',
  kind        text not null default 'workshop' check (kind in ('workshop', 'cluster', 'coaching', 'online', 'other')),
  held_on     date not null,
  ends_on     date,
  county      text,
  school_id   text references public.schools(id) on delete restrict,
  facilitator text not null default '',
  notes       text not null default '',
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  check (ends_on is null or ends_on >= held_on)
);
create index if not exists trainings_held_on_idx on public.trainings (held_on);

create table if not exists public.training_attendance (
  training_id text not null references public.trainings(id) on delete restrict,
  teacher_id  uuid not null references public.profiles(id) on delete restrict,
  attended    boolean not null default true,       -- false = taken off the list (kept)
  recorded_by uuid references public.profiles(id) on delete set null,
  recorded_at timestamptz not null default now(),
  primary key (training_id, teacher_id)
);
create index if not exists training_attendance_teacher_idx on public.training_attendance (teacher_id);

alter table public.me_indicators add column if not exists dashboard_theme text
  check (dashboard_theme is null or dashboard_theme in ('reach', 'learning', 'teacher_development', 'field_operations', 'digital_resources'));

alter table public.trainings           enable row level security;
alter table public.training_attendance enable row level security;
revoke all on public.trainings, public.training_attendance from anon, authenticated;
