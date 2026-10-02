-- Sync center: what's synced, what isn't, and why — for Kobo and school work.
--
-- 1. kobo_forms.last_sync_attempt_at / last_sync_error — every Kobo sync
--    records, per survey, when it was tried and what went wrong (if it
--    did), instead of only the server log. Errors never include the token.
-- 2. device_sync_status — each staff device reports its own sync state
--    after it syncs (what's waiting, what needs a decision, when it last
--    reached the server), so the Education Team can see a field officer's
--    phone has had visits waiting for three days. One row per account and
--    device (a random id kept on the device); nothing about the device but
--    a short label such as "Android · Chrome".
-- Additive only; safe to re-run.

alter table public.kobo_forms add column if not exists last_sync_attempt_at timestamptz;
alter table public.kobo_forms add column if not exists last_sync_error text;

create table if not exists public.device_sync_status (
  actor_id          uuid not null references public.profiles(id) on delete cascade,
  device_id         text not null check (device_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  device_label      text not null default '' check (length(device_label) <= 120),
  app_version       text not null default '' check (length(app_version) <= 40),
  online            boolean not null default true,
  last_sync_at      timestamptz,
  pending           int not null default 0 check (pending >= 0),
  failed            int not null default 0 check (failed >= 0),
  conflicts         int not null default 0 check (conflicts >= 0),
  saved_files       int not null default 0 check (saved_files >= 0),
  oldest_pending_at timestamptz,
  reported_at       timestamptz not null default now(),
  primary key (actor_id, device_id)
);
create index if not exists device_sync_status_reported_idx on public.device_sync_status (reported_at);

alter table public.device_sync_status enable row level security;
revoke all on public.device_sync_status from anon, authenticated;
