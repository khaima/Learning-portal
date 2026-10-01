-- KoboToolbox ingestion pipeline: Postgres becomes the source of truth.
--
--   Kobo ─→ API ─→ kobo_raw_submissions   (exactly what Kobo sent, kept for
--                                          audit and re-processing)
--              ─→ validation + normalization (kobo_pipeline.ts)
--              ─→ kobo_records             (one normalized row per
--                                          submission, linked to the portal's
--                                          schools, counties and officers)
--              ─→ kobo_record_issues       (every validation finding)
--              ─→ dashboards               (read kobo_records only)
--
-- Submissions arrive by the Education Team's "Sync now" (pull) or by a
-- KoboToolbox REST Service posting to /api/kobo/hook (push).
-- Survey answers can include personal data (e.g. learner names), so like
-- every table here these are reachable only through the API.
-- Additive only; safe to re-run.

-- ---------------------------------------------------------------- surveys: schema + field mapping
alter table public.kobo_forms add column if not exists schema jsonb;
alter table public.kobo_forms add column if not exists schema_version text;
alter table public.kobo_forms add column if not exists schema_synced_at timestamptz;
-- Which questions hold the school, county, officer and visit date
-- ({ school, schoolRequired, county, officer, officerRequired, date }).
alter table public.kobo_forms add column if not exists mapping jsonb;
alter table public.kobo_forms add column if not exists processed_at timestamptz;

-- The REST Service password (Basic auth). Only its SHA-256 hash is kept.
alter table public.kobo_config add column if not exists webhook_secret_hash text;
alter table public.kobo_config add column if not exists webhook_secret_set_at timestamptz;

-- ---------------------------------------------------------------- 1. raw, as received
create table if not exists public.kobo_raw_submissions (
  id                text primary key,
  kobo_form_id      text not null references public.kobo_forms(id) on delete restrict,
  kobo_id           bigint not null,              -- Kobo's _id (stays the same when edited)
  instance_id       text,                         -- meta/instanceID
  payload           jsonb not null,
  payload_hash      text not null,
  source            text not null check (source in ('sync', 'webhook')),
  kobo_submitted_at timestamptz,
  kobo_validation   text,                         -- Kobo reviewer status uid
  received_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  removed_at        timestamptz,                  -- deleted in KoboToolbox since
  unique (kobo_form_id, kobo_id)
);

-- ---------------------------------------------------------------- 2. normalized records
create table if not exists public.kobo_records (
  id            text primary key,
  raw_id        text not null unique references public.kobo_raw_submissions(id) on delete restrict,
  kobo_form_id  text not null references public.kobo_forms(id) on delete restrict,
  kobo_id       bigint not null,
  submitted_at  timestamptz,
  observed_on   date,                              -- the visit / observation date
  school_id     text references public.schools(id) on delete restrict,
  school_value  text,                              -- what the survey said, before matching
  county        text,
  officer_id    uuid references public.profiles(id) on delete restrict,
  status        text not null check (status in ('valid', 'invalid', 'duplicate', 'rejected', 'removed')),
  duplicate_of  text references public.kobo_records(id) on delete set null,
  error_count   int not null default 0,
  warning_count int not null default 0,
  answers       jsonb not null default '{}'::jsonb, -- { data path: normalized value }
  record_hash   text not null,
  processed_at  timestamptz not null default now(),
  -- A person's decision on a record the rules flagged (or one they want out).
  review        text check (review in ('accepted', 'excluded')),
  review_note   text,
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  unique (kobo_form_id, kobo_id)
);
create index if not exists kobo_records_form_status_idx on public.kobo_records (kobo_form_id, status);
create index if not exists kobo_records_school_idx on public.kobo_records (school_id);
create index if not exists kobo_records_officer_idx on public.kobo_records (officer_id);

-- ---------------------------------------------------------------- 3. validation findings
create table if not exists public.kobo_record_issues (
  id           bigint generated always as identity primary key,
  record_id    text not null references public.kobo_records(id) on delete cascade,
  kobo_form_id text not null references public.kobo_forms(id) on delete restrict,
  rule         text not null check (rule in ('required', 'type', 'school', 'county', 'officer', 'duplicate', 'date')),
  severity     text not null check (severity in ('error', 'warning')),
  field        text,
  message      text not null,
  value        text
);
create index if not exists kobo_record_issues_record_idx on public.kobo_record_issues (record_id);
create index if not exists kobo_record_issues_form_rule_idx on public.kobo_record_issues (kobo_form_id, rule);

-- ---------------------------------------------------------------- 4. school name aliases
-- "Aitong Pri." in a Kobo choice list → Aitong Primary (NRK-001). Saved once
-- by the Education Team, used for every survey from then on.
create table if not exists public.kobo_school_aliases (
  value_key  text primary key,                     -- the value, normalized (case, accents, punctuation)
  value      text not null,                        -- as it first appeared
  school_id  text not null references public.schools(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- lock down
alter table public.kobo_raw_submissions enable row level security;
alter table public.kobo_records         enable row level security;
alter table public.kobo_record_issues   enable row level security;
alter table public.kobo_school_aliases  enable row level security;
revoke all on public.kobo_raw_submissions, public.kobo_records, public.kobo_record_issues, public.kobo_school_aliases
  from anon, authenticated;
