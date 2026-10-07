-- Data Quality Center: a register of every data problem the portal finds,
-- what happened to each, and who did it.
--
--   dq_issues        one row per problem (a stable key, so a problem found
--                    again keeps its history and first-detected date);
--                    status OPEN → UNDER_REVIEW → RESOLVED / IGNORED.
--   dq_issue_events  the audit trail of every issue: detected, reopened,
--                    resolved, status changes and corrections (with what
--                    changed). Append-only — even the API can't edit it.
--   dq_scans         each scan's counts and quality score (the trend).
--
-- Nothing here deletes records, and no correction deletes anything either.
-- Additive only; safe to re-run.

create table if not exists public.dq_issues (
  id                text primary key,
  issue_key         text not null unique,
  type              text not null check (type in (
                      'duplicate_learner', 'duplicate_staff', 'missing_school', 'missing_county',
                      'school_county_mismatch', 'missing_grade', 'invalid_grade', 'duplicate_kobo_submission',
                      'unmatched_kobo_officer', 'missing_kobo_required', 'orphaned_record', 'invalid_date',
                      'inactive_user_active_assignment', 'learner_without_class', 'staff_without_school')),
  kind              text not null default '',
  severity          text not null check (severity in ('HIGH', 'MEDIUM', 'LOW')),
  status            text not null default 'OPEN' check (status in ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'IGNORED')),
  summary           text not null,
  entity_type       text not null,
  entity_id         text not null,
  entity_label      text not null default '',
  related           jsonb not null default '[]'::jsonb,   -- the other records involved
  school_id         text references public.schools(id) on delete set null,
  county            text,
  details           jsonb not null default '{}'::jsonb,
  first_detected_at timestamptz not null default now(),
  last_detected_at  timestamptz not null default now(),
  still_present     boolean not null default true,         -- found by the latest scan
  status_changed_at timestamptz,
  status_changed_by uuid references public.profiles(id) on delete set null,
  resolved_at       timestamptz,
  resolved_by       uuid references public.profiles(id) on delete set null,  -- null + resolved = fixed at source, seen by a scan
  resolution        text,
  note              text,
  reopened_count    int not null default 0
);
create index if not exists dq_issues_status_idx on public.dq_issues (status);
create index if not exists dq_issues_type_idx on public.dq_issues (type);
create index if not exists dq_issues_school_idx on public.dq_issues (school_id);
create index if not exists dq_issues_first_detected_idx on public.dq_issues (first_detected_at);

create table if not exists public.dq_issue_events (
  id          bigint generated always as identity primary key,
  issue_id    text not null references public.dq_issues(id) on delete restrict,
  action      text not null check (action in ('detected', 'reopened', 'auto_resolved', 'status_changed', 'corrected')),
  from_status text,
  to_status   text,
  actor_id    uuid references public.profiles(id) on delete set null,   -- null = a scan (the system)
  note        text,
  details     jsonb not null default '{}'::jsonb,                      -- for a correction: what changed, before and after
  created_at  timestamptz not null default now()
);
create index if not exists dq_issue_events_issue_idx on public.dq_issue_events (issue_id);

create or replace function public.dq_issue_events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'dq_issue_events is append-only';
end $$;
drop trigger if exists dq_issue_events_no_update on public.dq_issue_events;
create trigger dq_issue_events_no_update before update or delete on public.dq_issue_events
  for each row execute function public.dq_issue_events_append_only();
revoke all on function public.dq_issue_events_append_only() from public, anon, authenticated;

create table if not exists public.dq_scans (
  id            text primary key,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  actor_id      uuid references public.profiles(id) on delete set null,
  trigger       text not null default 'manual' check (trigger in ('manual', 'auto', 'correction')),
  found         int not null default 0,
  opened        int not null default 0,
  reopened      int not null default 0,
  auto_resolved int not null default 0,
  checked       jsonb not null default '{}'::jsonb,   -- records each check looked at, by school
  score         numeric(5,1)
);
create index if not exists dq_scans_started_idx on public.dq_scans (started_at);

alter table public.dq_issues       enable row level security;
alter table public.dq_issue_events enable row level security;
alter table public.dq_scans        enable row level security;
revoke all on public.dq_issues, public.dq_issue_events, public.dq_scans from anon, authenticated;
revoke all on sequence public.dq_issue_events_id_seq from anon, authenticated;
