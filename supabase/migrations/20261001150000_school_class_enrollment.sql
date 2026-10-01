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
