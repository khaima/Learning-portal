# Charts

Every chart in the portal comes from one small module, `charts.js`, so the
same kind of question always gets the same kind of picture. A chart is
there to help someone understand something; where a number or a table
does that better, there is no chart.

## Which picture for which question

| The question | The picture | In `charts.js` |
| --- | --- | --- |
| How has this changed over time? | A **line** with a fading wash, its latest, highest and lowest points labelled | `lineChart`, `trendOrBars` |
| How many each month or term — is the programme growing? | **Columns**, the value on each cap, the period under way paler | `columnChart(…, { time: true })` |
| How do a few ordered groups compare (grades)? | **Columns** with a dashed line for the overall figure | `columnChart(…, { line })` |
| How do these groups compare (schools, counties, activities)? | **Horizontal bars**, one colour, from zero | `barList` |
| How does each group stand against a line — its approved target, or the overall figure? | **A bar per group with the line across it**: full colour at or past it, paler short of it | `bulletList` |
| How do two periods or groups compare, category by category (last term and this; a baseline and a follow-up)? | **Grouped bars**, side by side on one scale | `groupedBars` |
| How far towards the target? | A **bar filling towards a line** | `targetList` |
| What share of one whole? | **Bars, each with its share** — or, for 2 to 5 parts at a glance, **a ring** with every count and share in its key | `proportion`, `donut` |
| What share, on a scale that has an order? | **One bar, split in order** | `stackBar` |
| …the same scale, for several groups side by side (bands by subject)? | **A split bar per group**, one key | `stackRows` |
| How many, in each cell of a grid (a place × a month, a day × a time)? | A **heatmap** | `heatmap` |
| What value, in each cell of a grid (the average mark, a subject × a grade)? | A **heatmap with a scale** — shaded by band | `heatmap(…, { scale })` |
| How are the values spread (each learner's average mark)? | A **histogram** | `histogram` |
| What are the exact figures, to search, sort or export? | A **table** | — |
| A few headline indicators | **Key-figure cards** | `kpi.js` |
| Where, on a map? | **No map**: four counties, and the portal holds no school locations. A county or school table or heatmap answers "where" until location data is complete. | — |

Rules that go with them:

- **A line needs three points.** With fewer, the periods are compared as
  bars (`trendOrBars` decides).
- **A ring only for a few parts of one whole** (28 October 2026, replacing
  "no pies or donuts" of 27 October at the programme's request for richer
  pictures): 2 to 5 parts (the achievement bands, the library's shelves, how
  teachers are employed), the total in the middle and every part's count and
  share in the key, so nothing is read from an angle alone. More parts, or
  parts to be compared closely, are bars (`donut` falls back to them).
- **Columns carry their value on the cap**; a single hue deepens towards
  the top. The period still under way is paler and outlined, says "so far",
  and is left out of the sentence above.
- **A line across bars or columns is always named** in the key — "All
  schools: 63%", "All grades", or a school's approved target — never
  assumed to be a target. Bars short of an *average* line are paler, not
  red: some are always below an average. Two figures that read the same
  are "on the line", never "0 pts below".
- **Grouped bars for two periods or groups**, side by side per category on
  one scale (0–100 for percentages): the earlier one lighter, the latest
  in the brand blue, a key above. "No data" where a period has too little
  — never a bar at zero.
- **Stacked bars only for parts that can't overlap and add up to a
  meaningful whole** — the achievement bands, how recently staff signed
  in. Activities a teacher can do several of are separate bars.
- **Bars are one colour and start at zero.** Length tells the rows apart.
  Colour is kept for meaning: target met, close or not met; the
  achievement bands; a grouped bar's periods.
- **A long ranked list shows its top 10**, the rest behind "Show all N" in
  the same card — nothing is dropped (`barList` does this for any sorted
  list of more than 12; `targetList` with `top`). Lists with an order of
  their own (grades, terms, answers) are never cut.
- **Largest first** where the groups have no order of their own (counties,
  subjects, visit types). Grades, terms, months and a form's answer
  choices keep their own order.
- **Whole percentages.** 69.5% is shown as 70%.
- **Never a number on every point of a line.** The latest and the highest
  are labelled; the rest are on the axis and in the tooltip.
- **Two gridlines** (the middle and the top) and the baseline. Round
  numbers on the axis; percentages always run 0–100.
- **Two measures, two charts.** Sessions and hours sit one under the
  other, never on two scales in one plot.
- **Too few to compare is said, not ranked.** A heatmap cell (or a subject)
  with fewer than 5 marked pieces of work is printed with an asterisk and a
  dashed edge, and the key says why; rankings leave it out.
- **One measure per axis, no dual axes.** A target is the same measure as
  its actual, so they share a line chart; anything else gets its own chart.
- **A period still under way is marked, not compared.** The current month
  on a monthly line is an open point joined by a dashed line, with a note
  under the chart; the takeaway sentence compares the last two complete
  periods. Content usage's weekly line leaves the running week out.

## Every chart says its question, its period and what stands out

- **The title asks the chart's question or names what it shows**: "Which
  grades hand in their work", "Where and when field visits happened",
  "Field visits, month by month" — not a bare noun ("Completion by grade").
- **A line under the title says what is counted and in what unit** ("% of
  set work handed in", "Visits recorded each month").
- **A chip under that says the reporting period**: the dates the dashboard
  is filtered to ("1 Sep 2026 – 27 Oct 2026", "All time"), or the chart's
  own window ("Last 12 months", "Term by term", "On roll now", "Published
  now", "Every response so far"). The same period is in every tooltip.
- **One sentence above the chart, only where the data supports it**
  (`insight`): the highest and lowest group, ties named together; the
  latest complete period against the one before; the busiest cell of a
  grid; in how many categories the later period is higher. Groups resting
  on fewer than 5 (`base`) are left out of it, and with fewer than three
  groups — or a tie at the top of a grid — there is no sentence. It
  describes; it never gives a cause.
- **Empty, loading and error states** are shared: a shaped skeleton while
  loading, "No visits recorded in Narok County for this period." when the
  filters leave nothing, and the page's "Couldn't load — Try again" on an
  error.

## Reading a chart without hovering, or without colour

- Every value is printed beside its mark, or in the key under it.
- Each chart is described in words for screen readers (all its values).
- Status is always a word as well as a colour ("Met", "Close",
  "Not met", "No data").
- The tooltip repeats what is printed — nothing is only in the tooltip.
  It appears on hover, on a tap (it stays until the next tap or a
  scroll), and on a line chart with the left and right arrow keys once the
  chart has focus.

## Every card says what it shows

A chart card has a title and one line under it on what the chart counts
and how to read it ("Share of the work set that was handed in — not
marks"). A target chart ends with one line: the bar is the actual, the
line marks the target.

## Key figures

Every key figure in the portal is one card, drawn by `kpiCard()` in
`kpi.js`, so it reads the same on every page:

| Part | What it holds |
| --- | --- |
| Icon and title | What is counted, in plain words |
| Value | The figure, large |
| Change | Only where the data has an earlier period to compare with (see below) |
| Context | What the number means: "+11 joined in Term 3", "152 need review", "since Monday · 7 last week" |

**When a card shows a change.** Only for rates and averages that the API
already gives term by term, compared with the term before:
"Term 3: 58% · ▲ +4.8 pts on Term 2" (`periodTrend()`), plus the data
quality score against the scan before. Counts are never given an arrow: a
term or month still under way has had less time, so the latest period and
the one before are shown side by side in words instead ("Term 3 so far: 9 ·
Term 2: 16"). Where there is only one period there is no change; nothing is
estimated. Green is better and red is worse, and the arrow is also said in
words for screen readers ("Up", "Down").

**Clickable or not.** A card that opens a page is a link and looks like
one: an arrow by its title, and when pointed at or focused it lifts, its
border darkens and its title is underlined. A card that opens nothing has
no arrow and stays flat. On the programme dashboards a card links only to
pages the person may open.

**The warning colour** (orange edge and value) is for a figure that is
itself waiting on someone — work to mark, forms to finish, open data
issues, learners locked out. When only the context needs attention ("1 not
in a class", "152 need review") the words carry it and the figure stays
plain.

**One card per idea.** Cards that said the same thing twice were merged:

| Page | Before | Now |
| --- | --- | --- |
| Teacher development | "Active teachers" and "Setting work" | One card; how many set work is its context |
| Field operations | "Kobo submissions" and "Kobo needing review" | One card; the review queue, duplicates and rejections are its context |
| Digital resources | "Active users" and "Learner reach" | One card; the reach is its context |
| Data Quality Center | Open, Under review, Resolved, Ignored, Affected records, Open by severity | Open issues (by severity, being looked at, records affected) and Closed issues |
| Learner home and progress | "To do" and "Overdue" | One card: still open, how many are past the due date, how many were missed |
| School profile | The school head's name as a figure | The name is the context of Teachers |

## Picking a bar or a point

A chart that can take the reader further says so in its description
("Pick a county to see only it") and answers to a click, a tap or the
keyboard:

- **A county's bar** narrows the dashboard to that county (`drill:
  { county }` on the row). When the dashboard already shows one county
  the bars are plain — there's nothing left to narrow.
- **A month or a term on a line** sets the dates to that period
  (`lineChart(…, { drill: true })`; `monthPoints` and `termPoints` give each
  point its period). With the keyboard: step to the point with the arrow
  keys and press Enter.
- **A category whose detail is on another page** opens that page with the
  filter set (`href` on the row): a visit type opens Field visits of that
  type, a subject opens its Assignments, a resource or a subject opens the
  Content library searched for it.
- A chart with a page of its own detail has a line under it leading there
  ("Every visit, newest first →", "Results by grade, in full →").
- **A school** (a heatmap row, a "How each school is doing" row, a school
  not visited) narrows the dashboard to it; the filter bar then offers
  **"School profile →"**: the school's teachers, learners and classes,
  visits, assessments and devices, each tab behind its own permission and
  only for a school in the viewer's area. On the Administration overview a
  school's name in "School by school" opens the profile directly. So:
  programme overview → county → school → its records.

Nothing links where the data has no link: a grade's bar doesn't open a
list of that grade's work (work isn't filed by grade), and there is no
programme filter — schools, learners, work and visits carry no programme;
only the M&E layer does, on its own pages.

## Tooltips

Hovering, tapping or stepping to a mark shows its exact value, what it
counts, the reporting period, and — where there is one — the figure to
read it against: a county's or grade's share beside all counties' or all
grades' (`barList(…, { compare })`), an indicator's target, a period's
note. The Executive overview's headline figures are defined once, under
the charts ("What these figures count"); every chart's description says
what it counts.

## Tables

Tables with more than three rows sort by any column: press its heading,
again to reverse (`tables.js`). A table drawn again keeps its sort.

- **More than 10 rows: a search box** above it (every word must appear in
  the row) and, past 25, **pages** — "Rows 26–50 of 80", Previous page,
  Next page. A sort reorders every row before the page is cut; the search,
  page and sort all survive a live refresh.
- **"Download CSV"** on the detail tables of the programme dashboards,
  Content usage and the Administration overview — for someone with
  `reports.export` only, and only aggregate tables (schools, counties,
  subjects, forms, resources, topics): never a list of learners or
  teachers. It holds exactly the rows the filters and the search leave,
  as the plain text on screen; the file is named for the filters
  (`schools-narok-2026-09-01-to-2026-12-31.csv`). A value a spreadsheet
  would run as a formula is kept as text.

## Colour

Defined in `base.css`, for light and dark, and checked with a colour-
blindness and contrast validator against the card surface:

| Tokens | Used for |
| --- | --- |
| `--chart-1` | Every single-measure bar and line. |
| `--chart-target` | The dashed target line on a trend: grey ink, because a target is a reference, not a warning (was orange `--chart-2` until 27 October 2026). |
| `--seq-3`, `--chart-1` | A grouped bar's two periods: the earlier lighter, the latest brand blue (three periods: `--seq-4`, `--seq-2`, `--chart-1`). |
| `--cat-1` … `--cat-3` | A ring's unordered parts, in this order (blue, cyan, orchid — no status hue; validated, figures in DESIGN-SYSTEM.md); a part that is "Not specified" is `--neutral`. A ring of the bands uses `--band-*`. |
| `--band-1` … `--band-4` | The four achievement bands, best to weakest. |
| `--seq-1` … `--seq-4` | One hue, strongest to weakest, for an ordered scale (how recently staff signed in) and a heatmap's four shades. |
| `--hm-ink-1` … `--hm-ink-4` | The count printed on each heatmap shade: 4.5:1 or more on its shade in both themes (checked). |
| `--success`, `--accent`, `--danger` | Target met, close, not met. |
| `--neutral` | "No change" in a better / same / worse split. |

Until 27 October 2026 the donut used blue, orange, purple and green —
orange and green being the attention and positive colours, and blue and
purple failing the validator; then the donuts went altogether.

## Richer pictures, 28 October 2026

| Dashboard | Chart | Now |
| --- | --- | --- |
| Executive overview | How much set work is handed in, term by term | Columns, the value on each |
| Reach | Learners on roll, term by term | Columns (the roll growing) |
| Reach (more detail) | How teachers are employed | A ring, the counts in its key |
| Learning | Which grades hand in their work | A bar per grade with the all-grades line |
| Learning | Average mark in each grade | Columns with the all-grades line |
| Learning | Where marked work falls (new) | A ring of the four bands |
| Teacher development | Trained / active, by county | A bar per county with the all-counties line |
| Field operations | Field visits / survey records, month by month | Columns (12 months, the month under way paler) |
| Digital resources (more detail) | What the library holds, by shelf | A ring of the three shelves |
| Administration overview | Average mark, school by school | A bar per school with the all-schools line |
| Every page | Key-figure cards | A small picture beside each name; the change on the period before as a badge |

## What each chart was, and is

### Programme dashboards (`impact-ui.js`)

| Chart | Before | Now |
| --- | --- | --- |
| Visits by month, Survey records by month (Kobo records that passed their checks) | Columns, a number on every one | Line; latest and highest labelled. Opens by month moved to Content usage (by week) on 27 October 2026 |
| Learner growth, Learner progress, Visits by term, Usage by term | Bars | Line (bars when there are fewer than three terms) |
| Schools / Learners / Teachers / Visits / Kobo submissions by county, Accounts by role, Assignments by subject, Sessions by kind, Visit types, Resources by subject and type | Bars, API order, label squeezed beside the bar | Bars, largest first, each with its share of the total; name and value above a full-width bar |
| Completion by grade, Results by grade, Training by county, Active by county, Teacher activity | Bars on 0–100 with decimals | Bars on 0–100, whole percentages, with the count behind each |
| Marked work by band | A row of pills | One bar split into the bands, with a key |
| Learners' own progress | Three numbers | One bar split improved / steady / declined; on 27 October 2026 folded into the "Learners improving" tile, which now gives the three counts |
| Teachers by employment type, Resources by shelf | Bars | Donut, then (27 October 2026) bars with shares again |
| M&E indicators, target against actual | Bars on different scales, target line in a different place on each row | Every bar fills towards the same target line; value, target and status in words |
| Indicator trend | A large drawing with five gridlines; its labels grew with the screen | Line (actual) and dashed line (target), three gridlines, fixed-size labels |
| Subject, school and form tables | Plain percentages | Percentages with a thin bar, band codes with their full name on hover |

### Executive overview (`impact-ui.js`, 19 October 2026)

Three pictures under Needs attention, computed by the API (`impact.ts`
`overview`) — four until 27 October 2026, when "When the portal is used"
moved to the Platform overview:

| Chart | Picture | How to read it |
| --- | --- | --- |
| Field visits by place and month | Heatmap: counties (or, narrowed to a county, its schools — every one, so a school not visited is a row of blanks) × the last 12 months | Darker is more visits; every cell prints its count, a row ends with its total. A county's name narrows the dashboard to it, a school's to that school. |
| Learners' average marks | Histogram: each learner's average on marked work, in tens | Columns on one scale with their counts; coloured by the band each range falls in, with the band totals in the key; the median above. |
| Work handed in | Line by term (bars under three terms) | As on Learning. |
| When the portal is used (Platform overview) | Heatmap: day of the week × three-hour block, Kenyan time (EAT) | Resources opened, work handed in and work marked — by programme participants; HPF staff aren't counted. |

The Super Admin's **Overview** (its first page) shows only the last one,
in a "When the portal is used" panel under the activity cards, with a link
to the Executive overview for programme results.

Heatmap rules: one hue, at most four shades plus "none", each shade an
equal run of whole counts named in the key; it is a table (screen readers
read it row by row); on a phone the columns are headed by their short form
(N, D, J… / 0, 3, 6…) and the counts stay in the cells. Month headings
aren't links there — twelve can't be finger-sized; Field operations' line
picks a month.

### Administration overview, area dashboards, results (19 October 2026)

| Where | Added |
| --- | --- |
| Administration overview (`admin-ui.js`, GET /admin/overview → `charts`) | Field visits by place × month (heatmap; a place opens its visits) · Class sizes (histogram of this year's classes by learners, in tens; the last range "60 or more") · Learners per teacher (bars, school by school, active teachers) · Learners by school and grade (heatmap) |
| Reach | Learners by place and grade (heatmap; `reach.gradeByPlace`) |
| Learning | Learners' average marks (histogram, by band) |
| Field operations | Field visits by place × month (heatmap), in place of the bars by county — its last column is the same totals |
| Digital resources | When resources are opened (day × time heatmap; `resources.when`) |
| School head › Assignments & results | The school's marks (histogram; /school/overview `marks`) |
| Any results table shown by learner (teacher's Results, admin's Results) | The learners' marks histogram above the table, from the table's own rows |
| Every table | A column of plain percentages gets a short bar beside each value (`tables.js`, the `cell-rate` look the dashboards' tables already had); the number is still what it sorts by |

One marks histogram everywhere: `charts.js` `marksSpread()` (and
`marksBins()` where the averages are on the page); the API's
`marksHistogram()` in `lms.ts`.

### Survey results (`console.js`)

| Question | Before | Now |
| --- | --- | --- |
| One choice | Donut; counts only; colours shifted when an answer had no takers | Bars with each answer's count and share, in the form's own order |
| Tick all that apply, or a long list | Bars, counts only, an empty bar for every unchosen answer | Bars with each answer's share of everyone who answered; unchosen answers named in one line |
| A number | Four figures and bars | Average, lowest, highest; bars for the spread with shares |

### Platform overview (`admin-ui.js`)

| Chart | Before | Now |
| --- | --- | --- |
| Changes per day | 14 columns in two tints | Line over 14 days, the last seven shaded |
| Who's signing in | A bar in five unrelated colours | One hue from most to least recent; "Never signed in" in the attention colour; counts and shares in the key |

### Data Quality Center (`dq-ui.js`)

The score's sparkline now marks the latest scan and says in words how
many scans it covers and where the score started and ended.

### Unchanged

The platform overview's meters and score sparkline, the learner's
progress ring and the school head's grade progress bars were already the
right form. (The key-figure cards are described above.)

## Filters

- The filter bar above the dashboards and the filters inside a page
  (period, issue type, severity, search) share one look: a small label
  over the control.
- **One filter bar per workspace** — county, school, period — and every
  page that can be narrowed reads it: the Executive overview, the five
  area dashboards, Content usage, the Administration overview (county and
  school: its results are always this term against the same point of the
  last), Schools, Teachers, Assignments, Field visits. No chart has a
  filter of its own.
- A filter that is set looks set (brand border and tint), and the bar
  **always** says what is shown — "Showing data for Narok County × ·
  Term 3, 2026 ×", or "every county and school · all time" with nothing
  chosen — and each dashboard's header repeats it ("Narok County · Term 3,
  2026").
- Charts, key figures and tables are drawn from **one read with one set of
  filters**, so they can't disagree; an answer for filters no longer
  chosen (a refresh on its way when they changed) is dropped, never drawn
  over the new one.
- "Clear filters" is idle until there is something to clear. **"Reset
  view"** also closes every open section and puts every table back as
  first drawn (no sort, search or page).
- On a page where `?school=` is a school's id (its profile, classes,
  assignments, results, learners) the address keeps it, and the school
  filter is left as it was.

## Adding a chart

1. Decide what the reader should learn; pick the picture from the first
   table. If it's one number, use a key-figure card (`kpiCard`).
2. Use the function from `charts.js`; don't draw a new kind by hand.
3. Give the card a one-line description.
4. A new colour sequence must pass the validator in both themes before it
   ships.

## Chart review, 27 October 2026

Every chart on every dashboard, checked against one question: what does it
answer, and is this the clearest picture for it? What changed:

| Page | Chart (title now) | Question it answers | Form | Change |
| --- | --- | --- | --- | --- |
| Executive overview | Where and when field visits happened | Which places were visited, and when? | Heatmap | Title; "Last 12 months"; busiest cell said |
| Executive overview | How learners' average marks are spread | How many learners at each mark? | Histogram | Title; period in tooltips |
| Executive overview | How much set work is handed in, term by term | Is completion rising? | Line (bars under 3 terms) | Title; "Term by term" |
| Reach | Reach in each county | Schools on the portal, learners and teachers per county | Table | Title |
| Reach | Learners on roll, term by term | Is the roll growing? | Line | Title; latest change said |
| Reach | Where learners are, by grade | Grades in each county or school | Heatmap | Title; "On roll now"; largest cell said |
| Reach | How teachers are employed | TSC or BOM? | Donut → bars with shares | No donut |
| Learning | Which grades hand in their work | Completion by grade | Bars | Title; highest and lowest |
| Learning | Average mark in each grade | Marks by grade | Bars | Title; the band strip under it removed — the marks histogram already splits by band |
| Learning | Average mark, term by term | Are marks rising? | Line (bars under 3 terms) | Title |
| Learning | Which subject does best? → Average mark by subject | Subjects, last term and this | Bars → **grouped bars** | Both terms side by side where both have enough marked work |
| Learning (more detail) | How each subject / school is doing | Exact figures | Tables | Titles |
| Teacher development | Share of teachers trained, by county | Training coverage by place | Bars | Title; counties under 5 teachers left out of the sentence |
| Teacher development | What teachers do on the portal | Which activities are common? | Bars (activities overlap: never stacked) | Title |
| Teacher development | Share of teachers active, by county | Activity by place | Bars | Title; its own window ("Last 30 days") |
| Field operations | Field visits, month by month | Are visits keeping up? | Line | The month under way dashed and left out of the comparison |
| Field operations | What field visits were for | Visit types | Bars | Title |
| Field operations | Survey records collected, month by month | Is data collection keeping up? | Line | As visits |
| Digital resources | Which resources are used most | Exact figures | Table | Title |
| Digital resources (more detail) | What the library holds, by shelf / subject / type | The collection | Donut → bars; bars | No donut; "Published now" |
| Content usage | Opens and people, week by week | Is use growing? | Two lines (two measures, two charts) | Latest complete week against the one before |
| Content usage | Which resources are opened most | Ranked resources | Bars, top 8 then "Show all" | Was cut at 8 |
| Content usage | Who opens resources | Learners or staff? | Donut → bars with shares | No donut |
| Content usage | Which schools use the library most | Ranked schools | Bars, top 10 then "Show all" | Was cut at 12 with a pointer elsewhere |
| Content usage | Where time goes, by topic | Topics | Bars | Title |
| Administration overview | Learners per teacher, school by school | Staffing load | Bars, ranked | Title; "On roll now" |
| Administration overview | How big classes are | Class-size spread | Histogram (5+ classes) | Title; "This school year" |
| Attendance | Attendance, day by day | Is attendance holding? | Line | Title; register dates as the period |
| Attendance | Which weekdays learners miss most | The weak days | Bars | Title |
| Attendance | Average mark, by how often learners came | Do the two go together? | Bars | Title; a note that it shows a pattern, not a cause |
| M&E indicator | Actual against target, term by term | On track? | Line with its target (one measure, one axis) | Title |
| M&E indicator | Progress to target in each school | Which schools are behind? | Target bars | Was cut at 25; now the first 25 and "Show all" |
| Survey results | Each question | What did people answer? | Bars with shares (no donuts) | "Every response so far" |
| School head: Learning | How learners' average marks are spread | How the school's marks spread | Histogram | Title; "All marked work so far" (28 October) |
| Results pages (teacher, head, programme) | How learners' average marks are spread | The same, for the results shown | Histogram | The term picked above it is its period (28 October) |
| Data quality center | Score trend | Is the data getting cleaner? | Sparkline | On the score's whole 0–100 scale (it started near the lowest score, so a few points looked like a leap); the scans' dates in its note (28 October) |
| Learner: My progress | Work handed in | How much of my work is in? | Ring → a count and a bar | No donut (28 October) |

Not changed, and why: the platform overview's "When the portal is used"
and sign-in recency (system health, for the Super Admin); key-figure
cards (the headline indicators); detailed tables (searching and sorting).
No maps: the counties are few and school locations aren't held.
