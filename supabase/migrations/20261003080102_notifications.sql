-- Notifications: stored and auditable, not just browser alerts.
--
-- 1. notifications — what each person was told, by the rules in
--    supabase/functions/api/notifications.ts. What was said can never be
--    changed or deleted (the database refuses); the only change allowed is
--    marking it read, once. One row per person per dedupe key, so the same
--    thing is never said twice.
-- 2. notification_events — append-only history: when each was created (by
--    which run) and when it was read, by whom.
-- 3. notification_runs — every run of the rules: hourly on a schedule, when
--    someone opens their notifications, or "Run now".
-- 4. forms.due_on — a form can have a due date ("Term return is due.").
-- 5. The hourly schedule: pg_cron calls the API's /notifications/run with a
--    secret that's generated here and stays in Vault — it never appears in
--    code, logs or the browser. The API checks it with
--    notify_cron_secret_ok(), callable only with the service role.

create table if not exists public.notifications (
  id             text primary key,
  recipient_kind text not null check (recipient_kind in ('staff', 'learner')),
  recipient_id   text not null,             -- profiles.id or learners.id
  kind           text not null,
  severity       text not null default 'info' check (severity in ('info', 'action', 'warning')),
  title          text not null check (length(title) between 1 and 300),
  body           text not null default '',
  link           text,
  data           jsonb not null default '{}'::jsonb,
  dedupe_key     text not null,
  run_id         text,
  created_at     timestamptz not null default now(),
  read_at        timestamptz,
  unique (recipient_id, dedupe_key)
);
create index if not exists notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_kind_idx on public.notifications (kind, created_at desc);

create or replace function public.notifications_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Notifications are kept: they cannot be deleted';
  end if;
  if (new.id, new.recipient_kind, new.recipient_id, new.kind, new.severity, new.title, new.body, new.link, new.data, new.dedupe_key, new.run_id, new.created_at)
     is distinct from
     (old.id, old.recipient_kind, old.recipient_id, old.kind, old.severity, old.title, old.body, old.link, old.data, old.dedupe_key, old.run_id, old.created_at) then
    raise exception 'A notification cannot be changed once sent';
  end if;
  if old.read_at is not null and new.read_at is distinct from old.read_at then
    raise exception 'A notification stays read';
  end if;
  return new;
end $$;
drop trigger if exists notifications_guard on public.notifications;
create trigger notifications_guard before update or delete on public.notifications
  for each row execute function public.notifications_guard();

create table if not exists public.notification_events (
  id              bigint generated always as identity primary key,
  notification_id text not null references public.notifications(id) on delete restrict,
  action          text not null check (action in ('created', 'read')),
  actor_kind      text not null check (actor_kind in ('staff', 'learner', 'system')),
  actor_id        text,
  details         jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now()
);
create index if not exists notification_events_notification_idx on public.notification_events (notification_id);

create or replace function public.notification_events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Notification history is append-only';
end $$;
drop trigger if exists notification_events_append_only on public.notification_events;
create trigger notification_events_append_only before update or delete on public.notification_events
  for each row execute function public.notification_events_append_only();

create table if not exists public.notification_runs (
  id          text primary key,
  trigger     text not null check (trigger in ('schedule', 'user', 'manual')),
  scope       text not null default 'all',   -- 'all' or 'user:<id>'
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  created     int not null default 0,
  error       text
);
create index if not exists notification_runs_scope_idx on public.notification_runs (scope, started_at desc);

alter table public.forms add column if not exists due_on date;

alter table public.notifications       enable row level security;
alter table public.notification_events enable row level security;
alter table public.notification_runs   enable row level security;
revoke all on public.notifications, public.notification_events, public.notification_runs from anon, authenticated;

-- ---- the hourly run ----
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'notify_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'notify_cron_secret',
      'Lets the hourly notification run call the API');
  end if;
end $$;

create or replace function public.notify_cron_secret_ok(candidate text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'notify_cron_secret' and decrypted_secret = candidate);
$$;
revoke all on function public.notify_cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.notify_cron_secret_ok(text) to service_role;

-- Seven minutes past every hour. (This project's API address.)
select cron.schedule('hpf-notifications-hourly', '7 * * * *', $job$
  select net.http_post(
    url := 'https://fwpqytrdlmxymvegvgji.supabase.co/functions/v1/api/notifications/run',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);
