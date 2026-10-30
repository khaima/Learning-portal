# Dashboard design system

One visual system for every dashboard in the portal: the management
workspaces (Platform, Administration, M&E, Education Team) and the teacher,
school head, field officer and learner pages. It is the portal's existing
system — tokens in `base.css`, components in `app.css`, charts in
`charts.js`, key figures in `kpi.js` — tightened on 27 October 2026 so it
is applied the same way everywhere. Nothing here is a second system:
extend these tokens and classes, don't add new ones beside them.

Companion documents: [DASHBOARD-HIERARCHY.md](DASHBOARD-HIERARCHY.md)
(what goes on each dashboard, in what order) and [CHARTS.md](CHARTS.md)
(which chart answers which question).

## Principles

1. **Programme results first.** Key figures are the largest text on a
   page; headings, charts and notes step down from them.
2. **Colour means something.** One brand colour, neutral surfaces, and
   three status colours with a fixed meaning. Nothing is coloured to
   decorate.
3. **Flat and quiet.** White cards with a thin border on a light neutral
   page. No card shadows, gradients, decorative icons or motion.
4. **Never colour alone.** Every status is also said in words, an arrow or
   an icon; every chart has a key or labels with its numbers.

## Surfaces and lines

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--paper` | `#F6F7F9` | `#0E1730` | The page |
| `--paper-raised` | `#FFFFFF` | `#152142` | Cards, panels, tiles |
| `--paper-sunk` | `#EDF0F4` | `#0A1226` | Empty bar tracks, skeletons, insets |
| `--line` | `#DFE3E9` | `#293659` | Card borders, dividers (1px) |
| `--line-control` | `#8A94A6` | `#6B7896` | Borders of inputs, selects and outline buttons (1px; 3:1 against the card) |

Cards are flat: `border:1px solid var(--line)`, radius 10–12px, **no
shadow**. `--shadow` is only for things that float over the page: menus,
dialogs, toasts, tooltips and the phone drawer. A status edge (an alert,
a figure that needs action) is a 3px left border, never thicker.

## Colour

| Role | Tokens | Means | Never used for |
| --- | --- | --- | --- |
| Brand | `--brand`, `--brand-fg` (text), `--brand-soft` (tint), `--action` / `--action-hover` (solid buttons) | Data, links, buttons, the current page or tab | — |
| Positive | `--success`, `--success-fg`, `--success-soft` | On track, improving, done, target met | Decoration, categories |
| Attention | `--accent`, `--accent-fg`, `--accent-soft` | Needs someone to act, waiting, close to target | Buttons, the current page, labels, categories |
| Negative | `--danger`, `--danger-fg`, `--danger-soft` | Off track, failed, declining, target missed | Decoration, categories |
| Neutral | `--ink`, `--ink-soft`, `--neutral` | Text, "no change", not recorded | — |

- **Text uses the `-fg` shades** (4.5:1 or more on white and on their own
  tint, both themes). Fills and edges use the plain ones.
- **Trends** (`kpi.js` `trendTag`) are green when the change is good and
  red when it is bad — whichever way the number moved — and always carry
  ▲/▼ and the words "Up"/"Down" for screen readers.
- **Orange is attention only.** On 27 October 2026 it was taken off the
  primary buttons, the current menu item, the current tab, the Kobo
  "Open" button, the workspace labels on the learner and field officer
  pages, and the dashed target line on charts.

### Chart colour

| Tokens | Job | Rule |
| --- | --- | --- |
| `--chart-1` | Every single-measure bar and line | Bars are one colour: length tells the rows apart |
| `--chart-target` (= `--ink-soft`) | The dashed target line and its key | A target is a reference, not a warning |
| `--seq-1` … `--seq-4` | Magnitude: heatmap shades, how recently | One hue, dark = more |
| `--band-1` … `--band-4` | Achievement bands, best to weakest | The status colours, because there the colour *is* the judgement (green, blue, orange, red) |
| `--seq-3`, `--chart-1` | A grouped bar's two periods | Earlier lighter, latest brand blue |
| `--cat-1` … `--cat-3` | Reserved: unordered categories in colour (no chart uses them since the donuts went, 27 October 2026) | Blue, cyan, orchid, always in this order; no status hue |

The category colours were chosen with the data-visualisation palette
validator, every pair compared (not only neighbours), against the card
surface:

| | Light (`#FFFFFF`) | Dark (`#152142`) |
| --- | --- | --- |
| `--cat-1` blue | `#284CAC` | `#4B74D8` |
| `--cat-2` cyan | `#1B89A5` | `#33A3B4` |
| `--cat-3` orchid | `#83297E` | `#B545AE` |
| Worst pair, colour-blind (ΔE, target ≥ 8) | 8.5 | 8.1 |
| Worst pair, normal vision (ΔE, floor 15) | 17.2 | 15.5 |
| Contrast with the surface | all ≥ 3:1 | all ≥ 3:1 |

No fourth colour clears both floors without borrowing a status hue. Since
27 October 2026 the portal draws no pies or donuts: the parts of a whole
are bars, each with its count and share (`charts.js` `proportion`), so
these colours are kept only for a future chart that needs them.

## Type

Work Sans for everything on a dashboard; Baloo 2 only for the brand mark,
the page title and the sign-in page. Every size is a token — a component
never sets its own:

| Token | Size | Role |
| --- | --- | --- |
| `--text-kpi-lead` | 2rem (32px) | Headline figures (Executive overview) |
| `--text-kpi` | 1.75rem (28px) | Key figures |
| `--text-page` | 1.5rem (24px) | Page titles |
| `--text-lg` | 1.25rem (20px) | Callout headings |
| `--text-section` | 1.0625rem (17px) | Section headings (`.panel-head h2`) |
| `--text-title` | .9375rem (15px) | Chart and card titles |
| `--text-body` | .875rem (14px) | Body copy, table cells |
| `--text-sm` | .8125rem (13px) | Supporting descriptions, a figure's context line, labels |
| `--text-xs` | .75rem (12px) | Axis labels, legends, captions, tooltips |
| `--text-micro` | .6875rem (11px) | Counters and badges only |

Key figures are always larger than any heading on the page. Weights: 700
for figures and the page title, 600 for headings and chart titles, 400
for text. Numbers that line up use `font-variant-numeric: tabular-nums`.

## The dashboards' colours: Dark or Light, a look for each (30 October 2026)

Every dashboard is drawn in the programme's reference-dashboard colours, at
the programme's request: **Dark (navy) by default**, with a **Dark / Light
button** in the top bar (`dash-mode.js`) that switches every dashboard and is
kept on the device. Only the dashboards change; forms, lists and every other
page keep the portal's own theme. The button shows only on a dashboard.

A dashboard's screen is `.dash-screen` (its section, or its one panel) with
`data-look`; it sets its own tokens (app.css), so every card, chart, ring,
table and finding inside takes them without code of its own.

| Role | Dark | Light |
|---|---|---|
| Screen | `#0A1230` + a glow in the dashboard's two signature colours | `#F4F6FA` + a fainter glow |
| Cards | `#101B3B` (a wash of the card's accent at the top), hairline `#1E2C58` | `#FFFFFF`, hairline `#DFE3E9` |
| Ink | `#F1F4FA`; secondary `#A9B5D1` | the portal's ink |
| Series, in order (`--hub-1…8`) | `#3987e5` `#d95926` `#199e70` `#c98500` `#d55181` `#008300` `#9085e9` `#e66767` | `#2a78d6` `#eb6834` `#1baf7a` `#eda100` `#e87ba4` `#008300` `#6250d6` `#e34948` |

Both series sets are the validated palette, **checked on each mode's card
colour** with the data-visualisation validator (lightness band, saturation,
neighbours told apart by colour-blind readers ΔE ≥ 8.4 dark / 9.1 light, by
everyone ≥ 19.3 / 19.6). Dark: every colour at least 3:1 on the card. Light:
aqua, yellow and magenta are under 3:1, so charts print their values beside
the marks, and yellow is never a bar's colour. The reference image's own
colours were brighter but failed: too light for a dark ground, and its amber
and green look alike to a reader with red–green colour blindness.

**Each dashboard has a look of its own** — two signature colours (the glow,
the mark beside its title) and the order its key figures and cards take their
accents in:

| Look | Dashboards | Signature |
|---|---|---|
| `platform` | Platform overview (Super Admin) | violet → magenta |
| `programme` | Programme Administration: Overview, In detail, Teaching progress | aqua → green |
| `impact` | M&E: Programme impact, Indicators, Data completeness | blue → violet |
| `executive` | Executive overview | blue → aqua |
| `reach` | Reach | aqua → blue |
| `learning` | Learning | green → aqua |
| `teachers` | Teacher development | orange → yellow |
| `field` | Field operations | magenta → orange |
| `resources` | Digital resources, Content usage | violet → blue |

- **Key figures**: each its own accent, in the look's order — a bar across
  the top, a tinted wash, the icon, its picture; a warning figure is orange.
- **Chart cards and panels**: each its own accent, its single-series bars in
  that colour, the title in capitals beside a dot of it. A ring uses the
  series colours in order (up to five parts on the M&E hub).
- **Text stays in the ink colours**; a colour only marks what a thing is.
  Changes keep the status colours (green up, red down) with ▲/▼ and words;
  a health banner keeps its warning colour.
- One scale per chart (CHARTS.md).

## Spacing and grid

| Token | Laptop and up | Phone (≤ 560px) | Use |
| --- | --- | --- | --- |
| `--gap` | 1rem | .75rem | Between cards in a row or grid |
| `--gap-section` | 1.5rem | 1.25rem | Between sections (figures → attention → charts) |
| `--pad-panel` | 1.25rem 1.375rem | 1.05rem 1rem | Inside a panel |
| `--pad-tile` | 1rem 1.125rem | .85rem .9rem | Inside a key figure, chart card or area card |

On a phone the tokens shrink; components don't each carry their own phone
override.

| Width | Key figures (`.stat-row`, `.exec-row`) | Charts (`.chart-grid`) |
| --- | --- | --- |
| Phone (≤ 560px) | Two to a row | One column |
| Tablet (700–1279px) | Three to a row; five figures sit three then two, the two sharing the row | Two to a row where they fit |
| Laptop and desktop (≥ 1280px) | Five or six in one row | Two or three to a row; tables and heatmaps full width |

Wide tables and heatmaps scroll inside their own card; the page itself
never scrolls sideways (checked at 375px on every workspace dashboard).

## Components

| Component | Where | Rules |
| --- | --- | --- |
| Key figure | `kpi.js` `kpiCard` | Title in words (no icon), the value, then one context line. A figure that opens a page shows → and its border darkens when pointed at or focused; nothing moves. A figure waiting on someone (`tone: "warn"`) gets the 3px attention edge and an orange value. |
| Panel | `.panel`, `.pov-panel` | White, 1px border, `--pad-panel`. Heading `--text-section`, no icon. |
| Chart card | `.chart-card` | White, 1px border, `--pad-tile`. Title `--text-title`, description `--text-sm`, axis and key `--text-xs`. |
| Needs attention | `.alert` in a panel or `.attn-section` | One line per kind of problem, a 3px edge in the status colour, the words in its `-fg` shade, and a button to where it is fixed. On the page itself (not in a panel) an alert gets its own white card. |
| Status pill | `.pill` (`.ok`, `.warm`, `.danger`) | A tint and its `-fg` text; always a word, never a colour swatch alone. Plain `.pill` (brand) for labels. |
| Buttons | `.btn-primary`, `.btn-outline` | Primary = `--action` with white text (8.6:1). Outline = white with a `--line-control` border. |
| Live chip | `live.js` | A still dot and the words "Live · updated …"; no pulsing. |
| Brand panels | `.hero-progress`, `.continue-card` | Flat `--panel` blue, no gradient, no shadow. |

## Motion

Only motion that tells the reader something: a loading shimmer on
skeletons, a spinner on a saving button, the sync dot while syncing, and
a brief highlight on a figure that just changed. All of it stops under
`prefers-reduced-motion`. Bars don't grow in, cards don't lift, arrows
don't slide.

## Accessibility

- Text 4.5:1 or more, chart marks and control borders 3:1 or more, in both
  themes — computed for every token pair (27 October 2026: all pass).
- Keyboard: every link, button and filter is reachable with Tab and shows
  a 2px focus outline (`--focus`).
- Nothing relies on colour alone: statuses are words, trends carry ▲/▼ and
  "Up"/"Down", charts have keys with numbers, heatmap cells print their
  counts.
- Automated check: axe-core (WCAG 2.1 A/AA) on the Executive overview,
  Reach, Learning, Field operations, Digital resources and Platform
  overview — no violations.

## Adding to a dashboard

1. Use `kpiCard`, `.panel`, `.chart-card` and the `charts.js` functions;
   don't style a new card by hand.
2. Sizes, colours, gaps and paddings come from the tokens above. If a
   value you need isn't a token, the design probably doesn't need it.
3. Status colour only for a status, with its word beside it. A category
   colour only inside a chart.
4. Check it at 375px, in dark mode, and with the keyboard.
