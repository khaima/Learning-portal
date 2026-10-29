# KPI and chart definitions — what each figure counts, from where

Every figure on the impact dashboards, with its source table and fields, its
calculation, its reporting period and filters, and how it says "nothing",
"no data", "not complete" and "couldn't load". Audited against the code and
the production database on 28 October 2026 (results and corrections at the
end). Where a rule is code, the file is named.

All figures are worked out on the server from the database (the `api` Edge
Function); no page calculates them in the browser or holds sample data. Every
read stays inside the viewer's area (`scope.ts`) and the database stays
deny-all behind row-level security.

## 1. Counting rules — one rule each, used everywhere

| What | Counted as | Code |
| --- | --- | --- |
| **A learner** | One `learners` row (unique `id`) with `enrollment_status = 'ACTIVE'` (the column can't be blank; it defaults to ACTIVE) at a school in view (`learners.school_id`). Transferred or withdrawn learners are not on roll. | intelligence.ts, impact.ts, `/admin/overview` |
| **Learners on roll in a term** | Distinct `learner_enrollments.learner_id` enrolled at some point in the term (`enrollment_date` ≤ term end, no `exit_date` before its start). | intelligence.ts `learnerGrowth` |
| **A teacher** | One `profiles` row with `role = 'teacher'` and `status = 'active'` at a school in view (`profiles.school_id`). Pending, suspended and deactivated accounts are not counted. School heads and field officers are counted apart. | same |
| **HPF staff** | Programme Admin (Education Team — role codes `education_team` and `admin`), M&E, Super Admin (`HPF_STAFF_ROLES`). Never counted as programme participants; their library opens are left out everywhere (below). | permissions.ts, readings.ts |
| **A school** | One `schools` row (registered school, unique `id`/`code`). *Reached*: has an active learner or teacher. *Visited*: a field visit linked to it by `school_id`. | intelligence.ts |
| **A field visit** | One `field_reports` row, dated by `created_at`. A visit typed against a school name that isn't a portal school (`school_id` empty) counts as a visit, never as a school visited. | intelligence.ts |
| **Attendance** | Marks on a class's daily register (`attendance_marks`): rate = (present + late) ÷ all marks, excused absences included in the whole. A learner is followed up below 90% (with 5+ days marked) or after 3 absent days running. | attendance.ts |
| **Teacher trained** | An active teacher with `training_attendance.attended = true` at a session (`trainings`, not archived) held in the period. *No sessions in the register at all* is **no data**, not 0%. | impact.ts `training.recorded`, admin_impact.ts |
| **Resource use (a library open)** | One `library_interactions` row, dated by `started_at`, **not by HPF staff** (the role recorded on the open, or the reader's role now). *Readers*: distinct `actor_id`. *Time*: sum of `duration_seconds` where recorded — an open with no time adds nothing. *School*: the name recorded when it is a registered school's, else the reader's linked school now, else unattributed (in "every school" totals only). | readings.ts |
| **Assessment outcome (classwork)** | A marked `assignment_submissions.percentage`. *Average mark* = mean of every marked piece in view; *marks spread* = each learner's own average, in tens; *bands* from `grade_bands`. Teacher-marked classwork — not a standardised assessment, and not compared term to term as a change in learning (different work each term). | lms.ts, intelligence.ts |
| **Work set / completion** | Each published or closed assignment once per learner expected to do it (enrolled in its class between its start and due date) = a *piece of work set*. *Handed in*: submission `submitted` or `marked`. Completion = handed in ÷ set, **including work not yet due** (so a term under way reads lower until due dates pass). *Missing*: not handed in and past due or closed. | lms.ts `expectedFrom`, `summarize` |
| **A form response** | Distinct respondents among the **active staff the form was sent to** (its role, its county, the county chosen); for a visit form, distinct visits in view with that form filled. Never an answer from outside the count it is divided by. | intelligence.ts `responseRates` |
| **A Kobo survey record** | One `kobo_records` row of an active survey that **passed its checks** (`status = 'valid'`) or was accepted on review. Failing, duplicate and Kobo-rejected records are counted apart, never as results. A record naming no portal school is in the totals only. | kobo_pipeline.ts `counts` |
| **An approved target** | An `me_targets` row for the indicator, period and place — a county's or school's own target, or the whole programme's for the whole programme only. **No default targets exist anywhere.** The 50% / 10-piece "needs support" lines are rules for flagging schools, labelled as rules, not targets. | me.ts `targetFor`, insights.ts |

## 2. Periods and filters

- **Filters**: county, school (by name; `?school=` is an id only on pages that
  belong to one school), and a date range where a page has one. Every figure on
  a page comes from one read with one set of filters.
- **Date range (impact dashboards)**: a row counts when its own date falls in
  it — assignments by `due_at` (else `published_at`), submissions through their
  assignment, visits and library opens by their start, forms by `submitted_at`,
  Kobo by `submitted_at`, trainings by `held_on`. "All time" = no date filter.
- **Active users / "used the portal"**: the date range chosen, else **the last 30 days**.
- **Administration overview results**: always **the current term so far**,
  compared with **the same number of days into the term before**; "learners
  reached" is the roll today and isn't compared.
- **Key findings**: the term the chosen period ends in, else the current term (docs/INSIGHTS.md).
- **Charts by month**: the last 12 months; the current month is drawn as unfinished.

## 3. Nothing, no data, not complete, couldn't load

| State | Means | Shown as |
| --- | --- | --- |
| **Zero** | Records exist and none qualify — e.g. work set, none handed in | `0` / `0%` |
| **No data** | Nothing to count yet — no work set, nothing marked, no training register, no forms sent, no approved target | "—" / "No data" / a sentence saying what's missing — never `0` |
| **Not complete** | The period is still running ("so far"), a Kobo sync failed (the survey's newest records may be missing), records not linked to a school (in totals, not in county views), work not yet marked | said beside the figure |
| **Couldn't load** | A database read failed | an error with **Try again** — never a page of zeros (the Administration overview now checks every read) |

## 4. Freshness

- Every dashboard shows when it last loaded successfully ("Live · updated …"),
  and keeps the last good figures (saying it couldn't refresh) if a refresh fails.
- The figures are worked out at that moment from the database (`generatedAt` on
  each read); portal records are live.
- **Kobo**: Field operations and the Executive overview's Field operations card
  say when the surveys last synced, and say so plainly when the last sync failed
  (`kobo_forms.synced_at`, `last_sync_error`).
- The Data quality centre records each scan (`dq_scans`); device sync is on the Sync page.

## 5. The dashboards, figure by figure

Source tables are `public.*`. "In view" = the viewer's area, narrowed by the county/school chosen.

### Executive overview (`#overview`, impact.ts → `executive`)
| Figure | Calculation | Source |
| --- | --- | --- |
| Schools | registered schools in view · visited (in the period) · coverage = visited ÷ schools | schools, field_reports.school_id |
| Learners | learners on roll · joined this term · used the portal (last 30 days or period) ÷ on roll | learners, learner_enrollments, submissions, library_interactions |
| Teachers | active teachers · trained ÷ teachers ("training not recorded yet" with no register) · active ÷ teachers | profiles, training_attendance, assignments, submissions, library_interactions, responses |
| Completion | handed in ÷ set (see rules) · trend by term | assignments, assignment_submissions, learner_enrollments |
| Average mark | mean marked % · pieces marked · band | assignment_submissions.percentage, grade_bands |
| Key findings | docs/INSIGHTS.md | — |
| Visits by place × month | visits per county (or school) per month, last 12 months | field_reports |
| Marks spread | each learner's average marked %, in tens | assignment_submissions |
| Handed in, term by term | completion per term | as Completion |

### Reach (`#reach`)
Counties reached (with an active learner or teacher) of counties with schools ·
schools reached of registered · learners · teachers · reach in each county
(table) · learners on roll by term (`learner_enrollments`) · learners by place
and grade · gender of learners and teachers (`gender`, where recorded; groups
under 5 shown as <5) · teacher employment (`teacher_type`).

### Learning (`#learning`)
Assignments set (published + closed; drafts apart) · completion · average mark ·
to be marked (`status = 'submitted'`) · learners improving (learners with marks
in two terms, first term's average vs latest — different work each term, so not
a like-for-like test) · completion and average by grade · marks spread · average
by term · which subject does best (lms.ts `compareResults`, needs enough marked
work per cell) · subjects and schools tables · work set by subject.
*Kobo learner assessments are not in these figures (see limitations).*

### Teacher development (`#teacher-development`)
Teachers · trained (no data without a register) · using digital resources
(opened a Digital Library or Teacher Resources item in the period) · active
teachers (set or marked work, opened a resource or answered a form) · teacher
support visits (`visit_type = 'Teacher support'`) · trained by county · sessions
by kind · what teachers do on the portal (each share of active teachers) ·
active by county.

### Field operations (`#field-operations`)
Field visits (by active officers reporting, of active officers; visits not
linked to a portal school said) · schools visited ÷ schools · visit forms
completed (visits with their form ÷ visits) · form response rate (rule above;
"No forms sent to staff yet" when none) · survey records (Kobo, counted; records
naming no portal school said) · visits by month · schools not visited · visit
purposes · visits by place × month · survey records by month and county · forms
answered of those sent. Source line: when Kobo last synced, or that it failed.

### Digital resources (`#digital-resources`) and Content usage (`#content-usage`)
Resources published (`library_items.published`) · opens · usage time (recorded
durations) · active readers (learners / staff) · most used · library holdings by
shelf, subject, type. Content usage (library_usage.ts) adds periods, roles,
day × time, by school and by topic — **from the same prepared opens** (readings.ts),
so its totals equal the dashboards'; HPF staff opens are shown apart.

### Administration overview (`#admin-overview`, admin_impact.ts)
Learners reached (on roll) · learners taking part (started or handed in work, or
opened a library resource, this term ÷ on roll) · teachers trained (this term;
no data without a register) · teachers teaching digitally (published an
assignment this term ÷ active teachers) · schools supported (visited this term ÷
schools) · average mark on marked classwork (this term; "too few" under 30
pieces) · teachers using digital resources (In detail). Each against the same
point of the term before, and an approved target only where M&E set one for the
same portal measure. Pictures: learners by county (or school), marks spread,
average mark by school (10+ marked), progress against approved targets.

### M&E (`#me-dashboard`, me.ts)
Each indicator's value for the period and place: its **verified or recorded
actual**, else worked out live from its source (portal measure or Kobo form) —
the row says which — against the **approved target** for that place and period
(`targetFor`: the place's own, else the programme's only for the programme
view); achievement % = actual ÷ target (target ÷ actual for indicators meant to
go down); met ≥ 100%, close ≥ 80%.

## 6. Production data audit, 28 October 2026

Read-only queries against the learning portal's database (counts only; no personal data copied).

| Check | Result |
| --- | --- |
| Duplicate schools (name, code); schools without a county; county spellings | none — 24 schools, 4 counties, all consistent |
| Staff linked to a missing school; teachers/heads without a school; county or school name disagreeing with the linked school | none |
| Learners: missing or wrong school, class at another school, duplicates, more than one active enrolment, exit before entry | none (2 learners) |
| Field visits | 2, both to "Narok Grace Primary" — **not a registered school** (no `school_id`) |
| Library opens | 43: **22 by HPF staff**; **16 recorded under "meru"** (a stale name) instead of the readers' school, Olesere; 5 with no time recorded; no future dates, no repeats |
| Kobo survey records | 1,127 (May–Sep 2026), synced today; **880 fail their checks**: 879 because the school named isn't a portal school — "Honore Intervention School (Treatment)" 498, "Comparison School (Control)" 231, "Ilkerin primary school" 105, "Ilmonchin primary school" 44; 2 missing required answers. 919 name no school. No duplicates, no impossible dates. |
| Training register | 4 sessions, **all archived** (identical "cluster, 7 Oct"); 2 attendance rows on them |
| M&E | 1 programme, 1 outcome, **no indicators or targets**; 1 **final** report for 2026 Term 3 made on 8 Oct with no indicators (final reports can't be changed) |
| Classes | 1, archived; the 2 learners aren't in a class |

## 7. Corrections made (28 October 2026)

Each has a test that fails on the code before it (data_accuracy_test.ts, data_accuracy_api_test.ts, readings_test.ts).

1. **Library opens under a stale school name** were dropped from every county and
   school view (16 of 21 programme opens in production). They now count at the
   reader's linked school; a registered name recorded at the time is kept.
   The stored rows are not changed (readings.ts), and new opens record the
   school by its registered name from the account's `school_id`.
2. **The library export counted HPF staff's own opens** (22 of 43 in
   production) while every dashboard left them out. It now uses the same rule —
   dashboards, Content usage and the export give the same total.
3. **Form response rates** counted answers from people outside the expected
   audience (another county's teachers under a county filter, deactivated
   accounts), capping at 100%. Received is now counted only among those it is
   divided by (e.g. Narok: 1 of 2 teachers = 50%, was shown 100%).
4. **Officers reporting** counted officers who are no longer active against the
   number of active officers ("2 of 1"). Now active officers only; the Kobo
   officer completion follows the same rule.
5. **No training register read as 0% trained** on the Executive overview and
   Teacher development, while the Administration overview said "No data". All
   now say no sessions are recorded; one rule (`training.recorded`).
6. **A failed read on the Administration overview showed as zeros** ("0
   teachers", "nothing needs attention"). It now returns an error with Try again.
7. **Incomplete data is said**: visits and Kobo records not linked to a portal
   school, Kobo's last sync time, and a failed sync.

## 8. Remaining limitations

- **Learning outcomes from the endline assessments aren't on any dashboard.**
  The Honore and SUMMA endline records name schools that aren't portal schools
  (Honore's are labelled Treatment and Control — an evaluation design); until
  M&E registers the programme schools or maps them (Kobo Surveys → school name
  matches), and sets up Kobo-sourced indicators, they stay out. Control-school
  learners must never be counted as programme reach.
- **Production volumes are pilot-sized** (2 learners, 1 active teacher, no
  assignments): the dashboards are correct for what's recorded, but it isn't yet
  programme-scale evidence. Records that look like set-up tests — the 4 archived
  training sessions, the 2 visits to "Narok Grace Primary", the final Term 3 M&E
  report with no indicators — are not deleted; the training sessions are already
  excluded, the visits are labelled "not linked to a portal school". Someone who
  knows the programme should confirm them.
- **No M&E targets are set yet**, so no figure shows target achievement.
- Completion includes work not yet due (a term under way reads lower); average
  mark is teacher-marked classwork.
- Library time is only what the device recorded; opens without a time add nothing.
- "Ololomei." has a full stop in its registered name (shown as entered).
