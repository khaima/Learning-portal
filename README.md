# HPF Digital Learning Portal

**🔗 Live: <https://khaima.github.io/Learning-portal/>**

A standalone build for Human Practice Foundation's Teacher, Learner,
School Leader (head of institution), Field Officer, and Education Team
experience — a genuinely separate system from the existing
`HPF-digital-portal-2026` project and its real accounts, with its own
dedicated Supabase project (see "The backend" below).

## What this is

A **static, no-build, dependency-free front end** — plain HTML, CSS, and
vanilla ES-module JavaScript — talking to a **real backend**: a Supabase
Edge Function API in front of a locked-down Postgres database. Six pages:

- **`index.html`** — sign-in. Pick a role, then sign in — staff with an
  email + password, learners with a username + 4-digit PIN. New staff
  create an account (no email verification) and a one-step form captures
  name, role and — for teachers and school heads — County → School from
  the school list (see "Schools and codes" below).
- **`teacher.html`** — a teacher's classes, this week's grading queue,
  recent results, forms sent by the Education Team, Teacher Resources and
  the Digital Library, plus **My Learners**: an editable roster where the
  teacher adds learner accounts (name, username, grade, 4-digit PIN) and
  can edit them, reset a PIN, unlock, or remove. A **My learning activity**
  panel shows their own content-library usage (see below).
- **`learner.html`** — signed in with a username + PIN. A learner's
  class, their assignments (open, save progress, hand in, see marks and
  feedback), My Progress (work handed in and marks, shown separately), the
  Digital Library, and their own **My learning activity** panel.
- **`leader.html`** — a head of institution's enrolment/staffing snapshot,
  the termly return cycle, recent field visits, forms from the Education
  Team, **all three** content shelves — Teacher Resources, the Digital
  Library, and **For School Head** (content addressed to school
  leadership specifically, never mixed into teachers' own resources) —
  and their own **My learning activity** panel.
- **`field.html`** — a field officer's stats and the flagship flow: pick a
  county, the school list (with codes) narrows, pick a visit type — the
  Education Team's forms for that programme (Learning, Infrastructure,
  ICT, MEP, Teacher support) appear straight away — start the visit, fill those forms in,
  submit — the report and its forms save together and appear immediately.
  Plus other forms addressed to Field Officers,
  and **Field surveys** — KoboToolbox surveys attached by the Education
  Team, each with an **Open survey** button that launches Kobo's own web
  form (prefilled with the officer's ID) and a status pill that flips to
  **Submitted** once the submission is detected.
- **`education.html`** — the Education Team's dashboard: upload content —
  attach a real file or a whole folder from your computer (drag-and-drop
  or the file/folder picker) — to one of three destinations:
  **Teacher Resources** (teachers and the head of institution only), the
  **Digital Library** (learner-facing, also visible to teachers and
  heads), or **For School Head** (head of institution only — for things
  addressed specifically to school leadership). Create a form — build
  questions (1–5 rating and short answer), upload a form file, or paste a
  link — and send it to Teachers, School Leaders, or Field Officers, in
  one county or all counties; a Field Officer form can be tied to a visit
  type so it's filled in during every visit of that type. Each form
  reaches exactly those people automatically. Watch responses roll in
  (live rating averages, filled copies to download, the school for visit
  forms). A form that has responses can only be **archived** — it stops
  being sent but every response is kept, and it can be restored; only an
  unanswered form can be deleted. The database refuses to delete forms,
  visits or staff accounts that still have records attached. Also
  connect **KoboToolbox** to publish field surveys (see below), see a
  **Content usage report** (see below), and read the **impact
  dashboards** (see below).

### Impact dashboards

The Education Team's dashboard opens on **Impact dashboards**. The global
filters (county, school, term or date range) rescope every one of them at
once, and clicking a school name narrows everything to that school.

- **Executive overview** — six headline numbers: **schools, learners,
  teachers, active users** (anyone who did something in the portal in the
  period picked, or the last 30 days: read, started or handed in work, set
  or marked work, filed a visit, answered a form, sent a Kobo survey),
  **completion** and **library use (hours)**; then average mark, field
  visits, Kobo submissions and the data quality score; a card per
  dashboard; and **Needs attention**.
- **Reach** — schools, learners and teachers **by county**, **grade
  distribution**, **gender where it has been recorded** (see below),
  accounts by role, teachers by employment type (BOM / TSC), and learner
  growth term by term.
- **Learning** — assignments (by subject), **completion** (by grade),
  **assessment results** (by grade, bands), **subject performance**
  (completion and results side by side), **learner progress** (average mark
  by term, and how many learners improved from their first marked term to
  their latest), and school performance.
- **Teacher development** — the **training register** (sessions —
  workshops, cluster meetings, coaching, online courses — and who
  attended), share of teachers trained (by county), **ICT integration**
  through M&E indicators shown here (e.g. *% of teachers integrating ICT*
  from validated observation forms), teachers' own **digital resource use**,
  and **teacher activity** (set work, marked, used the library, answered
  forms; active by county). Training sessions are archived, never deleted;
  taking a teacher off the list keeps them on record as not attended; every
  change is in the audit log.
- **Field operations** — **visits** by type (Learning, Infrastructure, ICT,
  MEP, Teacher support), month, county and term; schools not visited yet;
  **completed forms** (visit forms filled, response rates); **Kobo
  submissions** by survey, month and county, and the checks they fail.
- **Digital resources** — **resources** (by shelf, subject, type),
  **opens**, **usage time**, **active users** (learners and staff), learner
  reach, use by month and term, and the **most-used content**.
- **M&E** — every indicator in the active programmes: **target against
  actual** (the bar is the actual, coloured met / close / not met; the line
  is the target), for a period and the county or school picked. Pick an
  indicator for its **trend over time** (term by term, against its targets)
  and its **county and school comparison**. Recording and verifying actuals
  stays on *Indicator results*.

M&E can tag any indicator to **also show on** one of the five dashboards
(Results framework → Edit indicator), so e.g. *% of teachers integrating
ICT* appears on Teacher development next to the training numbers.

**Gender** is new and **optional**: female, male or prefer not to say, or
left empty. Teachers and school heads can record it for learners (the add
form, the CSV's optional fifth column, or Edit); administrators for staff.
Dashboards only ever show it as **totals**, and any group **under 5 shows
as "<5"** — with a second group hidden too when one alone would let it be
worked out — so no one can be picked out.

Completion and results are separate measures everywhere: handing work in
isn't the same as doing well in it. Every number is computed server-side
from the live tables (`GET /api/impact`, in
[`impact.ts`](supabase/functions/api/impact.ts), built on
[`intelligence.ts`](supabase/functions/api/intelligence.ts)) for the
Education Team, M&E and administrators; nothing is seeded or estimated. The
date filter applies only to rows with a real date (visits, library
sessions, responses, Kobo submissions, assignment due dates, training
dates). Forms aren't tied to a school, so a school filter doesn't narrow
them.

### Data Quality Center

M&E and data → **Data quality**: every problem in the portal's
records, how serious it is, where it is, and what's being done about it.

- **Checks** ([`data_quality.ts`](supabase/functions/api/data_quality.ts)):
  duplicate learner records (same name among a school's active learners),
  duplicate staff records (same name, or an email one letter apart),
  missing school, missing county, school/county combinations that don't
  agree, missing grade, invalid grade (not a portal grade, or not the
  class's grade), duplicate Kobo submissions, unmatched Kobo officer
  references, missing required Kobo fields, orphaned records (no open
  enrollment, an enrollment left open after leaving, an archived class, a
  deleted library resource…), invalid dates, inactive users still
  assigned to classes or owning open work, learners without a class, and
  teachers / school heads without a school.
- **Each issue** has a type, a severity (High / Medium / Low), the
  record(s) it affects, its school and county, when it was **first found**,
  its **status** — `OPEN`, `UNDER_REVIEW`, `RESOLVED`, `IGNORED` — and,
  once resolved, **who resolved it and when**.
- **Scans** run when the page (or the Overview) is opened and the last scan
  is over 15 minutes old, and on **Scan now**. A problem found again keeps
  its history and first-found date; one no longer found is resolved "at
  the source" by the scan; a resolved one that comes back reopens. A scan
  never overrides **Ignored** (a person's decision that it's fine).
- **Score** — each check's pass rate (records with no open issue), weighted
  by severity, for the county / school picked; the trend is kept per scan.
- **Filters** — county, school and date (first found) from the filter bar;
  issue type, severity, status and a search on the page. Select several to
  change their status together.
- **Corrections** — where a fix is clear, it can be made from the issue:
  set a grade, place a learner in a class, place a teacher in a school, use
  the school's county, archive one copy of a duplicate learner (as Inactive
  — never deleted), open or close an enrollment, end a class assignment,
  accept or exclude a Kobo submission. Each goes through the portal's normal
  edit and needs that edit's permission too (so M&E and the Education Team
  can triage but not change learner records; administrators can).
- **Nothing is deleted.** Every detection, status change and correction is
  an event in the issue's history (`dq_issue_events`, which even the API
  can't edit), with who, when, why and — for corrections — the value
  before and after; corrections and status changes also go to the audit
  log.

### M&E: results framework, targets, actuals, evidence, reports

```
PROGRAMME → OUTCOMES → INDICATORS → TARGETS → ACTUALS → EVIDENCE → REPORT
```

The Education Team dashboard's **M&E** pages:

- **Results framework** — programmes, their outcomes, and the indicators
  that measure them. Each indicator has a code, definition, unit (%, count
  or number), whether higher or lower is better, a baseline, the evidence
  expected, and **where its actuals come from**:
  - **Validated Kobo data** — from the portal's own checked Kobo records
    (never raw or rejected submissions): the number of submissions, the %
    giving an answer (e.g. *ICT integrated? = Yes*), an average, or the %
    at or above a threshold;
  - **a portal measure** — work handed in, average mark, share meeting
    expectations, learners enrolled, teachers active / setting work,
    library reach, schools visited (optionally by visit type), field visits;
  - **entered by hand**, with evidence.
- **Targets** per term or school year, for the whole programme, a county or
  a school. A county or school without its own target is measured against
  the programme's. Every target change is in the audit log.
- **Results** — for the programme, period and the county / school picked
  at the top: baseline, target, actual, achievement (actual ÷ target, the
  other way round for indicators that should go down) and a traffic light
  — **met** (100%+), **close** (80%+), **not met** — with the evidence. Each
  indicator opens to show how its value is worked out, and its breakdown by
  county and school.
- **Actuals** are **live** until someone **records** one: a snapshot of
  the value, how it was worked out (e.g. 17 of 25 observations) and the
  data behind it, with evidence attached automatically (the Kobo survey and
  number of validated submissions, or the portal measure). Later changes to
  the data don't change a recorded value; recording again keeps the old
  version. Someone **other than the person who recorded it** then
  **verifies** it (or rejects it, with a reason). Links, files and notes can
  be added as evidence.
- **Reports** freeze the results for a programme, period and place. A draft
  can be refreshed; once **final** it can never change or be deleted — the
  database itself refuses. Print or download as CSV.

Who does what: M&E (and administrators) own the framework and targets,
verify actuals and issue reports; the Education Team can see everything and
record actuals and evidence.

### Content usage tracking

Every "Open to read" click on any dashboard is timed:

- **On the reader's own dashboard** — Teacher, Learner, and School
  Leader all get a **My learning activity** panel: total time spent,
  resources opened, and a per-visit list with a start time and, once
  they've come back to the tab, a finish time and duration.
- **On the Education Team's dashboard** — the Digital Library page's
  **Content usage report** rolls every account's activity up into one
  view: total time spent, resources opened, timed sessions, and active
  users; the most-visited resources ranked by time; and a per-school
  breakdown. A **school filter** scopes the whole report to one school,
  or leave it on "All schools" to see everything combined.
- **Honesty about what "time spent" means**: "Open to read" launches a
  signed Storage URL in a new tab — often a PDF, image, or video the
  browser renders natively — so there is no way to see what happens
  inside it. What's actually measured is wall-clock time from the click
  to the moment the visitor comes back to the portal tab
  (`visibilitychange`, wired once in `nav.js` for every dashboard). This
  is a reasonable proxy for engagement, not a literal measurement of
  reading attention; a visit that never gets a return trip (they close
  the whole browser, say) simply stays open-ended with no completion
  time or duration, rather than guessing one.

### KoboToolbox field surveys

The Education Team's dashboard has a **Field surveys (KoboToolbox)** panel:

- **Connect once** — paste an EU KoboToolbox **API token**
  (`https://eu.kobotoolbox.org` → Account settings → Security). The token
  is verified against KoboToolbox and then stored **server-side only**
  (`kobo_config`) — it is never sent back to any browser.
- **Attach a survey** — pick any *deployed* survey from the account and
  attach it. It appears on every Field Officer dashboard.
- Each survey must contain a **hidden** question whose data column name is
  `officer_ref` (configurable). The portal prefills it with the field
  officer's profile id via the Enketo `?d[officer_ref]=<id>` URL param,
  and matches submissions back with
  `?query={"officer_ref":"<id>"}` on the Kobo data API.
- Submissions are detected automatically (on the officer's dashboard load
  and the Education Team's **Sync now**); officers also have a manual
  "I've submitted this" fallback.
- **Survey results** — a panel on the Education Team dashboard picks one
  attached survey and draws a chart per question (bar / donut / number
  summary / recent answers, plus submissions by school and by officer)
  from the portal's own validated records — see the pipeline below. The
  county and school filters apply.

### Kobo data pipeline

Postgres is the source of truth; KoboToolbox is where data is collected.

```
KoboToolbox ─→ API ─→ raw submission (kept exactly as received)
                  ─→ validation ─→ normalization ─→ kobo_records ─→ dashboards
```

- **Getting data in.** **Sync now** pulls every attached survey (its
  questions and all its submissions). Optionally, **Live push** lets each
  survey's KoboToolbox *REST Service* post every new submission to
  `/api/kobo/hook` the moment it's sent: Kobo Surveys → *Set up the push*
  gives the URL, a username and a password (Basic auth; shown once, only
  its hash is stored). Only attached surveys are accepted. Sync still
  catches edits, deletions and Kobo's own approvals.
- **Raw** — every submission is stored as received (`kobo_raw_submissions`),
  so it can be re-checked at any time without asking Kobo again.
  Submissions deleted in Kobo are marked removed, never deleted here.
- **Validation** (`kobo_pipeline.ts`) — each finding is an **error** (kept
  off the dashboards until a person decides) or a **warning** (shown, still
  counted):
  - *Required fields* — a required question left blank (unless the form's
    skip logic, or its group's, hides it).
  - *Data types* — whole numbers, numbers, dates, times, GPS points, and
    answers that must be one of the survey's own options.
  - *School code* — a school code, a school name, or a saved alias must
    match a portal school; near-misses get a "did you mean…".
  - *County* — must be a portal county, and agree with the school's.
  - *Officer* — the hidden officer reference must be a portal account
    (warnings if it's inactive, not a field officer, or works elsewhere).
  - *Duplicates* — the same submission sent twice (same answers and form
    start time, or same Kobo instance) counts once; the same officer,
    school and date twice is a warning.
  - *Dates* — a visit date in the future or after Kobo received it is an
    error; over a year before it, or a form finished before it started, a
    warning.
  - A submission a reviewer marked **Not approved** in Kobo is left out.
- **Normalization** — trimmed text, real numbers, option lists, ISO dates,
  GPS as coordinates; every submission linked to a **school**, **county**
  and **officer** in the portal (`kobo_records`), with its findings in
  `kobo_record_issues`.
- **Data pipeline** (Kobo Surveys → a survey → *Data pipeline*) — what came
  in and what counts; each check and how many fail it; **which questions
  hold the school, county, officer and date** (guessed on first sync,
  editable — saving re-checks everything); **school names it couldn't
  place** (pick the school once and it's remembered for every survey);
  and the **review queue**, where each flagged submission can be
  **accepted** onto the dashboards or **excluded**, always with a reason
  (audited). M&E can see all of it but change nothing.
- **Dashboards** — Survey results, *Field operations* and M&E read only
  the records that pass, or that a person accepted.

Survey answers can include personal data (for example learner names in an
assessment). Like everything else they're reachable only through the API,
by the Education Team, administrators and M&E.

Airtable, if used, should be fed **from** the portal (a reporting layer),
not straight from Kobo, so it sees the same validated data as the portal.

### Schools and codes

Schools come from one list, so a school is always the same school
everywhere and no school's teachers or learners get mixed with another's.

- **Counties** are fixed: Narok, Laikipia, Meru, Isiolo.
- **Schools** are managed by the Education Team on **Schools → School
  list**: pick a county, type the name, and the portal gives the school a
  code from its county — `NRK-001` is Narok's first school (`NRK` Narok,
  `LKP` Laikipia, `MRU` Meru, `ISL` Isiolo). Schools can be renamed (codes
  never change) and removed once nobody is in them.
- **Personal codes**: everyone placed in a school gets their own code under
  it — `NRK-001-T01` for a teacher, `NRK-001-H01` for a school head,
  `NRK-001-L0001` for a learner. Numbers only ever count up, so a code is
  never given to a second person.
- **Who picks what**: teachers and school heads choose County → School when
  they set up their account; learners are placed in the school of the
  teacher or school head who adds them; field officers choose a county and
  pick the school per visit; the Education Team isn't tied to a school.
- **Existing accounts** made before codes are asked once, on their next
  sign-in, to choose their school (a teacher's learners join it too). Only
  the Education Team can move someone to a different school afterwards
  (Users → Edit), which gives them a new code. Learners belong to the
  school, not the teacher: they stay when a teacher moves, and change school
  only by a transfer (below).

### Classes, enrollment and learner records

Learners are managed by school and class: **school → academic year → term
→ class → class teacher → learner enrollment**.

- **Academic year and terms:** one year is current (2026; terms Jan–Apr,
  May–Aug, Sep–Dec). Admins start the next year on **Schools → Academic
  year**; earlier classes and records stay under their own year.
- **Classes:** school heads create their school's classes for the year
  (Learners → Classes), give each a class teacher, and archive classes they
  no longer use. Teachers see their classes under **My Classes**.
- **Rosters:** a school head sees the whole school's roster and can move a
  learner between classes; a teacher sees the learners in classes they teach
  (plus any they added who aren't in a class yet). Admins and M&E can find a
  learner in any school (Schools → Find a learner).
- **Every learner has** a school, class, current teacher, grade, year, term,
  an enrollment status — `ACTIVE`, `TRANSFERRED`, `DROPPED_OUT`, `COMPLETED`
  or `INACTIVE` — enrollment date, exit date and reason, and a permanent
  **learner code** that never changes, even across schools.
- **Nothing is deleted.** "Remove" archives a learner (`INACTIVE`, or
  Dropped out / Completed with a reason and date): they leave the active
  roster and counts and can't sign in, but their record, history and work
  stay, and they can be reactivated.
- **Promotion:** a school head promotes a class into a class of the next
  grade; each learner's year in the old class is closed as `COMPLETED`
  ("Promoted to Grade 5") and a new enrollment opens. Learners in the top
  grade are marked Completed.
- **Transfers:** Admins and M&E move a learner to another school. The old
  enrollment is closed as `TRANSFERRED` and kept (the old school sees it
  under Past learners); the learner gets the new school's code but keeps
  their learner code, sign-in, work and history.
- **History:** every stay in a school and class is a row in
  `learner_enrollments`; History on any learner shows the full list. Moves,
  archives, transfers and promotions are also in the audit log.
- **Subjects:** each class can be given the subjects it takes (school head:
  Learners → Classes → Subjects…). Teachers set work in those subjects —
  or in any subject while a class has none set. Teachers add and remove
  learners from the classes they teach (My Classes → Learners).

### Assignments, marking and results

- **Building work** (teacher → Assignments → New assignment): class,
  subject, term, title, description, instructions, an optional Digital
  Library resource, opening and due dates, estimated time, and questions
  of six types — multiple choice, multiple response, true/false, short
  answer, a written task, or a file upload. A **draft** is private;
  **publishing** (needs a question and a due date) opens it to everyone
  enrolled in the class; **closing** stops new work. Questions are fixed
  once it's published, so the marks learners work towards never change.
  Only an unused draft can be deleted.
- **Doing it** (learner → Assignments): open, start, save progress, upload
  files, hand in. The time is recorded and work handed in after the due
  date is flagged **late** (still accepted until the teacher closes it).
- **Marking:** multiple choice, multiple response (all-or-nothing), true/
  false and short answers with accepted answers are marked automatically on
  hand-in; if every question is like that, the work is marked straight
  away. Everything else waits in the teacher's **Work to mark** queue: marks
  per question (automatic marks can be overridden), feedback per question
  and overall. Each mark records the percentage, the **band**, who marked
  it and when. Bands live in `grade_bands`: EE ≥ 80%, ME ≥ 50%, AE ≥ 30%,
  BE below.
- **Results** by learner, class, subject, grade, term, school year, school
  or assignment — for a teacher (their classes), a school head (their
  school), the Education Team / M&E / admins (every school) and each
  learner (their own). Every row shows two separate measures:
  - **Completion** — of the learners enrolled in the class while the work
    was open, how many handed it in, on time or late, and how many are
    missing it.
  - **Achievement** — the average percentage on **marked** work, and its
    band. Work not handed in, or not yet marked, never counts as a score.
- A learner's results stay with the school and class they did the work in,
  even after a transfer or promotion.

## The backend

Three parts, all in the project's own dedicated Supabase project
(`hpf-learning-portal`, ref `fwpqytrdlmxymvegvgji`) — entirely separate
from `HPF-digital-portal-2026`:

1. **Auth** — two paths, **no email is ever sent**:
   - **Staff** (teacher / school head / field officer / education team) sign
     in with an **email + password**, or **Continue with Google**. The API
     creates password accounts already-confirmed, so sign-in is a plain
     Supabase Auth check (no self-service password reset, since no email is
     sent). Google sign-in uses Supabase's own OAuth — first time through it
     lands in the same onboarding step as a password sign-up (role + name);
     after that it's a one-click return.
   - **Learners** use a **username + 4-digit PIN**. Their teacher creates
     the account from the teacher dashboard; the API verifies the PIN
     (scrypt-hashed, locks after 5 wrong tries) and issues its own session
     token.
   - **Remember me** — every sign-in form (password, learner PIN) has a
     "Remember me on this device" checkbox, **unchecked by default** because
     most devices in schools are shared. Checked, the
     session/token is kept in `localStorage` (survives closing the browser)
     and the last email/username used is remembered so the field is
     pre-filled next time. Unchecked, it goes in `sessionStorage` instead —
     gone the moment the tab or browser closes — and nothing is
     remembered for next time. No password or PIN is ever stored, only the
     identifier; learner PINs are never offered to the browser's password
     manager. A learner session lasts at most 12 hours either way.
2. **API** — one Edge Function, [`supabase/functions/api`](supabase/functions/api/index.ts)
   (Deno + Hono). Every read and write goes through it. It verifies the
   caller's JWT, loads their role from the `profiles` table (never trusts
   a JWT claim for authorisation), and does all data access with the
   service-role key.
3. **Database** — Postgres, **locked down**. Every table has RLS enabled
   with **no policies**, and the `anon`/`authenticated` roles have every
   privilege revoked. The browser cannot touch a table directly — the
   only way in is the API. Storage (`library` bucket) is private too;
   the API hands out short-lived signed upload and download URLs.

The publishable key in [`config.js`](config.js) is safe to ship: it can
only reach Supabase Auth, and the database ignores it entirely.

See [`supabase-schema.sql`](supabase-schema.sql) for the full schema and
the lock-down. Apply it to a fresh project, deploy the `api` function,
point `config.js` at the new project, and the app works unmodified.

### Roles, permissions and staff accounts

Eight roles: **Super Admin**, **Admin**, **Education Team**, **M&E**,
**Field Officer**, **School Head** (stored as `school_leader`), **Teacher**
and **Learner**. Every API route asks for a named *permission* (for
example `users.approve`, `forms.manage`, `stats.view`), never a role
name; [`permissions.ts`](supabase/functions/api/permissions.ts) is the one
table of which role holds which permission. The role always comes from
the caller's own row in the database — nothing the browser sends.

- **Joining:** an administrator **invites** someone (Users → Invite staff),
  choosing their role and school or county; the link works once, for that
  email only, for 14 days, and the account is active straight away. Anyone
  can also **register** on their own and ask to be a Teacher, School Head
  or Field Officer — that account is **pending** and reaches nothing until
  an administrator approves it (and may change the role or school).
- **Account states:** `pending`, `active`, `suspended`, `rejected`,
  `deactivated`. Only `active` accounts reach any protected route;
  suspending or deactivating also blocks sign-in at Supabase Auth.
- **Governance:** Admins and Super Admins manage accounts. Nobody can
  change their own account; an Admin can't manage another Admin or a Super
  Admin, or give either role; there's always at least one active Super
  Admin. Administrators don't get working-role permissions (a teacher's
  roster, filing field visits).
- **Audit log:** account creation, approval, rejection, role/school/county
  changes, suspension, deactivation, reactivation, password resets,
  invitations, learner creation, edits, class moves, archiving,
  transfers and promotions, and assignments (created, published, closed),
  hand-ins and marks go to `audit_log`,
  which can't be edited or deleted even by the service role. Admins see it
  under Users → Account history, and per account.
- **Tests:** [`authz_test.ts`](supabase/functions/api/authz_test.ts) calls
  every protected route as every role and account state against an
  in-memory database, and fails if a route has no test. It also walks
  through the school/class walls, learner enrollment, and the whole
  assignment cycle (visibility, hand-in, late work, marking, results).
  [`lms_test.ts`](supabase/functions/api/lms_test.ts) unit-tests the marking
  and results rules, [`intelligence_test.ts`](supabase/functions/api/intelligence_test.ts)
  the shared dashboard numbers, [`impact_test.ts`](supabase/functions/api/impact_test.ts)
  the impact dashboards (active users, gender suppression, progress,
  training, field operations, resources), and
  [`kobo_pipeline_test.ts`](supabase/functions/api/kobo_pipeline_test.ts)
  every Kobo validation and normalization rule (the authorization tests
  also run sync and the push against a stand-in KoboToolbox), and
  [`data_quality_test.ts`](supabase/functions/api/data_quality_test.ts) all
  fifteen data quality checks and the score, and
  [`me_test.ts`](supabase/functions/api/me_test.ts) the M&E rules (sources,
  periods, targets, achievement):
  `cd supabase/functions/api && deno test --allow-env --config deno.json authz_test.ts lms_test.ts intelligence_test.ts kobo_pipeline_test.ts data_quality_test.ts me_test.ts impact_test.ts`

### Turning on Google sign-in

The **Continue with Google** button is already wired up on the frontend —
it fails gracefully ("Google sign-in isn't set up yet") until three
one-time, manual steps are done in the Google and Supabase dashboards
(no code or MCP tool does this part):

1. **Google Cloud Console** → APIs & Services → Credentials → Create
   Credentials → OAuth client ID → Web application. Add this Authorized
   redirect URI:
   `https://fwpqytrdlmxymvegvgji.supabase.co/auth/v1/callback`
2. **Supabase Dashboard** → Authentication → Sign In / Providers →
   Google → enable it, paste the Client ID and Client Secret from step 1.
3. **Supabase Dashboard** → Authentication → URL Configuration → set
   Site URL to `https://khaima.github.io/Learning-portal/` and add it
   (plus `http://localhost:*` for local dev) to Additional Redirect URLs.

Once enabled, no frontend change is needed — the button starts working
immediately for both new sign-ups and returning accounts.

## The content → form → feedback loop

Worth trying end to end:

1. Sign in as an **Education Team** account. (A new account can't choose
   Education Team itself — an administrator invites it, or changes its
   role on the **Users** page.)
2. Upload content — attach a file or folder — to **Teacher Resources**,
   the **Digital Library**, or **For School Head**, and/or send a form to
   Teachers, School Leaders, or Field Officers.
3. Sign out. Create another staff account → onboard as a **Teacher**. Add
   a learner from **My Learners**. Sign out, pick **Learner** on the
   sign-in screen, and sign in with that username + PIN — a Teacher
   Resources item never shows for them, a Digital Library item does.
4. Back as the Teacher / a Field Officer / School Leader: the form
   appears as *Pending*; fill it in and submit.
5. Back as Education Team — the response is there, with a live average for
   rating questions and the respondent's name against short answers.
6. As the Teacher (or Learner, or School Leader), click **Open to read**
   on something in the library, then come back to that tab — check **My
   learning activity** on their dashboard for the timed visit. Back as
   Education Team, the same visit shows up in the Digital Library page's
   **Content usage report**, filterable by school.

Do steps 3–5 on a different device to see what a real backend buys you:
same data everywhere, because the database is the source of truth.

## What it does NOT have yet

- **No email is sent for invitations.** The administrator copies the
  invitation link and sends it themselves.
- **Learner PINs are 4 digits — intentionally weak.** They're
  teacher-managed and locked after 5 wrong tries; fine for coursework and
  library access, not for anything sensitive.
- **No password reset for staff.** No email is sent, so a forgotten
  password can only be fixed by an admin resetting it in the Supabase
  dashboard (or a future admin screen).
- **Results come only from assignments set in the portal.** Exams or
  tests marked on paper aren't recorded unless a teacher sets them up as an
  assignment.
- **Moving a learner to another class mid-year** updates their current
  enrollment rather than starting a new one, so work set earlier in the new
  class can show as missing for them.

## Try it

**Live:** <https://khaima.github.io/Learning-portal/> — deployed from
`main` via GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

Run it locally:

```
python serve.py
```

then open the printed `http://localhost:<port>`. It talks to the live
API immediately — no Supabase dashboard setup needed (email is never
used).

## File map

| File | Purpose |
|---|---|
| `index.html` / `index.js` | Sign-in: role → staff password / learner PIN → onboarding |
| `teacher.html` / `teacher.js` | Teacher dashboard |
| `learner.html` / `learner.js` | Learner dashboard |
| `leader.html` / `leader.js` | Head-of-institution dashboard |
| `field.html` / `field.js` | Field Officer dashboard (county → school → visit report) |
| `education.html` / `education.js` | Education Team dashboard (upload, form builder, results, stats) |
| `supabase.js` | The Supabase Auth client (password + Google) and the "remember me" storage adapter |
| `api.js` | Thin fetch wrapper over the `api` Edge Function; attaches the JWT |
| `auth.js` | Sessions, the profile, `requireRole` for each dashboard |
| `store.js` | Every data call — library, forms, responses, assignments, reports, stats |
| `config.js` | Supabase URL, publishable key, API base URL |
| `data.js` | Static UI constants (roles, subjects, question types) |
| `util.js` | Tiny shared DOM / escaping / toast helpers |
| `mel-ui.js` | M&E: results, the indicator panel (record / verify / evidence), framework editor, reports |
| `dq-ui.js` | The Data Quality Center: score, checks, issues, history, corrections |
| `kobo-ui.js` | The Kobo data pipeline panel (checks, mapping, school aliases, review queue) and the live-push setup |
| `impact-ui.js` | The impact dashboards: executive overview, reach, learning, teacher development, field operations, digital resources, M&E |
| `training-ui.js` | The training register: record a session, mark who attended, archive |
| `assignments-ui.js` | Assignment builder, marking, results table, and the learner's assignment screen |
| `learners-ui.js` | Shared learner dialogs: archive, history, transfer |
| `styles.css` | The whole design system (light + dark, one file) |
| `serve.py` | Local static server (honours `$PORT`) |
| `supabase/functions/api/` | The backend API (Deno + Hono) |
| `supabase-schema.sql` | Full schema + the database lock-down |

## Where this could go next

- Invite-only staff sign-up + an admin screen to assign/approve roles and
  reset passwords (right now staff sign-up is open and there's no reset).
- Optional custom SMTP if you later want password-reset or notification
  email — the code path is gone but easy to re-add.
- Recording paper-based exam scores directly, without building an
  assignment.
- Per-row authorisation could move partly into RLS if the app ever needs
  the database reachable by anything other than this one API.
