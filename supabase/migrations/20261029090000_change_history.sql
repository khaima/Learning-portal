-- change_history (29 October 2026): every add, edit and delete of the portal's
-- records — who made it, when, and the record before and after — so the
-- Super Admin sees every change by every role, and a deleted record can be
-- put back or an edit undone (docs/RBAC.md §15).
--
-- Written by a trigger on each table, so nothing is missed: not a screen
-- whose code forgot to write an audit line, not a change made outside the
-- portal. Who made it: the API sends the signed-in person with each request
-- (x-hpf-actor-* headers, which PostgREST hands to the database as
-- request.headers). A change with no such headers was made directly in the
-- database (the SQL editor, a migration) and is recorded as that.
--
-- Never copied: PINs, password and token hashes, salts, the Kobo token and
-- secrets (any column named like them). The field's name is kept in
-- `changed`, so the history says "PIN changed" without the PIN.
--
-- Append-only, like audit_log. Writing the history can never stop the change
-- itself: a failure is a warning in the database log, and the change goes
-- ahead.

create table if not exists public.change_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  table_name  text not null,
  record_id   text,
  op          text not null check (op in ('insert', 'update', 'delete')),
  changed     text[] not null default '{}',
  old_row     jsonb,
  new_row     jsonb,
  actor_id    text,
  actor_role  text,
  actor_kind  text not null default 'database' check (actor_kind in ('staff', 'learner', 'system', 'database')),
  request_id  text,
  route       text,
  school_id   text,
  county      text
);
comment on table public.change_log is
  'Every add, edit and delete of the portal''s records: who, when, before and after (secrets left out). Append-only. Written by public.capture_change().';

create index if not exists change_log_record_idx  on public.change_log (table_name, record_id, id desc);
create index if not exists change_log_actor_idx   on public.change_log (actor_id, id desc);
create index if not exists change_log_request_idx on public.change_log (request_id) where request_id is not null;
create index if not exists change_log_deleted_idx on public.change_log (id desc) where op = 'delete';
create index if not exists change_log_place_idx   on public.change_log (school_id, id desc);
create index if not exists change_log_at_idx      on public.change_log (at desc);

create or replace function public.change_log_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'change_log is append-only';
end $$;
drop trigger if exists change_log_no_update on public.change_log;
create trigger change_log_no_update before update or delete on public.change_log
  for each row execute function public.change_log_append_only();
revoke all on function public.change_log_append_only() from public, anon, authenticated;

-- Deny-all, like every other table: only the API (service role) reads it.
alter table public.change_log enable row level security;
revoke all on public.change_log from anon, authenticated;
revoke all on sequence public.change_log_id_seq from anon, authenticated;

/* The trigger. Arguments: the record's key column(s), comma-separated, and
   the columns whose changes alone aren't worth recording (sync bookkeeping,
   autosave times), comma-separated. */
create or replace function public.capture_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  keycols text[] := string_to_array(coalesce(nullif(tg_argv[0], ''), 'id'), ',');
  noise   text[] := string_to_array(coalesce(tg_argv[1], ''), ',');
  secret  constant text := '(^pin_|_hash$|_salt$|token|secret)';
  h       jsonb;
  o       jsonb;
  n       jsonb;
  r       jsonb;
  diff    text[] := '{}';
  rec_id  text;
  sid     text;
  cty     text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    h := null;
  end;

  begin
    if tg_op <> 'INSERT' then o := to_jsonb(old); end if;
    if tg_op <> 'DELETE' then n := to_jsonb(new); end if;

    if tg_op = 'UPDATE' then
      select coalesce(array_agg(e.key order by e.key), '{}') into diff
        from jsonb_each(n) as e(key, value)
       where (o -> e.key) is distinct from e.value
         and e.key <> all (noise);
      if cardinality(diff) = 0 then
        return null; -- only bookkeeping changed
      end if;
    end if;

    r := coalesce(n, o);
    select string_agg(coalesce(r ->> u.col, ''), ':' order by u.ord) into rec_id
      from unnest(keycols) with ordinality as u(col, ord);

    -- Where it happened: its school and county, for a Programme Admin narrowed to an area.
    sid := case when tg_table_name = 'schools' then r ->> 'id' else r ->> 'school_id' end;
    if sid is null then
      begin
        if r ->> 'class_id' is not null then
          select c.school_id::text into sid from public.classes c where c.id::text = r ->> 'class_id';
        elsif r ->> 'assignment_id' is not null then
          select a.school_id::text into sid from public.assignments a where a.id::text = r ->> 'assignment_id';
        elsif r ->> 'register_id' is not null then
          select g.school_id::text into sid from public.attendance_registers g where g.id::text = r ->> 'register_id';
        elsif r ->> 'visit_id' is not null then
          select f.school_id::text into sid from public.field_reports f where f.id::text = r ->> 'visit_id';
        elsif r ->> 'training_id' is not null then
          select t.school_id::text, t.county into sid, cty from public.trainings t where t.id::text = r ->> 'training_id';
        end if;
      exception when others then
        sid := null;
      end;
    end if;
    cty := coalesce(case when tg_table_name = 'counties' then r ->> 'name' else r ->> 'county' end, cty);
    if cty is null and sid is not null then
      begin
        select s.county into cty from public.schools s where s.id::text = sid;
      exception when others then
        cty := null;
      end;
    end if;

    -- Secrets never leave their table.
    if o is not null then
      select jsonb_object_agg(e.key, e.value) into o from jsonb_each(o) as e(key, value) where e.key !~ secret;
    end if;
    if n is not null then
      select jsonb_object_agg(e.key, e.value) into n from jsonb_each(n) as e(key, value) where e.key !~ secret;
    end if;

    insert into public.change_log
      (table_name, record_id, op, changed, old_row, new_row,
       actor_id, actor_role, actor_kind, request_id, route, school_id, county)
    values
      (tg_table_name, rec_id, lower(tg_op), diff, o, n,
       nullif(h ->> 'x-hpf-actor-id', ''),
       nullif(h ->> 'x-hpf-actor-role', ''),
       case when h ->> 'x-hpf-actor-kind' in ('staff', 'learner', 'system') then h ->> 'x-hpf-actor-kind' else 'database' end,
       nullif(h ->> 'x-hpf-request-id', ''),
       nullif(left(h ->> 'x-hpf-route', 200), ''),
       sid, cty);
  exception when others then
    raise warning 'change history not recorded for % on %: %', tg_op, tg_table_name, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.capture_change() from public, anon, authenticated;

/* The tables it watches: the records people create, change and delete.
   Not watched: high-volume or machine-written tables (sign-in sessions,
   library opens, sync status, notifications, Kobo raw data, data-quality
   scans — those keep their own history), and learners' answers. Marks and
   attendance are watched for corrections (edits and deletes), not for every
   register taken or piece of work started. */
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('counties',               'name',                    '',                                   'insert or update or delete'),
      ('schools',                'id',                      '',                                   'insert or update or delete'),
      ('academic_years',         'id',                      '',                                   'insert or update or delete'),
      ('terms',                  'id',                      '',                                   'insert or update or delete'),
      ('subjects',               'id',                      '',                                   'insert or update or delete'),
      ('classes',                'id',                      '',                                   'insert or update or delete'),
      ('class_teachers',         'id',                      '',                                   'insert or update or delete'),
      ('class_subjects',         'id',                      '',                                   'insert or update or delete'),
      ('learners',               'id',                      'updated_at,failed_attempts,locked_until', 'insert or update or delete'),
      ('learner_enrollments',    'id',                      '',                                   'insert or update or delete'),
      ('assignments',            'id',                      'updated_at',                         'insert or update or delete'),
      ('assignment_questions',   'id',                      '',                                   'insert or update or delete'),
      ('assignment_submissions', 'id',                      'last_saved_at,started_at',           'update or delete'),
      ('attendance_registers',   'id',                      'client_saved_at,updated_at',         'insert or update or delete'),
      ('attendance_marks',       'register_id,learner_id',  'updated_at',                         'update or delete'),
      ('library_folders',        'id',                      '',                                   'insert or update or delete'),
      ('library_items',          'id',                      'embed_checked_at,embeddable',        'insert or update or delete'),
      ('forms',                  'id',                      '',                                   'insert or update or delete'),
      ('responses',              'id',                      '',                                   'insert or update or delete'),
      ('field_reports',          'id',                      '',                                   'insert or update or delete'),
      ('trainings',              'id',                      '',                                   'insert or update or delete'),
      ('training_attendance',    'training_id,teacher_id',  'recorded_at',                        'insert or update or delete'),
      ('profiles',               'id',                      '',                                   'insert or update or delete'),
      ('staff_scopes',           'id',                      '',                                   'insert or update or delete'),
      ('permission_grants',      'id',                      '',                                   'insert or update or delete'),
      ('staff_invitations',      'id',                      '',                                   'insert or update or delete'),
      ('kobo_config',            'id',                      'updated_at',                         'insert or update or delete'),
      ('kobo_forms',             'id',                      'synced_at,submission_count,rejected_count,unattributed_count,schema,schema_version,schema_synced_at,processed_at,last_sync_attempt_at,last_sync_error', 'insert or update or delete'),
      ('kobo_school_aliases',    'value_key',               '',                                   'insert or update or delete'),
      ('me_programmes',          'id',                      'updated_at',                         'insert or update or delete'),
      ('me_outcomes',            'id',                      '',                                   'insert or update or delete'),
      ('me_indicators',          'id',                      'updated_at',                         'insert or update or delete'),
      ('me_targets',             'id',                      '',                                   'insert or update or delete'),
      ('me_actuals',             'id',                      '',                                   'insert or update or delete'),
      ('me_evidence',            'id',                      '',                                   'insert or update or delete'),
      ('me_reports',             'id',                      '',                                   'insert or update or delete')
    ) as x(name, keys, noise, ops)
  loop
    if to_regclass('public.' || t.name) is null then
      continue;
    end if;
    execute format('drop trigger if exists change_history on public.%I', t.name);
    execute format(
      'create trigger change_history after %s on public.%I for each row execute function public.capture_change(%L, %L)',
      t.ops, t.name, t.keys, t.noise);
  end loop;
end $$;
