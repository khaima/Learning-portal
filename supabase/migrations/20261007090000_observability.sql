-- Production observability (docs/OPERATIONS.md).
--
-- 1. sync_events — what went wrong while a device synced: a refusal, a
--    conflict, and what the person then chose (keep mine, try again,
--    discard). sync.js sends them in batches after a sync; who and where
--    come from the session, never from the device. Append-only, like the
--    audit log (and, like it, ids are kept as plain values: a log line
--    outlives what it names).
-- 2. learner_device_sync_status — learners' devices (often shared tablets)
--    now report their queue too: one row per learner and device, with the
--    learner's school, so work handed in offline that never arrived shows.
-- 3. oldest_queued_at on both device tables — the oldest unsent activity of
--    any kind (waiting, refused or in conflict). The Education Team's "stuck
--    for 48 hours" page goes by it.
-- 4. backups — a private Storage bucket for the nightly database dumps
--    (.github/workflows/backup.yml). No policies: only the service role.
-- Additive only; safe to re-run.

-- ---------------------------------------------------------------- 1. sync events
create table if not exists public.sync_events (
  id              bigint generated always as identity primary key,
  event_key       text not null unique check (event_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  occurred_at     timestamptz not null,            -- on the device's clock
  received_at     timestamptz not null default now(),
  actor_kind      text not null check (actor_kind in ('staff', 'learner')),
  profile_id      uuid,                            -- staff
  learner_id      uuid,                            -- learners
  role            text not null,
  school_id       text,
  county          text,
  device_id       text not null check (device_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  app_version     text not null default '' check (length(app_version) <= 40),
  event           text not null check (event in ('failed', 'conflict', 'kept_mine', 'retried', 'discarded')),
  kind            text not null default '' check (length(kind) <= 40),   -- learner-work, mark, field-visit…
  method          text check (method in ('POST', 'PUT', 'PATCH', 'DELETE')),
  route           text check (length(route) <= 200),                     -- ids replaced: /assignments/:id/submit
  status          int check (status between 100 and 599),
  message         text check (length(message) <= 300),
  attempts        int not null default 0 check (attempts >= 0),
  item_created_at timestamptz
);
create index if not exists sync_events_received_idx on public.sync_events (received_at desc);
create index if not exists sync_events_device_idx on public.sync_events (device_id, received_at desc);

create or replace function public.sync_events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'sync_events is append-only';
end $$;
drop trigger if exists sync_events_no_update on public.sync_events;
create trigger sync_events_no_update before update or delete on public.sync_events
  for each row execute function public.sync_events_append_only();
revoke all on function public.sync_events_append_only() from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. learners' devices
create table if not exists public.learner_device_sync_status (
  learner_id        uuid not null references public.learners(id) on delete cascade,
  device_id         text not null check (device_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  school_id         text references public.schools(id) on delete set null,
  device_label      text not null default '' check (length(device_label) <= 120),
  app_version       text not null default '' check (length(app_version) <= 40),
  online            boolean not null default true,
  last_sync_at      timestamptz,
  pending           int not null default 0 check (pending >= 0),
  failed            int not null default 0 check (failed >= 0),
  conflicts         int not null default 0 check (conflicts >= 0),
  saved_files       int not null default 0 check (saved_files >= 0),
  oldest_pending_at timestamptz,
  oldest_queued_at  timestamptz,
  reported_at       timestamptz not null default now(),
  primary key (learner_id, device_id)
);
create index if not exists learner_device_sync_status_reported_idx on public.learner_device_sync_status (reported_at);
create index if not exists learner_device_sync_status_school_id_fk_idx on public.learner_device_sync_status (school_id);

-- ---------------------------------------------------------------- 3. the oldest unsent activity
alter table public.device_sync_status add column if not exists oldest_queued_at timestamptz;

-- ---------------------------------------------------------------- lock down (same as every other table)
alter table public.sync_events enable row level security;
alter table public.learner_device_sync_status enable row level security;
revoke all on public.sync_events from anon, authenticated;
revoke all on public.learner_device_sync_status from anon, authenticated;
revoke all on sequence public.sync_events_id_seq from anon, authenticated;

-- ---------------------------------------------------------------- 4. the backups bucket
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;
