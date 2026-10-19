# Dashboard hierarchy

How every dashboard in the portal is laid out, and why. The aim is that
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

## Executive overview (`#overview`)

| Component | Level | Now |
| --- | --- | --- |
| Schools, Learners, Teachers, Completion, Average mark, Data quality | Primary | One row of six tiles. |
| Needs attention | Primary | Straight under the tiles (it was last on the page). Up to four grouped items with a count and a link each. |
| Four pictures (19 October 2026) | Secondary | Under Needs attention: field visits by place × month (heatmap), learners' average marks (histogram, by band), work handed in by term (line), when the portal is used — day × time of day (heatmap). See docs/CHARTS.md. |
| Active users | Secondary | A line in the Reach card (was a tile). |
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
| Counties reached, Schools reached, Learners, Teachers, Gender recorded | Primary |
| M&E indicators — Reach | Primary (when there are any) |
| Schools by county, Learners by county, Teachers by county, Learner growth, Grade distribution | Secondary |
| Learners by gender, Teachers by gender, Accounts by role, Teachers by employment type | Detail |

### Learning (`#learning`)

| Component | Level |
| --- | --- |
| Assignments set, Completion, Average mark, To be marked, Learners improving | Primary |
| M&E indicators — Learning | Primary (when there are any) |
| Completion by grade, Results by grade (with marks by band), Learner progress, Subject performance | Secondary |
| School performance, Assignments by subject, Learners' own progress | Detail |

Removed as duplicates of the tiles: the "Completion" and "Assessment
results" summary cards. What only they showed has moved: "missing" is on
the Completion tile, and the marks-by-band strip is in "Results by grade".

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
| Field visits, Schools visited, Visit forms completed, Form response rate, Kobo submissions, Kobo needing review | Primary |
| M&E indicators — Field operations | Primary (when there are any) |
| Visits by month, Schools not visited yet, Visit types, Visits by county, Kobo submissions by month | Secondary |
| Completed forms, Kobo surveys, Kobo checks, Kobo submissions by county, Visits by term, Forms by audience | Detail |

### Digital resources (`#digital-resources`)

| Component | Level |
| --- | --- |
| Resources, Opens, Usage time, Active users, Learner reach | Primary |
| M&E indicators — Digital resources | Primary (when there are any) |
| Most-used content, Opens by month, Usage by term | Secondary |
| Resources by shelf, by subject, by type | Detail |

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
| Data activity — Kobo submissions counted, data quality score, schools | Primary | A card: each figure with "View Kobo data", "View data quality", "View schools" |
| System activity — Kobo sync, live push, hourly notifications, field devices, access exceptions | Primary | A card: a light per part (working, needs attention, not in use) and its page |
| Important actions — failing health checks, then queues with something in them (Kobo review, high-severity data issues, learners locked out) | Primary | Below the cards, each with Open; passing checks folded away |
| Recent changes — changes per day and the latest five | Secondary | Beside Important actions, with "View audit log" and "Security events" |
| When staff last signed in, staff by role | Secondary | One split bar and one line inside User activity |
| Accounts by role in full, field officers without schools | Detail | On Users & roles; the officers are also named in their health check |

## Administration overview (`#admin-overview`)

Already figures → Needs attention. The six figures now sit in one row
(one used to wrap onto a row of its own), and Needs attention shows its
count.

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
