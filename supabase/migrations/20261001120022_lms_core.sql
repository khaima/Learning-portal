-- LMS core: subjects, class subjects, assignments with questions, learner
-- submissions and answers, marking, and grade bands.
--
-- Two separate measures come out of these tables and are never mixed:
--   completion  — did the learner submit the work (and on time)?
--   achievement — the marks it earned, once marked.
--
-- The old per-learner `assignments` table (title / subject / due / done)
-- was never filled in production (0 rows). It is kept, renamed to
-- assignments_legacy, rather than dropped. Safe to re-run.

-- ---------------------------------------------------------------- 0. the old table, kept
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'assignments' and column_name = 'learner_id') then
    alter table public.assignments rename to assignments_legacy;
    alter table public.assignments_legacy rename constraint assignments_pkey to assignments_legacy_pkey;
    alter table public.assignments_legacy rename constraint assignments_learner_id_fkey to assignments_legacy_learner_id_fkey;
    alter index if exists public.assignments_learner_id_idx rename to assignments_legacy_learner_id_idx;
  end if;
end $$;

-- ---------------------------------------------------------------- 1. subjects
create table if not exists public.subjects (
  id          text primary key,              -- a slug, e.g. 'mathematics'
  name        text not null check (length(btrim(name)) between 1 and 80),
  sort_order  int  not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists subjects_name_key on public.subjects (lower(name));
insert into public.subjects (id, name, sort_order) values
  ('mathematics', 'Mathematics', 1),
  ('english', 'English', 2),
  ('kiswahili', 'Kiswahili', 3),
  ('science', 'Science', 4),
  ('social-studies', 'Social Studies', 5),
  ('religious-education', 'Religious Education', 6),
  ('creative-arts', 'Creative Arts', 7),
  ('agriculture', 'Agriculture', 8),
  ('physical-education', 'Physical and Health Education', 9)
on conflict do nothing;

-- ---------------------------------------------------------------- 2. which subjects a class takes
create table if not exists public.class_subjects (
  id         text primary key,
  class_id   text not null references public.classes(id) on delete restrict,
  subject_id text not null references public.subjects(id) on delete restrict,
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,                    -- removed, not deleted
  removed_by uuid references public.profiles(id) on delete set null
);
create unique index if not exists class_subjects_open_key
  on public.class_subjects (class_id, subject_id) where removed_at is null;

-- ---------------------------------------------------------------- 3. grade bands
-- Competency-based bands. A mark's band is the highest band whose
-- min_percent it reaches.
create table if not exists public.grade_bands (
  code        text primary key,
  label       text not null,
  min_percent numeric(5,2) not null check (min_percent between 0 and 100),
  sort_order  int not null default 0
);
insert into public.grade_bands (code, label, min_percent, sort_order) values
  ('EE', 'Exceeding Expectations', 80, 1),
  ('ME', 'Meeting Expectations', 50, 2),
  ('AE', 'Approaching Expectations', 30, 3),
  ('BE', 'Below Expectations', 0, 4)
on conflict do nothing;

-- ---------------------------------------------------------------- 4. assignments
create table if not exists public.assignments (
  id                text primary key,
  school_id         text not null references public.schools(id) on delete restrict,
  class_id          text not null references public.classes(id) on delete restrict,
  subject_id        text not null references public.subjects(id) on delete restrict,
  grade             text not null,
  academic_year_id  text not null references public.academic_years(id) on delete restrict,
  term_id           text references public.terms(id) on delete restrict,
  title             text not null check (length(btrim(title)) between 1 and 200),
  description       text not null default '',
  instructions      text not null default '',
  resource_id       text references public.library_items(id) on delete set null,
  starts_at         timestamptz,
  due_at            timestamptz,
  estimated_minutes int check (estimated_minutes is null or estimated_minutes between 1 and 1440),
  status            text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  max_marks         numeric(8,2) not null default 0 check (max_marks >= 0),
  created_by        uuid not null references public.profiles(id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  published_at      timestamptz,
  closed_at         timestamptz,
  check (due_at is null or starts_at is null or due_at > starts_at)
);
create index if not exists assignments_class_status_idx on public.assignments (class_id, status);
create index if not exists assignments_school_idx on public.assignments (school_id);
create index if not exists assignments_term_idx on public.assignments (term_id);

-- ---------------------------------------------------------------- 5. questions
-- answer_key is never sent to a learner. Its shape depends on the type:
--   multiple_choice   → index of the right option (0-based)
--   multiple_response → array of the right indices
--   true_false        → true | false
--   short_answer      → array of accepted answers (empty = teacher marks)
--   file_upload, teacher_marked → null (teacher marks)
create table if not exists public.assignment_questions (
  id            text primary key,
  assignment_id text not null references public.assignments(id) on delete cascade,
  position      int  not null,
  type          text not null check (type in (
                  'multiple_choice', 'multiple_response', 'short_answer',
                  'true_false', 'file_upload', 'teacher_marked')),
  prompt        text not null check (length(btrim(prompt)) between 1 and 2000),
  options       jsonb not null default '[]'::jsonb,
  answer_key    jsonb,
  max_marks     numeric(6,2) not null check (max_marks > 0),
  created_at    timestamptz not null default now(),
  unique (assignment_id, position)
);

-- ---------------------------------------------------------------- 6. submissions
-- One per learner per assignment. school_id / class_id record where the
-- learner was when they did the work, so a later transfer or promotion
-- never moves their results.
create table if not exists public.assignment_submissions (
  id            text primary key,
  assignment_id text not null references public.assignments(id) on delete restrict,
  learner_id    uuid not null references public.learners(id) on delete restrict,
  school_id     text not null references public.schools(id) on delete restrict,
  class_id      text not null references public.classes(id) on delete restrict,
  status        text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'marked')),
  started_at    timestamptz not null default now(),
  last_saved_at timestamptz not null default now(),
  submitted_at  timestamptz,
  is_late       boolean not null default false,
  marks         numeric(8,2),
  max_marks     numeric(8,2),
  percentage    numeric(5,2) check (percentage is null or percentage between 0 and 100),
  band          text references public.grade_bands(code),
  feedback      text,
  marked_at     timestamptz,
  marked_by     uuid references public.profiles(id) on delete set null,
  auto_marked   boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (assignment_id, learner_id),
  check (status = 'in_progress' or submitted_at is not null),
  check (status <> 'marked' or (marks is not null and percentage is not null and marked_at is not null))
);
create index if not exists assignment_submissions_learner_idx on public.assignment_submissions (learner_id);
create index if not exists assignment_submissions_class_status_idx on public.assignment_submissions (class_id, status);
create index if not exists assignment_submissions_school_idx on public.assignment_submissions (school_id);

-- ---------------------------------------------------------------- 7. answers
create table if not exists public.submission_answers (
  id            text primary key,
  submission_id text not null references public.assignment_submissions(id) on delete restrict,
  question_id   text not null references public.assignment_questions(id) on delete restrict,
  response      jsonb,
  files         jsonb not null default '[]'::jsonb,
  auto_marks    numeric(6,2),                -- set on submit for auto-marked types
  marks         numeric(6,2),                -- the teacher's mark (overrides auto_marks)
  feedback      text,
  updated_at    timestamptz not null default now(),
  unique (submission_id, question_id)
);

-- ---------------------------------------------------------------- 8. lock down
-- Like every other table: reached only through the API (service role).
alter table public.subjects               enable row level security;
alter table public.class_subjects         enable row level security;
alter table public.grade_bands            enable row level security;
alter table public.assignments            enable row level security;
alter table public.assignment_questions   enable row level security;
alter table public.assignment_submissions enable row level security;
alter table public.submission_answers     enable row level security;
revoke all on public.subjects, public.class_subjects, public.grade_bands, public.assignments,
  public.assignment_questions, public.assignment_submissions, public.submission_answers
  from anon, authenticated;
do $$
begin
  if to_regclass('public.assignments_legacy') is not null then
    execute 'alter table public.assignments_legacy enable row level security';
    execute 'revoke all on public.assignments_legacy from anon, authenticated';
  end if;
end $$;
