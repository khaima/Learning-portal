# Charts

Every chart in the portal comes from one small module, `charts.js`, so the
same kind of question always gets the same kind of picture. A chart is
there to help someone understand something; where a number or a table
does that better, there is no chart.

## Which picture for which question

| The question | The picture | In `charts.js` |
| --- | --- | --- |
| How has this changed over time? | A **line** | `lineChart`, `trendOrBars` |
| How do these groups compare? | **Bars**, one colour | `barList` |
| How far towards the target? | A **bar filling towards a line** | `targetList` |
| What share of one whole? (two to four parts) | A **donut** | `donut`, `proportion` |
| What share, on a scale that has an order? | **One bar, split in order** | `stackBar` |
| …the same scale, for several groups side by side (bands by subject)? | **A split bar per group**, one key | `stackRows` |
| How many, in each cell of a grid (a place × a month, a day × a time)? | A **heatmap** | `heatmap` |
| What value, in each cell of a grid (the average mark, a subject × a grade)? | A **heatmap with a scale** — shaded by band | `heatmap(…, { scale })` |
| How are the values spread (each learner's average mark)? | A **histogram** | `histogram` |
| What are the exact figures? | A **table** | — |

Rules that go with them:

- **A line needs three points.** With fewer, the periods are compared as
  bars (`trendOrBars` decides).
- **A donut is only for a simple share:** two to four parts of one whole.
  Five or more become bars, each with its percentage. A whole made of a
  single part is a bar too — a full ring says nothing.
- **Bars are one colour.** Length tells the rows apart. Colour is kept for
  meaning: target met, close or not met; the achievement bands; the parts
  of a donut.
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

Tables with more than three rows sort by any column: press its heading,
again to reverse (`tables.js`). A table drawn again keeps its sort.

## Colour

Defined in `base.css`, for light and dark, and checked with a colour-
blindness and contrast validator against the card surface:

| Tokens | Used for |
| --- | --- |
| `--chart-1` | Every single-measure bar and line. |
| `--chart-2` | The dashed target line on a trend. |
| `--cat-1` … `--cat-4` | The parts of a donut, always in this order (blue, orange, purple, green). A part keeps its colour when another part is empty. |
| `--band-1` … `--band-4` | The four achievement bands, best to weakest. |
| `--seq-1` … `--seq-4` | One hue, strongest to weakest, for an ordered scale (how recently staff signed in) and a heatmap's four shades. |
| `--hm-ink-1` … `--hm-ink-4` | The count printed on each heatmap shade: 4.5:1 or more on its shade in both themes (checked). |
| `--success`, `--accent`, `--danger` | Target met, close, not met. |
| `--neutral` | "No change" in a better / same / worse split. |

Orange and green are never neighbours in a donut: that pair is the
hardest to tell apart for the most common kinds of colour blindness.

## What each chart was, and is

### Programme dashboards (`impact-ui.js`)

| Chart | Before | Now |
| --- | --- | --- |
| Visits by month, Kobo submissions by month, Opens by month | Columns, a number on every one | Line; latest and highest labelled |
| Learner growth, Learner progress, Visits by term, Usage by term | Bars | Line (bars when there are fewer than three terms) |
| Schools / Learners / Teachers / Visits / Kobo submissions by county, Accounts by role, Assignments by subject, Sessions by kind, Visit types, Resources by subject and type | Bars, API order, label squeezed beside the bar | Bars, largest first, each with its share of the total; name and value above a full-width bar |
| Completion by grade, Results by grade, Training by county, Active by county, Teacher activity | Bars on 0–100 with decimals | Bars on 0–100, whole percentages, with the count behind each |
| Marked work by band | A row of pills | One bar split into the bands, with a key |
| Learners' own progress | Three numbers | One bar split improved / steady / declined, with a key |
| Teachers by employment type, Resources by shelf | Bars | Donut (when two to four parts have a value) |
| M&E indicators, target against actual | Bars on different scales, target line in a different place on each row | Every bar fills towards the same target line; value, target and status in words |
| Indicator trend | A large drawing with five gridlines; its labels grew with the screen | Line (actual) and dashed line (target), three gridlines, fixed-size labels |
| Subject, school and form tables | Plain percentages | Percentages with a thin bar, band codes with their full name on hover |

### Executive overview (`impact-ui.js`, 19 October 2026)

Four pictures under Needs attention, computed by the API (`impact.ts`
`overview`):

| Chart | Picture | How to read it |
| --- | --- | --- |
| Field visits by place and month | Heatmap: counties (or, narrowed to a county, its schools — every one, so a school not visited is a row of blanks) × the last 12 months | Darker is more visits; every cell prints its count, a row ends with its total. A county's name narrows the dashboard to it, a school's to that school. |
| Learners' average marks | Histogram: each learner's average on marked work, in tens | Columns on one scale with their counts; coloured by the band each range falls in, with the band totals in the key; the median above. |
| Work handed in | Line by term (bars under three terms) | As on Learning. |
| When the portal is used | Heatmap: day of the week × three-hour block, Kenyan time (EAT) | Resources opened, work handed in and work marked. |

The same four are on the Super Admin's **Overview** (its first page), in a
"Programme at a glance" panel under the activity cards; there a county's
or school's name opens the Executive overview narrowed to it.

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
| One choice, up to four answers | Donut; counts only; colours shifted when an answer had no takers | Donut; count and percentage; fixed colours |
| One choice, five or six answers | Donut | Bars with shares |
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
- A filter that is set looks set (brand border and tint), and the bar
  says in pills what is being shown ("Showing data for Narok County").
- "Clear filters" is idle until there is something to clear.

## Adding a chart

1. Decide what the reader should learn; pick the picture from the first
   table. If it's one number, use a key-figure card (`kpiCard`).
2. Use the function from `charts.js`; don't draw a new kind by hand.
3. Give the card a one-line description.
4. A new colour sequence must pass the validator in both themes before it
   ships.
