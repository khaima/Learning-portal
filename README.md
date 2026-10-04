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
  create an account through the portal (public sign-ups are closed in
  Supabase Auth — [`docs/AUTH.md`](docs/AUTH.md)) and a one-step form captures
  name, role and — for teachers and school heads — County → School from
  the school list (see "Schools and codes" below). Built for slow school
  connections: one light card (HPF, *Learn • Teach • Support • Measure*,
  five role tiles, *Need help?*), no photos, fonts that don't hold up the
  page, the tiles shown before the sign-in code has even arrived (a tap
  still counts), a notice if the connection is too slow, and the school
  list loaded only when an account is being set up. The role picked is in
  the address (`#teacher`), so a phone's Back button returns to the tiles.
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

### Offline: work without a connection

```
ONLINE → download assigned content → LOCAL DEVICE → work offline → stored locally
       → NETWORK AVAILABLE → SYNC → SERVER
```

Built for schools with an unreliable connection. Every dashboard shows a
**sync status** in its top bar — **● Online** or **● Offline**, the **last
sync** time and how many activities are **waiting to sync** — and opens
the **Offline & sync** panel: what's waiting, anything that needs a
decision, **Sync now**, and the resources saved on the device.

- **The app itself** works offline: a service worker (`sw.js`) keeps the
  pages, scripts and styles on the device, network-first (a new deploy
  shows up on the next online load; on a slow connection the device's copy
  is used after 4 seconds). It never stores data — signed-in replies stay
  out of shared browser caches. The portal can also be installed to a
  phone's home screen (`manifest.webmanifest`).
- **Downloaded content** (IndexedDB, `offline.js`), kept per account:
  what the server sent for the pages people work in — assignments, the
  library list, class lists, work to mark, forms, schools. At every sync a
  learner's assignments are downloaded (and the reading they point to, if
  it's 5 MB or less), and a teacher's work to mark. Any PDF, image, video,
  audio or text resource can be **saved offline** on purpose; it opens only
  in the portal's own viewer (never as a download — those stay with the
  Education Team). Word/Excel/PowerPoint need Microsoft's online viewer, so
  they can't be.
- **Work offline** — kept on the device and sent later (`sync.js`):
  learners start, answer, save and hand in assignments (files they attach
  are kept and uploaded at sync); teachers mark; teachers, school heads and
  field officers answer forms; field officers record visits (with filled
  copies); reading time is recorded. The change shows straight away,
  marked *waiting to sync*. Anything else needs a connection and says so.
- **Sync** runs on load, when the connection comes back, every few minutes,
  and on *Sync now*. Activities go in order; each carries its own
  **Idempotency-Key**, so a send that arrived but whose reply was lost is
  never done twice (the API keeps each key's reply — `sync_requests`). A
  connection failure is retried; a **refusal** (e.g. the assignment was
  closed) is kept and shown — try again or discard.
- **Conflicts**: queued work carries the version the device last saw. If
  the same work was changed elsewhere meanwhile — answers saved on another
  device, work marked by someone else, work already handed in — the server
  returns its copy and the person chooses: **keep mine** or **use the
  other one**. Later activities on the same thing wait until it's settled.
- **Work handed in offline** records when it was handed in on the device
  (`offline_submitted_at`, shown as "handed in offline … received …");
  lateness goes by that time when it's plausible (not in the future, not
  before the assignment was out).
- **Shared devices**: signing out removes that account's downloaded copies
  and saved resources from the device — but never work that hasn't been
  sent (the person is warned first, and it goes the next time they sign in
  there). Signed in, a dashboard opens offline from the profile this device
  remembers for that session.

### Sync center

Opened from the sync status in any top bar (and from **Sync center** in
the field officer's and the Education Team's menus) — for troubleshooting
Kobo and school work:

```
Kobo                ✓ Connected · Last sync 10:32
School data         ✓ Synced
Learning activity   ⚠ 14 pending
Content             ✓ Synced
[Sync now]
```

- **Kobo** — connected or not, the last sync and last pushed submission,
  and any survey that failed at its last sync **with the reason** (e.g.
  *KoboToolbox rejected the API token*, *Couldn't reach KoboToolbox*),
  kept per survey (`kobo_forms.last_sync_error`) instead of only in the
  server log. A **field officer** sees what Kobo has received from them,
  how much counts, and **why some needs review** (e.g. *School "Aitong
  Pri" isn't a school in the portal*) — plus what to check in Kobo Collect
  when something they sent isn't there yet.
- **School data** — visits and forms waiting on the device, how fresh the
  device's copies are, and how many visits the server has from them.
- **Learning activity** — answers, hand-ins, marks and reading waiting,
  and what the server has received (hand-ins for a learner, marks for a
  teacher).
- **Content** — whether the device's library list is up to date, and the
  resources saved for offline reading.
- **Sync now** sends what's waiting, refreshes the device's copies and —
  for the Education Team — syncs Kobo too.
- Each row says what's wrong in words and what to do. Offline, it shows
  what the device knew at its last sync.
- **Field team devices** (Education Team and administrators): every
  field officer's, teacher's and school head's device — last sync, what's
  waiting, and who needs a look (work waiting for over a day, something to
  decide on the device, no sync for a week, or never reported). Staff
  devices report this after each sync — counts and times only, never the
  work (`device_sync_status`); learners' shared tablets don't report.

### Notifications

Every dashboard's **bell** shows how many notifications are unread and
opens the list — each with a link to the page to act on it. They're
**stored and auditable**, not browser alerts: rules
([`notifications.ts`](supabase/functions/api/notifications.ts)) run every
hour (pg_cron) and when someone opens their notifications, and what's new
is stored once per person (never the same thing twice):

| Who | Example | When |
|---|---|---|
| Teacher | *3 assignments are due tomorrow.* | published work in classes they teach, due tomorrow (Kenya time) |
| Teacher | *5 pieces of work are waiting to be marked.* | something handed in more than 3 days ago (daily) |
| Learner | *2 assignments are due tomorrow.* / *Your "Fractions quiz" was marked: 75%.* | not handed in yet / marked in the last week |
| School head, teacher, field officer | *Term return is due.* | a form with a **due date** they haven't answered: 3 days before, and again once overdue |
| Field officer | *Your ICT visit form is incomplete.* | a visit in the last 30 days filed without all its type's forms — which can now be **finished afterwards** from the visit list |
| Education Team, admins | *12 Kobo submissions received.* | new Kobo submissions since they were last told (with how many need review) |
| Admins | *4 staff accounts awaiting approval.* | daily, while any are pending |

Forms can have a **due date** (set when sending one, or changed on the
Forms page). Reading a notification (or opening it) records when; offline,
that's synced later. The database refuses to change or delete a
notification, and keeps an append-only history of when each was created
and read. The Education Team's **Notifications** page is the log: who was
told what, when, and whether they've read it — filter by kind, role and
status, and **Run now**. The hourly run calls the API with a secret that's
generated inside the database (Vault) and checked there; it never appears
in code or the browser.

### Reports and exports

**Export reports** — on the Education Team's and school head's *Reports*
pages, the field officer's *Reports* page and the teacher's *Results* page —
downloads any report the person is allowed to export, as **Excel**, **CSV**
or **PDF**:

| Report | What's in it | Who can export it |
|---|---|---|
| Learner Register | code, grade, class, school, county, gender, enrollment status and dates | Education Team, M&E, admins (all schools) · school heads (their school) · teachers (their classes) |
| Teacher Register | teachers and heads: staff code, school, employment type, classes, trainings | Education Team, M&E, admins · school heads (their school) |
| School Register | each school's learners, teachers, classes, visits, Kobo submissions | Education Team, M&E, admins · school heads (their school) |
| Assignment Report | each assignment: completion and average mark, side by side, never combined | as the Learner Register |
| Assessment Report | results by subject and class, and every piece of marked work | as the Learner Register |
| Field Visit Report | visits with the forms filled and still missing | Education Team, M&E, admins · field officers (their own visits) |
| Kobo Report | each survey's status and every submission with its checks | Education Team, M&E, admins |
| Library Usage | opens, readers, hours, by resource and by school | Education Team, M&E, admins |
| M&E Indicator Report | baseline, target, actual, achievement, evidence | Education Team, M&E, admins |
| Term Report | a term at a glance, overall and by school | Education Team, M&E, admins · school heads (their school) |
| County Report | county by county; one county's schools | Education Team, M&E, admins |

**Every export respects the person's permissions.** The list of reports
comes from the server, and each report is built with the same scope rules
as the screens: a school head's exports are their own school and a
teacher's their own classes, whatever filter is sent; a field officer's are
their own visits. Exports never include usernames, PINs or passwords;
staff emails appear only for those who manage accounts. Every export is in
the **audit log** (`report.exported`: who, which report, format, filters
and row count).

The files are written in the browser by [`export.js`](export.js), with no
libraries to download: Excel has one sheet per part of the report with a
frozen, filterable header, real dates and percentages, and an *About* sheet
(what it covers, filters, who generated it and when); CSV is UTF-8 with
spreadsheet formulas neutralised; PDF is A4 landscape with the header row
repeated on every page and *Page n of N*. Exports need a connection (they
come from the latest records). The catalogue is in
[`reports.ts`](supabase/functions/api/reports.ts); the reports are built in
`index.ts` (`GET /reports`, `GET /reports/:id`).

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

1. **Auth** — two paths (the full picture, and the one-time production
   setup, in [`docs/AUTH.md`](docs/AUTH.md)):
   - **Staff** sign in with an **email + password**. Accounts are made only
     by the API (`POST /auth/register`, already confirmed) — public sign-ups
     are off in Supabase Auth. **Forgot password?** emails a reset link,
     sent by Supabase Auth through the portal's own mail sender (custom
     SMTP: Resend or Brevo) in an HPF-branded email. **Continue with
     Google** appears only when Google is switched on in Supabase Auth.
   - **Locked out?** An administrator's **Reset password** sends that
     reset link (the default), or makes a one-time **temporary password**
     the person must replace the first time they sign in with it — until
     then the API refuses them everything else. Both are audited; no
     administrator ever chooses or sees someone's lasting password.
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

### Roles, workspaces and access

Eight roles, each with **its own workspace, menu and landing page**, its
**permissions** and its **data scope** — enforced together in five layers
(menu, page, API, database, scope). The full model, the matrices and the
audit behind it are in [`docs/RBAC.md`](docs/RBAC.md).

| Role | Workspace | Lands on | Data |
|---|---|---|---|
| Super Admin | Platform Administration (`platform.html`) — every right | Platform overview | Everything |
| Admin | Programme Administration (`admin.html`) | Administration overview | Everything, or assigned counties / schools |
| M&E | Monitoring & Evaluation (`me.html`) | M&E overview | Everything, or assigned counties / schools |
| Education Team | Learning & Education (`education.html`) | Learning overview | Everything, or assigned counties / schools |
| Field Officer | Field Operations (`field.html`) | My dashboard | Assigned counties / schools only |
| School Head | School Management (`leader.html`) | School overview | Own school |
| Teacher | Teaching & Learning (`teacher.html`) | My teaching | Own classes |
| Learner | My Learning (`learner.html`) | My learning | Own work |

- **Menus** come from [`navigation.js`](navigation.js) and show only what a
  person's permissions allow; any other page address — typed, bookmarked or
  another role's — returns them to their own start page. Groups collapse
  (remembered), carry badges for what's waiting, and fold to an icon rail.
- **Permissions:** every API route asks for a named permission, never a
  role name; [`permissions.ts`](supabase/functions/api/permissions.ts) is the
  one table of which role holds which. The role always comes from the
  caller's own account in the database. A Super Admin can **grant** one
  person one extra permission (with a reason) and revoke it — Users & roles
  → View, or the Permissions page.
- **Data scope** ([`scope.ts`](supabase/functions/api/scope.ts)) limits every
  list, dashboard, export and change. Admins and Super Admins assign
  counties or schools to staff on the Users page (View); field officers see
  nothing until assigned. Assignments are ended, never deleted.
- **My profile** (every role) shows what you can do, where, and anything
  granted to you; staff can change their own password there.

- **Joining:** an administrator **invites** someone (Users → Invite staff),
  choosing their role and school or county, and either has the portal
  **email** the invitation or **copies the link** to send another way; the
  link works once, for that email only, for 14 days, and the account is
  active straight away ([`docs/AUTH.md`](docs/AUTH.md)). Anyone
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
  changes, suspension, deactivation, reactivation, password help (reset
  links sent, temporary passwords made, passwords chosen — never the
  password),
  invitations, learner creation, edits, class moves, archiving,
  transfers and promotions, and assignments (created, published, closed),
  hand-ins and marks go to `audit_log`,
  which can't be edited or deleted even by the service role. The Super
  Admin sees all of it (Audit log, Security events, Account activity);
  Admins see each account's history in its View panel.
- **Tests** — run on every push and pull request by GitHub Actions
  ([`.github/workflows/test.yml`](.github/workflows/test.yml)): a type check
  and every `*_test.ts`, against an in-memory stand-in for Supabase
  ([`test_world.ts`](supabase/functions/api/test_world.ts): an account for
  every role, plus pending, suspended, rejected and deactivated ones; two
  schools; a second county) — no database, network or secrets. Locally:
  `cd supabase/functions/api && deno task test`.
  [`authz_test.ts`](supabase/functions/api/authz_test.ts) calls every
  endpoint as every role: the roles allowed must get a real success (2xx,
  with the records each endpoint needs made first), everyone else 403, no
  session 401 — and it fails if an endpoint has no entry.
  [`isolation_test.ts`](supabase/functions/api/isolation_test.ts) proves a
  teacher sees only their own school's learners, classes and submissions
  (lists, results, exports and by-id), field officers only their assigned
  schools, the learner PIN lockout (5 wrong tries, open again after 15
  minutes), and that pending and suspended accounts are refused by every
  endpoint in the app. [`pwned_test.ts`](supabase/functions/api/pwned_test.ts)
  covers the leaked-password check and [`mail_test.ts`](supabase/functions/api/mail_test.ts)
  the invitation mailer. `authz_test.ts` also walks
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
  periods, targets, achievement); the authorization suite also covers
  offline sync (a retried write happens once, conflicts on answers and
  marks, offline hand-in times, offline reading) and notifications;
  [`notifications_test.ts`](supabase/functions/api/notifications_test.ts)
  covers every notification rule:
  [`scope_test.ts`](supabase/functions/api/scope_test.ts) the data-scope
  rules and the separation of duties, and
  [`navigation_test.ts`](supabase/functions/api/navigation_test.ts) that
  every role's menu matches its permissions exactly.

### Turning on Google sign-in

The **Continue with Google** button is already wired up on the frontend,
but stays hidden until Supabase Auth reports Google switched on — three
one-time, manual steps in the Google and Supabase dashboards (no code or
MCP tool does this part):

1. **Google Cloud Console** → APIs & Services → Credentials → Create
   Credentials → OAuth client ID → Web application. Add this Authorized
   redirect URI:
   `https://fwpqytrdlmxymvegvgji.supabase.co/auth/v1/callback`
2. **Supabase Dashboard** → Authentication → Sign In / Providers →
   Google → enable it, paste the Client ID and Client Secret from step 1.
3. **Supabase Dashboard** → Authentication → URL Configuration → set
   Site URL to `https://khaima.github.io/Learning-portal/` and add it
   (plus `http://localhost:*` for local dev) to Additional Redirect URLs.

Once enabled, no frontend change is needed — the button appears by
itself. While public sign-ups are off it signs in existing accounts only;
new people still join through the portal.

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

- **Learner PINs are 4 digits — intentionally weak.** They're
  teacher-managed and locked after 5 wrong tries; fine for coursework and
  library access, not for anything sensitive.
- **Results come only from assignments set in the portal.** Exams or
  tests marked on paper aren't recorded unless a teacher sets them up as an
  assignment.
- **Moving a learner to another class mid-year** updates their current
  enrollment rather than starting a new one, so work set earlier in the new
  class can show as missing for them.
- **Exports need a connection.** Reports are made from the latest records,
  so they can't be exported offline. PDFs use the built-in Helvetica font,
  which covers English and Western European letters only.
- **Offline covers day-to-day work, not administration.** Creating
  assignments, adding learners, managing classes, the Education Team's
  dashboards and signing in for the first time on a device all need a
  connection. Lateness of work handed in offline relies on the device's
  clock (teachers see both times).

## Try it

**Live:** <https://khaima.github.io/Learning-portal/> — deployed from
`main` via GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

Run it locally:

```
python serve.py
```

then open the printed `http://localhost:<port>`. It talks to the live
API immediately. (Password reset emails need the one-time mail setup in
[`docs/AUTH.md`](docs/AUTH.md).)

## File map

| File | Purpose |
|---|---|
| `index.html` / `index.js` | Sign-in: role → staff password / learner PIN → onboarding |
| `teacher.html` / `teacher.js` | Teacher dashboard |
| `learner.html` / `learner.js` | Learner dashboard |
| `leader.html` / `leader.js` | Head-of-institution dashboard |
| `field.html` / `field.js` | Field Officer dashboard (county → school → visit report) |
| `platform.html` · `admin.html` · `me.html` · `education.html` | The four management workspaces (Super Admin, Admin, M&E, Education Team) — thin pages sharing one set of sections |
| `workspace.html` / `workspace.js` | Those shared sections, and the loader that puts them in the page |
| `console.js` | The management console's logic (formerly `education.js`): dashboards, schools, users, content, forms, Kobo, M&E, data quality |
| `navigation.js` | Every role's menu: workspaces, groups, items, the permissions each needs |
| `admin-ui.js` | Platform and Administration overviews, Permissions, Account activity, Teachers, Classes, School profiles, Assignments, Results, Field visits, Subjects, one account's access (scope, grants, history) |
| `profile-ui.js` | My profile: who, where, what you can do, grants, change password |
| `docs/AUTH.md` | Sign-in and passwords: reset links, temporary passwords, Google, the mail-sender setup |
| `scripts/configure-auth.mjs` | Sets the Supabase Auth production settings (mail sender, branded email, sign-ups off) — run with your own keys |
| `supabase/templates/recovery.html` | The HPF "Reset your password" email |
| `docs/RBAC.md` | The access model: audit, roles, permissions, scope, menus, the five layers, migration, tests |
| `supabase.js` | The Supabase Auth client (password + Google) and the "remember me" storage adapter |
| `api.js` | Thin fetch wrapper over the `api` Edge Function; attaches the JWT; serves this device's copies offline |
| `offline.js` | What the device keeps (IndexedDB): copies per account, the queue, files, settings |
| `sync.js` | Offline work: send or queue, sync in order, idempotency keys, conflicts, files chosen offline, downloads |
| `notify-ui.js` | The bell: unread count, the notifications list, mark as read |
| `reports-ui.js` | Export reports: the reports this person may export, their filters, Excel / CSV / PDF |
| `export.js` | Writes report files in the browser: Excel (.xlsx), CSV and PDF, no libraries |
| `sync-ui.js` | The sync status in every top bar and the Sync center (Kobo, school data, learning, content, field team devices) |
| `sw.js` / `pwa.js` / `manifest.webmanifest` | The offline app (service worker) and home-screen install |
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

- Emailing notifications through the same mail sender as invitations and
  password resets.
- Recording paper-based exam scores directly, without building an
  assignment.
- Per-row authorisation could move partly into RLS if the app ever needs
  the database reachable by anything other than this one API.
