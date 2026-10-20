-- Class attendance: the daily register.
--
-- A teacher of a class takes its register for a school day: each learner
-- present, late, absent, or excused (an absence the school accepts, with a
-- reason). One register per class per day, one mark per learner on it.
-- Taking it again corrects it: nothing is deleted, and every change is in
-- the audit log (attendance.taken / attendance.corrected).
--
-- A register keeps its own counts, set on every save, so attendance by
-- class, grade, school and day is read from the registers alone; the
-- learners' marks are read for one class or one school.
--
-- Additive only; safe to re-run.

create table if not exists public.attendance_registers (
  id              text primary key,
  class_id        text not null references public.classes(id) on delete restrict,
  school_id       text not null references public.schools(id) on delete restrict,
  taken_on        date not null,
  present         integer not null default 0 check (present >= 0),
  late            integer not null default 0 check (late >= 0),
  absent          integer not null default 0 check (absent >= 0),
  excused         integer not null default 0 check (excused >= 0),
  taken_by        uuid references public.profiles(id) on delete set null,
  taken_at        timestamptz not null default now(),
  updated_by      uuid references public.profiles(id) on delete set null,
  updated_at      timestamptz not null default now(),
  client_saved_at timestamptz,             -- when the device saved it, if it was taken offline
  unique (class_id, taken_on)
);
create index if not exists attendance_registers_school_day_idx on public.attendance_registers (school_id, taken_on);
create index if not exists attendance_registers_day_idx on public.attendance_registers (taken_on);
create index if not exists attendance_registers_taken_by_fk_idx on public.attendance_registers (taken_by);
create index if not exists attendance_registers_updated_by_fk_idx on public.attendance_registers (updated_by);

create table if not exists public.attendance_marks (
  register_id text not null references public.attendance_registers(id) on delete restrict,
  learner_id  uuid not null references public.learners(id) on delete restrict,
  status      text not null check (status in ('present', 'late', 'absent', 'excused')),
  reason      text check (reason is null or reason in ('sick', 'family', 'permission', 'other')),
  note        text check (note is null or length(note) <= 200),
  updated_at  timestamptz not null default now(),
  primary key (register_id, learner_id),
  check (reason is null or status in ('absent', 'excused'))
);
create index if not exists attendance_marks_learner_idx on public.attendance_marks (learner_id);

comment on table public.attendance_registers is 'A class''s register for one day (attendance.ts). Corrected, never deleted; counts kept in step with its marks.';
comment on table public.attendance_marks is 'One learner''s mark on a register: present, late, absent or excused (with a reason).';

-- Deny-all: only the API (service role) reads and writes them.
alter table public.attendance_registers enable row level security;
alter table public.attendance_marks     enable row level security;
revoke all on public.attendance_registers, public.attendance_marks from anon, authenticated;
