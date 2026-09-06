-- HPF Digital Learning Portal — database schema
--
-- Applied to the same Supabase project as HPF-digital-portal-2026 (the
-- only one on this account), but everything below lives in its own
-- `learning_portal` schema — never `public`, where the production
-- portal's real tables live. Nothing here references, joins, or shares
-- data with that schema; nothing there can see this.
--
-- Security posture is deliberately the same as the app's original
-- localStorage version: open to the anon key, no real Supabase Auth.
-- This is a demo/prototype, not a place for real people's data — see
-- README.md, "Security posture". A real deployment needs real Supabase
-- Auth and RLS scoped to auth.uid(), not this.
--
-- Safe to re-run against a fresh project: every statement is
-- create-if-not-exists or on-conflict-do-nothing.

create schema if not exists learning_portal;

create table if not exists learning_portal.users (
  id text primary key,
  role text not null check (role in ('teacher','learner','school_leader','field_officer','education_team')),
  username text not null unique,
  password text not null,
  full_name text not null,
  school text not null default '',
  county text not null default '',
  grade text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists learning_portal.library_items (
  id text primary key,
  title text not null,
  subject text not null,
  type text not null,
  -- who this shows up for: the Teacher library, the Learner library, or both.
  audience text not null default 'both' check (audience in ('teacher','learner','both')),
  description text not null default '',
  uploaded_by text not null default '',
  uploaded_at timestamptz not null default now()
);

create table if not exists learning_portal.forms (
  id text primary key,
  title text not null,
  description text not null default '',
  audience text not null check (audience in ('teacher','school_leader','field_officer')),
  created_by text not null default '',
  created_at timestamptz not null default now(),
  questions jsonb not null default '[]'::jsonb
);

create table if not exists learning_portal.responses (
  id text primary key,
  form_id text not null references learning_portal.forms(id) on delete cascade,
  respondent_id text not null references learning_portal.users(id) on delete cascade,
  respondent_name text not null,
  respondent_role text not null,
  submitted_at timestamptz not null default now(),
  answers jsonb not null default '[]'::jsonb,
  unique (form_id, respondent_id)
);

create table if not exists learning_portal.assignments (
  id text primary key,
  learner_id text not null references learning_portal.users(id) on delete cascade,
  title text not null,
  subject text not null,
  due text not null default '',
  done boolean not null default false
);

create table if not exists learning_portal.field_reports (
  id text primary key,
  officer_id text not null references learning_portal.users(id) on delete cascade,
  school text not null,
  county text not null,
  visit_type text not null,
  created_at timestamptz not null default now()
);

-- Additive fixups for a database that already had these tables before
-- `audience` existed on library_items, or before field_officer was a
-- valid form audience — safe to re-run, a no-op once applied.
alter table learning_portal.library_items
  add column if not exists audience text not null default 'both'
  check (audience in ('teacher', 'learner', 'both'));
alter table learning_portal.forms drop constraint if exists forms_audience_check;
alter table learning_portal.forms add constraint forms_audience_check
  check (audience in ('teacher', 'school_leader', 'field_officer'));

create index if not exists responses_form_id_idx on learning_portal.responses (form_id);
create index if not exists assignments_learner_id_idx on learning_portal.assignments (learner_id);
create index if not exists field_reports_officer_id_idx on learning_portal.field_reports (officer_id);

alter table learning_portal.users enable row level security;
alter table learning_portal.library_items enable row level security;
alter table learning_portal.forms enable row level security;
alter table learning_portal.responses enable row level security;
alter table learning_portal.assignments enable row level security;
alter table learning_portal.field_reports enable row level security;

do $$ begin
  create policy "anon full access" on learning_portal.users for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "anon full access" on learning_portal.library_items for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "anon full access" on learning_portal.forms for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "anon full access" on learning_portal.responses for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "anon full access" on learning_portal.assignments for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "anon full access" on learning_portal.field_reports for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;

grant usage on schema learning_portal to anon, authenticated;
grant all on all tables in schema learning_portal to anon, authenticated;
alter default privileges in schema learning_portal grant all on tables to anon, authenticated;

-- Expose this schema over the Data API alongside the existing `public`
-- schema (additive only — public's own exposure/behaviour is unchanged).
alter role authenticator set pgrst.db_schemas = 'public, learning_portal';
notify pgrst, 'reload config';

-- ---------------------------------------------------------------- seed data
insert into learning_portal.users (id, role, username, password, full_name, school, county, grade) values
  ('u_teacher_demo', 'teacher', 'grace.mwangi', 'demo1234', 'Grace Mwangi', 'Nyeri Hill Primary', 'Nyeri', ''),
  ('u_learner_demo', 'learner', 'naomi.k', 'demo1234', 'Naomi Kiptoo', 'Nyeri Hill Primary', 'Nyeri', 'Grade 5A'),
  ('u_leader_demo', 'school_leader', 'peter.kamau', 'demo1234', 'Peter Kamau', 'Nyeri Hill Primary', 'Nyeri', ''),
  ('u_field_demo', 'field_officer', 'susan.wanjiru', 'demo1234', 'Susan Wanjiru', '', 'Nyeri', ''),
  ('u_edu_demo', 'education_team', 'amina.hassan', 'demo1234', 'Amina Hassan', '', '', '')
on conflict (id) do nothing;

insert into learning_portal.library_items (id, title, subject, type, audience, description, uploaded_by) values
  ('lib1', 'Fractions — visual walkthrough', 'Mathematics', 'Video', 'both', 'A short animated walkthrough of adding and subtracting fractions.', 'Amina Hassan'),
  ('lib2', 'Reading comprehension pack', 'English', 'Worksheet', 'both', 'Six short passages with comprehension questions, Grade 4 level.', 'Amina Hassan'),
  ('lib3', 'Life cycles explained', 'Science', 'Reading', 'learner', 'An illustrated explainer of animal and plant life cycles.', 'Amina Hassan'),
  ('lib4', 'Times tables practice', 'Mathematics', 'Worksheet', 'both', 'Drill sheets for the 2–12 times tables.', 'Amina Hassan'),
  ('lib5', 'Grading rubric — Term 2 assessments', 'Mathematics', 'Assessment', 'teacher', 'A shared rubric for marking Term 2 assessments consistently across classes.', 'Amina Hassan')
on conflict (id) do nothing;

insert into learning_portal.forms (id, title, description, audience, created_by, questions) values
  ('form1', 'Term 2 curriculum feedback', 'A quick check on how the new Mathematics materials are landing in class.', 'teacher', 'Amina Hassan',
   '[{"id":"q1","type":"rating","prompt":"How well are learners engaging with the new Mathematics materials?"},{"id":"q2","type":"text","prompt":"What would make the materials more useful?"}]'::jsonb),
  ('form2', 'Field visit debrief', 'A quick check-in after this term''s school visits.', 'field_officer', 'Amina Hassan',
   '[{"id":"q1","type":"rating","prompt":"How would you rate school readiness overall?"},{"id":"q2","type":"text","prompt":"Anything the Education Team should follow up on?"}]'::jsonb)
on conflict (id) do nothing;

insert into learning_portal.responses (id, form_id, respondent_id, respondent_name, respondent_role, answers) values
  ('resp1', 'form1', 'u_teacher_demo', 'Grace Mwangi', 'teacher',
   '[{"questionId":"q1","value":4},{"questionId":"q2","value":"More worked examples for fractions would help — learners get stuck partway through."}]'::jsonb),
  ('resp2', 'form2', 'u_field_demo', 'Susan Wanjiru', 'field_officer',
   '[{"questionId":"q1","value":4},{"questionId":"q2","value":"Chaka Primary still needs the roofing repair flagged last term."}]'::jsonb)
on conflict (id) do nothing;

insert into learning_portal.assignments (id, learner_id, title, subject, due, done) values
  ('a1', 'u_learner_demo', 'Fractions quiz', 'Mathematics', 'Friday', false),
  ('a2', 'u_learner_demo', 'Reading log', 'English', 'Monday', false),
  ('a3', 'u_learner_demo', 'Times tables practice', 'Mathematics', 'Wednesday', true),
  ('a4', 'u_learner_demo', 'Comprehension worksheet', 'English', 'Tuesday', true)
on conflict (id) do nothing;

insert into learning_portal.field_reports (id, officer_id, school, county, visit_type) values
  ('fr1', 'u_field_demo', 'Nyeri Hill Primary', 'Nyeri', 'Learning'),
  ('fr2', 'u_field_demo', 'Chaka Primary', 'Nyeri', 'Infrastructure'),
  ('fr3', 'u_field_demo', 'Narok Hope Primary', 'Narok', 'ICT')
on conflict (id) do nothing;
