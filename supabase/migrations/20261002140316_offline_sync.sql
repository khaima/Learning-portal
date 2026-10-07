-- Offline work: the device queues what was done without a connection and
-- sends it when the network is back.
--
-- 1. sync_requests — makes each queued write happen once. The device sends
--    every queued activity with an Idempotency-Key; the API records the key
--    with the reply, so a retry (the first attempt arrived but its reply was
--    lost) gets the same reply back instead of doing it twice. Keys belong to
--    the account that first used them. Old keys are pruned after 30 days.
-- 2. assignment_submissions.offline_submitted_at — when a learner handed work
--    in on a device without a connection (the device's clock). submitted_at
--    stays the time the server received it; lateness goes by the offline time
--    when it's plausible.
-- Additive only; safe to re-run.

create table if not exists public.sync_requests (
  key          text primary key check (key ~ '^[A-Za-z0-9_-]{8,80}$'),
  actor_id     text not null,
  method       text not null,
  path         text not null,
  status_code  smallint,                 -- null while the first attempt is in flight
  response     jsonb,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists sync_requests_created_at_idx on public.sync_requests (created_at);

alter table public.assignment_submissions add column if not exists offline_submitted_at timestamptz;

alter table public.sync_requests enable row level security;
revoke all on public.sync_requests from anon, authenticated;
