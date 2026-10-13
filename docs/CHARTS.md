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

## Colour

Defined in `base.css`, for light and dark, and checked with a colour-
blindness and contrast validator against the card surface:

| Tokens | Used for |
| --- | --- |
| `--chart-1` | Every single-measure bar and line. |
| `--chart-2` | The dashed target line on a trend. |
| `--cat-1` … `--cat-4` | The parts of a donut, always in this order (blue, orange, purple, green). A part keeps its colour when another part is empty. |
| `--band-1` … `--band-4` | The four achievement bands, best to weakest. |
| `--seq-1` … `--seq-4` | One hue, strongest to weakest, for an ordered scale (how recently staff signed in). |
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

Stat tiles, the platform overview's meters and score sparkline, the
learner's progress ring and the school head's grade progress bars were
already the right form.

## Filters

- The filter bar above the dashboards and the filters inside a page
  (period, issue type, severity, search) share one look: a small label
  over the control.
- A filter that is set looks set (brand border and tint), and the bar
  says in pills what is being shown ("Showing data for Narok County").
- "Clear filters" is idle until there is something to clear.

## Adding a chart

1. Decide what the reader should learn; pick the picture from the first
   table. If it's one number, use a stat tile.
2. Use the function from `charts.js`; don't draw a new kind by hand.
3. Give the card a one-line description.
4. A new colour sequence must pass the validator in both themes before it
   ships.
