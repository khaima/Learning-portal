-- The M&E layer:
--   PROGRAMME → OUTCOMES → INDICATORS → TARGETS → ACTUALS → EVIDENCE → REPORT
--
-- Indicators say where their actuals come from (validated Kobo records, a
-- portal measure, or manual entry). An actual is RECORDED as a snapshot —
-- the value and how it was worked out — then VERIFIED by someone else.
-- Re-recording keeps the old version (superseded, not overwritten).
-- Evidence hangs off each recorded actual. A report freezes the results for
-- a period; once FINAL it can't be changed or deleted (enforced here too).
-- Additive only; safe to re-run.

create table if not exists public.me_programmes (
  id          text primary key,
  code        text not null default '',
  name        text not null check (length(btrim(name)) between 1 and 200),
  description text not null default '',
  start_date  date,
  end_date    date,
  status      text not null default 'active' check (status in ('active', 'closed')),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.me_outcomes (
  id           text primary key,
  programme_id text not null references public.me_programmes(id) on delete restrict,
  code         text not null default '',
  title        text not null check (length(btrim(title)) between 1 and 300),
  description  text not null default '',
  position     int not null default 0,
  archived_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists me_outcomes_programme_idx on public.me_outcomes (programme_id);

create table if not exists public.me_indicators (
  id              text primary key,
  outcome_id      text not null references public.me_outcomes(id) on delete restrict,
  code            text not null default '',
  name            text not null check (length(btrim(name)) between 1 and 300),
  definition      text not null default '',
  unit            text not null default 'percent' check (unit in ('percent', 'count', 'number')),
  direction       text not null default 'increase' check (direction in ('increase', 'decrease')),
  source          text not null default 'manual' check (source in ('kobo', 'portal', 'manual')),
  source_config   jsonb not null default '{}'::jsonb,
  evidence_hint   text not null default '',          -- e.g. "Teacher observation form"
  baseline_value  numeric,
  baseline_period text,
  position        int not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists me_indicators_outcome_idx on public.me_indicators (outcome_id);

create table if not exists public.me_targets (
  id           text primary key,
  indicator_id text not null references public.me_indicators(id) on delete restrict,
  period       text not null,                                    -- "2026-T2" or "2026"
  scope_type   text not null check (scope_type in ('programme', 'county', 'school')),
  scope_id     text not null default '',                         -- '' · county name · school id
  target_value numeric not null,
  note         text,
  set_by       uuid references public.profiles(id) on delete set null,
  set_at       timestamptz not null default now(),
  unique (indicator_id, period, scope_type, scope_id)
);

create table if not exists public.me_actuals (
  id                text primary key,
  indicator_id      text not null references public.me_indicators(id) on delete restrict,
  period            text not null,
  scope_type        text not null check (scope_type in ('programme', 'county', 'school')),
  scope_id          text not null default '',
  value             numeric,
  numerator         numeric,
  denominator       numeric,
  n                 int,
  source            text not null check (source in ('kobo', 'portal', 'manual')),
  method            text not null default '',
  note              text,
  status            text not null default 'recorded' check (status in ('recorded', 'verified', 'rejected')),
  recorded_by       uuid references public.profiles(id) on delete set null,
  recorded_at       timestamptz not null default now(),
  verified_by       uuid references public.profiles(id) on delete set null,
  verified_at       timestamptz,
  verification_note text,
  superseded_at     timestamptz,                                  -- a newer version was recorded
  superseded_by     text references public.me_actuals(id) on delete set null
);
create unique index if not exists me_actuals_current_key
  on public.me_actuals (indicator_id, period, scope_type, scope_id) where superseded_at is null;

create table if not exists public.me_evidence (
  id           text primary key,
  actual_id    text not null references public.me_actuals(id) on delete restrict,
  kind         text not null check (kind in ('kobo_form', 'portal_data', 'file', 'link', 'note')),
  title        text not null,
  kobo_form_id text references public.kobo_forms(id) on delete set null,
  record_count int,
  url          text,
  file         jsonb,                                              -- { name, path, size }
  details      jsonb not null default '{}'::jsonb,
  added_by     uuid references public.profiles(id) on delete set null,
  added_at     timestamptz not null default now()
);
create index if not exists me_evidence_actual_idx on public.me_evidence (actual_id);

create table if not exists public.me_reports (
  id           text primary key,
  programme_id text not null references public.me_programmes(id) on delete restrict,
  period       text not null,
  scope_type   text not null check (scope_type in ('programme', 'county', 'school')),
  scope_id     text not null default '',
  title        text not null,
  status       text not null default 'draft' check (status in ('draft', 'final')),
  content      jsonb not null default '{}'::jsonb,                 -- the frozen results
  generated_by uuid references public.profiles(id) on delete set null,
  generated_at timestamptz not null default now(),
  finalized_by uuid references public.profiles(id) on delete set null,
  finalized_at timestamptz,
  note         text
);
create index if not exists me_reports_programme_idx on public.me_reports (programme_id);

-- A final report is the record of what was reported: it can't change.
create or replace function public.me_reports_final_is_final() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'final' then
    raise exception 'a final M&E report cannot be changed or deleted';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists me_reports_final_guard on public.me_reports;
create trigger me_reports_final_guard before update or delete on public.me_reports
  for each row execute function public.me_reports_final_is_final();
revoke all on function public.me_reports_final_is_final() from public, anon, authenticated;

alter table public.me_programmes enable row level security;
alter table public.me_outcomes   enable row level security;
alter table public.me_indicators enable row level security;
alter table public.me_targets    enable row level security;
alter table public.me_actuals    enable row level security;
alter table public.me_evidence   enable row level security;
alter table public.me_reports    enable row level security;
revoke all on public.me_programmes, public.me_outcomes, public.me_indicators, public.me_targets,
  public.me_actuals, public.me_evidence, public.me_reports from anon, authenticated;
