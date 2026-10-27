# Dashboard hierarchy

How every dashboard in the portal is laid out, and why. How it looks —
colours, type, spacing, components — is in DESIGN-SYSTEM.md. The aim is that
someone opening a dashboard can **see** the situation, **understand** it,
**decide** and **act** — in that order, without reading every card first.

## The three levels

Every component on a dashboard is one of three things.

| Level | What it is | Where it goes |
| --- | --- | --- |
| **Primary** | What the person needs straight away: the key figures, and what needs doing about them. | The first screen. |
| **Secondary** | What they look at next: the few charts and lists that explain the figures. | Below, open. |
| **Detail** | Long tables, narrower breakdowns, a page's own explanation. | One click away: a closed "More detail" section, or the page the "View all" link opens. |

Rules that follow from this:

1. **One row of key figures**, then **what needs attention**, before any
   chart.
2. **A figure appears once.** If a tile shows it, a card below doesn't
   repeat it; anything extra the card had moves into the tile.
3. **Attention items are grouped.** One line per kind of problem — how
   many, which ones, and a link to where it's dealt with — the pressing
   ones first. Not one line per school or per form.
4. **Detail is closed, not removed.** "More detail" says what's inside
   it, stays open once opened (through a refresh or a change of filters),
   and everything in it still updates.
5. **Nothing is claimed that wasn't read.** An item such as "KoboToolbox
   not connected" shows only once the settings have been read; a failed
   read says so rather than showing an empty or reassuring panel.
6. **Programme dashboards show the programme, not the system** (27 October
   2026, after the dashboard audit). Their figures count programme
   participants only — learners, teachers, school heads and field
   officers. HPF staff (Education Team, M&E, Admin, Super Admin) opening a
   resource to check it or trying a form are left out everywhere and said
   once in a line (`HPF_STAFF_ROLES`, `PROGRAMME_STAFF_ROLES` in
   permissions.ts). When the portal is used, sync and pipeline checks
   belong to the Platform overview and the Kobo surveys page.
7. **Each programme dashboard names its source** in one line at its foot
   ("Source: …"), and says what isn't included yet.
8. **Too little to draw is said in a sentence.** A spread of three classes
   or a heatmap of mostly empty rows isn't drawn; the sentence says how
   many there are, and empty rows are left out with a note saying how many.

## Executive overview (`#overview`)

| Component | Level | Now |
| --- | --- | --- |
| Schools, Learners, Teachers, Completion, Average mark, Data quality | Primary | One row of six tiles. |
| Needs attention | Primary | Straight under the tiles (it was last on the page). Up to four grouped items with a count and a link each. |
| Three pictures (19 October; 27 October 2026) | Secondary | Under Needs attention: field visits by place × month (heatmap), learners' average marks (histogram, by band), work handed in by term (line). "When the portal is used" (day × time of day) moved to the Platform overview: it describes the system, not the programme. See docs/CHARTS.md. |
| Active participants | Secondary | A line in the Reach card (was a tile): learners and school and field staff active in the period; HPF staff aren't counted. |
| Field visits, Kobo submissions | Secondary | Lines in the Field operations card (were tiles; field visits was also already in the card). |
| Library use | Secondary | A line in the Digital resources card (was a tile). |
| Six programme areas (Reach, Learning, Teacher development, Field operations, Digital resources, M&E) | Secondary | Under a "Programme areas" heading, three to a row. |
| Each area's charts and tables | Detail | The area's own dashboard, from its card. |

## Programme dashboards

The same order on all five: key figures → M&E indicators tagged for the
page (target against actual) → the main charts → **More detail**. Where
no indicator is tagged for a page, the note about choosing some sits at
the foot instead of the top. A page needing one line to be read right
(Learning: completion and results are separate) shows it under the
filters; the others have none (docs/NAVIGATION.md §21).

### Reach (`#reach`)

| Component | Level |
| --- | --- |
| Counties reached, Schools on the portal, Learners, Teachers | Primary |
| M&E indicators — Reach | Primary (when there are any) |
| By county (one table: schools on the portal of all schools, learners, teachers; a county's name narrows the page to it), Learner growth, Learners by place and grade | Secondary |
| Learners by gender (with how many have it recorded), Teachers by gender, Teachers by employment type | Detail |

27 October 2026: the three county bar charts became one table; the
"Gender recorded" tile moved into the gender card's caption; "Accounts by
role" left (it's an account count, on Users & roles).

### Learning (`#learning`)

| Component | Level |
| --- | --- |
| Assignments set, Completion, Average mark, To be marked, Learners improving | Primary |
| M&E indicators — Learning | Primary (when there are any) |
| Completion by grade, Results by grade (with marks by band), Learners' average marks, Learner progress, Which subject does best? | Secondary |
| Subject performance, School performance, Assignments by subject | Detail |

Removed as duplicates of the tiles: the "Completion" and "Assessment
results" summary cards. What only they showed has moved: "missing" is on
the Completion tile, and the marks-by-band strip is in "Results by grade".
27 October 2026: "Learners' own progress" (improved · steady · declined)
was the "Learners improving" tile again — the three counts are now on the
tile. The source line says Kobo learner assessments aren't included yet.

### Teacher development (`#teacher-development`)

| Component | Level |
| --- | --- |
| Teachers, Trained, Using digital resources, Active teachers, Setting work, Teacher support visits | Primary |
| M&E indicators — Teacher development | Primary (when there are any) |
| Training by county, Sessions by kind, Teacher activity, Active by county | Secondary |
| Training register | Secondary (its own panel below, unchanged) |

Removed as a duplicate of a tile: the "Digital resource use" summary
card. "Teacher Resources opened" is now on the "Using digital resources"
tile.

### Field operations (`#field-operations`)

| Component | Level |
| --- | --- |
| Field visits, Schools visited, Visit forms completed, Form response rate, Survey records | Primary |
| M&E indicators — Field operations | Primary (when there are any) |
| Visits by month, Schools not visited yet, Visit types, Field visits by place and month, Survey records by month | Secondary |
| Completed forms, Survey records by county | Detail |

27 October 2026: "Survey records" counts the Kobo records that passed
their checks (or were accepted on review), from active surveys — and the
by-month and by-county charts count exactly those, so they add up to the
figure. Duplicates, records waiting for review and rejections are pipeline
health: they're on the Kobo surveys page, linked from the source line.

### Digital resources (`#digital-resources`)

| Component | Level |
| --- | --- |
| Resources, Opens, Usage time, Active users | Primary |
| M&E indicators — Digital resources | Primary (when there are any) |
| Most-used content, Usage in detail (a link to Content usage) | Secondary |
| Resources by shelf, by subject, by type | Detail |

27 October 2026: opens over time, when resources are opened and usage by
term live on Content usage, once; this page keeps the summary.

### Content usage (`#content-usage`)

Who opens the library's resources, how often, when and for how long
(GET /library/usage, worked out in `library_usage.ts`; the page is
`usage-ui.js`). County, school and dates narrow it like the other
dashboards; it refreshes itself while open.

| Component | Level |
| --- | --- |
| People reached (learners · staff), Opens, Time spent (with the typical open), Resources used (of those published) — each count with the last 30 days beside the 30 before, in words, when no dates are chosen | Primary |
| Needs attention: resources usually closed within 30 seconds (judged only with 5 or more timed opens), published resources not opened, schools gone quiet (nothing in 30 days), schools that never opened one | Primary |
| Opens and people over time (whole weeks; a month at a time over a long range; the week under way said in words), Most used resources, Who opens resources (by role), When resources are opened (day × time, Kenyan time), Schools compared, Time by topic | Secondary |
| Every resource opened, Not opened, Every school, Topics and sub-topics — all sortable | Detail |

A school's bar narrows the page to that school, a week to that week, a
resource opens the library searched for it. Opens by HPF staff checking
content are left out of every figure; the footer says how many.

### M&E dashboard and Data Quality Center

Order unchanged — both already lead with their summary. Each has one
line under the filters: where to record actuals; that nothing is deleted.

## Platform overview (`#platform-overview`)

The Super Admin's command centre (14 October): one line on the platform's
state, a summary of each part with a link to where the detail lives, then
what is waiting on someone beside what changed last. No full lists — every
list has its own page. On a laptop: the status line, three summary cards,
then Important actions (wide) beside Recent changes. Narrower: two cards to
a row, then one column.

| Component | Level | Now |
| --- | --- | --- |
| Platform status — "N health checks need attention", checks passing, queues waiting, the API's release | Primary | A line across the top, with "Review N actions" |
| User activity — staff accounts, signed in this week, learners | Primary | A card: each figure with "View users", "View account activity", "View learners" |
| Data activity — Kobo submissions counted, data quality score | Primary | A card: each figure with "View Kobo data", "View data quality" (schools left on 27 October: a programme figure, on the Administration overview) |
| System activity — Kobo sync, live push, hourly notifications, field devices, access exceptions | Primary | A card: a light per part (working, needs attention, not in use) and its page |
| Important actions — failing health checks, then queues with something in them (Kobo review, high-severity data issues, learners locked out) | Primary | Below the cards, each with Open; passing checks folded away |
| Recent changes — changes per day and the latest five | Secondary | Beside Important actions, with "View audit log" and "Security events" |
| When the portal is used — resources opened, work handed in and marked, by day × time of day (Kenyan time) | Secondary | One heatmap, moved here from the Executive overview on 27 October; a link leads to the Executive overview for programme results |
| When staff last signed in, staff by role | Secondary | One split bar and one line inside User activity |
| Accounts by role in full, field officers without schools | Detail | On Users & roles; the officers are also named in their health check |

## Administration overview (`#admin-overview`)

For the administrator who organises the programme: figures → Needs
attention → a few pictures of how it's organised (rebuilt 27 October 2026
after the dashboard audit; GET /admin/overview, `adminOverviewHtml` in
admin-ui.js).

| Component | Level | Now |
| --- | --- | --- |
| Schools (counties · classes), Teachers (school heads), Learners (at N schools), Field officers (N with assigned schools), Field visits this term (at N of all schools) | Primary | Five tiles in one row on a laptop; three then two on a tablet. "Open forms" left: an unanswered form is a gap, below. |
| Needs attention — accounts waiting, schools without an active teacher, schools without a head, field officers without schools, Kobo submissions to review, high-severity data issues, schools not visited this term, teachers not teaching a class, learners not in a class, open forms with no responses | Primary | One line per kind with the schools or forms it names (four, then "and N more") and the page where it's fixed; the ones holding something up first |
| Learners per teacher (schools with an active teacher only), Class sizes (a histogram from five classes; a sentence below that), Learners by school and grade (schools with learners only) | Secondary | Each says what it leaves out and where that is |

Field visits by place and month left this page: they're on the Executive
overview and Field operations, and the gap they show is the "not visited
this term" line.

27 October 2026, impact focus: the page now leads with **Programme results**
for the current term (GET /admin/overview → `results`, worked out by
`admin_impact.ts` on top of buildImpact, so each figure is the one on the area
dashboards): learners reached, learners taking part, teachers trained,
teachers teaching digitally (setting work), schools supported (visited),
average mark on marked classwork and teachers using digital resources.
Each shows its period, what it counts and what it doesn't, the same number
of days into the term before, and a target only where an M&E indicator for
that portal measure has an approved one for the term (whole-programme
targets; an admin sees these headline figures without `me.view` or
`intelligence.view` — no permission changed). A figure with nothing behind
it says "No data", never 0; taking part and resource use are never called
learning outcomes. Then progress against all M&E targets, **Schools needing
support** (one line per rule) and a folded school-by-school table. The
organising figures and gaps above follow under "Programme organisation";
Kobo review and high-severity data issues moved into a folded "Data checks
waiting" (data operations, not results). System diagnostics stay on the
Platform overview (Super Admin).

## School head (`leader.html`)

| Component | Level | Now |
| --- | --- | --- |
| Learners, Teachers, Grades running | Primary | Tiles. |
| Work handed in, Average mark | Primary | Tiles in the same row, each opening Learning (were the "Learning activity" panel). |
| Attention required | Primary | Straight under the tiles (it was the last of seven panels). Forms awaiting a response are one grouped item. |
| Education Team forms | Primary | Next: the forms to file. |
| School reporting status | Secondary | A status line beside the "Education Team forms" heading (was its own panel repeating the same count). |
| Field visits | Secondary | Below. |
| Resources for school leadership | Detail | Last; "View all" opens the library. |

## Teacher (`teacher.html`)

| Component | Level | Now |
| --- | --- | --- |
| My learners, Work to mark, Handed in this week, Resources used | Primary | Tiles. |
| Work to mark | Primary | First panel. Its search box shows only when there is work to search. |
| My classes | Primary | Second. |
| Recently marked | Secondary | Third (was after Learner activity). |
| Learner activity | Secondary | The first six learners; the rest by search or "Manage learners" (it listed every learner). |
| Teacher resources, Digital Library | Secondary | One "Learning resources" panel (were two panels with the same "View all"). |
| My learning activity | Detail | Closed, at the foot of "Learning resources"; "Full activity" inside. |

## Learner (`learner.html`)

| Component | Level | Now |
| --- | --- | --- |
| Continue learning | Primary | First. |
| Assignments to do | Primary | Second (was third). |
| Learning progress | Secondary | Third. |
| Recommended for you | Secondary | Fourth. |
| Recent activity | Detail | Fifth; "View all" opens the full list. |
| My classes | Detail | Last. |

## Field officer (`field.html`)

Unchanged: figures, then "What to do".

## Adding to a dashboard

- Decide the level first. A new figure is primary only if someone would
  act on it today; otherwise it belongs in a chart, or in "More detail".
- Don't show a number twice on one page.
- A new kind of problem is a new *grouped* item in "Needs attention",
  with a link to where it's fixed.
- In `impact-ui.js`, detail cards go inside `more(…)`; the M&E slots are
  `melFirst(theme)` and `melLast(theme)`.
