/* ============================================================
   HPF Digital Learning Portal — the charts.

   One small set, used on every dashboard, so the same kind of question
   always gets the same kind of picture (docs/CHARTS.md):

     a measure over time      lineChart    a line — never a number on every point;
                                           a period still under way is dashed
     comparing groups         barList      horizontal bars, one colour, from zero;
                                           a long ranked list shows its top 10
                                           and "Show all"
     parts of one whole       proportion   the same bars, each with its share
                                           (no pies or donuts)
     two periods or groups    groupedBars  bars side by side per category —
                                           baseline and follow-up, last term and this
     progress to a target     targetList   a bar that fills towards a marked line
     an ordered scale         stackBar     one bar, split in order (stackRows: one per group)
                                           — only parts that can't overlap and add up
     counts on a grid         heatmap      a table of cells, one hue light → dark
                                           (scale: a measure in each cell — average marks)
     how values spread        histogram    columns side by side, one scale
     columns and a line       comboChart   one scale: measures of the same kind
     two measures per group   scatter      one dot per group; dashed overall figures
     detailed values          a table      (not here)

   Every chart can carry its reporting period (`period`: in each tooltip;
   periodChip() prints it in the card's head) and, with `insight`, one plain
   sentence the data supports — the highest and lowest, the latest change —
   never a cause. Groups resting on fewer than five (a row's `base`) are left
   out of that sentence.

   Each chart is an HTML string, like the rest of the portal. It can be
   read without colour and without hovering — values are printed beside
   the marks and the whole picture is described for screen readers — and
   it adds a tooltip on hover, on a tap, and with the arrow keys.
   No library: a dashboard stays light on a slow connection.
   ============================================================ */

import { esc } from "./util.js";

const num = (v) => (v == null ? "—" : Number(v).toLocaleString());
const round1 = (v) => Math.round(v * 10) / 10;
/** "70%", "1,204", "3.5 hrs" — whole percentages: a decimal there is noise. */
const show = (v, unit = "") => (v == null ? "—" : unit === "%" ? `${Math.round(v)}%` : `${num(round1(v))}${unit}`);
const share = (v, total) => (total ? Math.round((v / total) * 100) : 0);

/** What a mark says when it's pointed at: a title, then value–label rows
    (`[value, label, colour?]`), then a note. Carried as data, drawn with
    textContent — labels come from people (school names, survey answers). */
const tip = (title, rows = [], note = "") => ` data-tip="${esc(JSON.stringify([title, rows.map(([v, l, c]) => [v, v === "1" && /[^s]s$/.test(l || "") ? l.slice(0, -1) : l, c]), note]))}"`;

const none = (msg = "Nothing recorded yet.") => `<div class="chart-empty">${esc(msg)}</div>`;
/** A share or rate resting on fewer than this many isn't put into words. */
const MIN_BASE = 5;
const day = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** The dates a chart covers: "1 Sep 2026 – 27 Oct 2026", "Up to 30 Sep 2026", "All time". */
export function periodLabel({ from = null, to = null } = {}) {
  if (from && to) return `${day(from)} – ${day(to)}`;
  if (from) return `From ${day(from)}`;
  if (to) return `Up to ${day(to)}`;
  return "All time";
}
/** A chart's reporting period, for its card's head. */
export const periodChip = (period) => (period ? `<span class="chart-period">${esc(period)}</span>` : "");
/** The one sentence a chart's data supports, above the chart. */
const insightLine = (text) => (text ? `<p class="chart-insight">${esc(text)}</p>` : "");
const withPeriod = (note, period) => [note, period].filter(Boolean).join(" · ");
/** "visits" for 1 → "visit" (not "people"). */
const nounFor = (v, noun) => (v === 1 && /[^s]s$/.test(noun || "") ? noun.slice(0, -1) : noun);
/** "Grade 4", "Grade 4 and Grade 5", "A, B and C", "4 groups" — every row that ties. */
const names = (rows) => (rows.length > 3 ? `${rows.length} groups` : rows.length === 1 ? rows[0].label
  : `${rows.slice(0, -1).map((r) => r.label).join(", ")} and ${rows.at(-1).label}`);

/* ------------------------------------------------------------ comparing groups */

/** Horizontal bars, one per group: the name and its value on one line,
    the bar across the full width beneath — so a long name never squeezes
    the bar, on a phone either.
      rows   [{ label, value, note?, html?, href?, drill? }]   (html: a ready-made label, e.g. a link)
             href: the row opens that page (its detail, with the filter set)
             drill: the row narrows the dashboard — { county } / { school } /
             { term } / { month }, handled by the page (console.js, data-drill)
      act    what picking a row does, for screen readers ("show only this county")
      unit   "%" puts every bar on a 0–100 scale
      share  also say each row's share of the total (parts of one count)
      shareOf  …or of this number instead (people who answered, when each
             could pick several), described by shareWord ("who answered")
      sort   largest first (for groups with no order of their own)
      noun   what is being counted, for the tooltip ("visits")
      text   (row) => the value as text, when it isn't a plain number
      zeros  a word for the rows at nothing ("Not chosen"): they're named in
             one line under the chart instead of each drawing an empty bar
      top    rows shown before "Show all"; a ranked (sorted) list of more than
             12 shows its top 10 unless told otherwise (0: every row)
      insight  a sentence above the bars: the highest and lowest. A row's
             `base` (what its rate rests on) under 5 keeps it out of that.
      period   the reporting period, in every tooltip
      compare  { value, label } — the figure each bar is read against ("all counties"), in every tooltip */
export function barList(rows, { unit = "", max = null, share: withShare = false, shareOf = null, shareWord = "", sort = false, noun = "", text = null, zeros = "", act = "", empty = "Nothing recorded yet.", top = null, insight = false, period = "", compare = null } = {}) {
  let list = (rows || []).filter((r) => r.value != null);
  if (!list.length || !list.some((r) => r.value)) return none(empty);
  if (sort) list = [...list].sort((a, b) => b.value - a.value);
  const nothing = zeros ? list.filter((r) => !r.value) : [];
  if (nothing.length) list = list.filter((r) => r.value);
  const scaleTop = max ?? (unit === "%" ? 100 : Math.max(1, ...list.map((r) => r.value)));
  const total = shareOf ?? list.reduce((t, r) => t + r.value, 0);
  const row = (r) => {
    const value = text ? text(r) : show(r.value, unit);
    const part = (withShare || shareOf != null) && total ? `${share(r.value, total)}%` : "";
    const rows = [[value, noun]];
    if (part) rows.push([part, `of ${num(total)}${shareWord ? ` ${shareWord}` : ""}`]);
    if (compare?.value != null) rows.push([show(compare.value, unit), compare.label]);
    // A row that leads somewhere is one big target: its name is the link or button.
    const said = act ? `<span class="sr-only"> — ${esc(act)}</span>` : "";
    const name = r.href ? `<a class="bars-link" href="${esc(r.href)}">${r.html ?? esc(r.label)}${said}</a>`
      : r.drill ? `<button type="button" class="bars-link" data-drill="${esc(JSON.stringify(r.drill))}">${r.html ?? esc(r.label)}${said}</button>`
      : r.html ?? esc(r.label);
    return `
    <div class="bars-row${r.value ? "" : " is-zero"}${r.href || r.drill ? " is-drill" : ""}" role="listitem"${tip(r.label, rows, withPeriod(r.note || "", period))}>
      <div class="bars-head"><span class="bars-label">${name}</span>
        <span class="bars-val"><b>${esc(value)}</b>${part ? `<small>${part}</small>` : ""}${r.note ? `<small>${esc(r.note)}</small>` : ""}</span></div>
      <div class="bars-track"><span class="bars-fill" style="width:${Math.min(100, (r.value / scaleTop) * 100).toFixed(1)}%"></span></div>
    </div>`;
  };
  // A long ranked list: its top rows, the rest one click away — never dropped.
  const cut = top ?? (sort && list.length > 12 ? 10 : 0);
  const shown = cut && list.length > cut + 2 ? list.slice(0, cut) : list;
  const rest = list.slice(shown.length);
  return `${insight ? insightLine(barsInsight(list, unit, text)) : ""}<div class="bars" role="list">${shown.map(row).join("")}</div>${
    rest.length ? `<details class="bars-more"><summary>Show all ${num(list.length)}</summary><div class="bars" role="list">${rest.map(row).join("")}</div></details>` : ""}${
    nothing.length ? `<p class="chart-note">${esc(zeros)}: ${esc(nothing.map((r) => r.label).join(", "))}.</p>` : ""}`;
}
/** "Highest: Grade 6, 92%. Lowest: Grade 4, 78%." — or nothing, with fewer than three groups to compare. */
function barsInsight(list, unit, text) {
  const counted = list.some((r) => r.base != null);
  const judged = counted ? list.filter((r) => (r.base ?? 0) >= MIN_BASE) : list;
  if (judged.length < 3) return "";
  const byValue = [...judged].sort((a, b) => b.value - a.value);
  const v = (r) => (text ? text(r) : show(r.value, unit));
  const hi = byValue.filter((r) => v(r) === v(byValue[0]));
  const lo = byValue.filter((r) => v(r) === v(byValue.at(-1)));
  const only = counted && judged.length < list.length ? ` (groups of ${MIN_BASE} or more)` : "";
  if (v(hi[0]) === v(lo[0])) return `All ${judged.length} at ${v(hi[0])}${only}.`;
  return unit === "%" ? `Highest: ${names(hi)}, ${v(hi[0])}. Lowest: ${names(lo)}, ${v(lo[0])}${only}.`
    : `Most: ${names(hi)}, ${v(hi[0])}. Fewest: ${names(lo)}, ${v(lo[0])}${only}.`;
}

/* ------------------------------------------------------------ progress to a target */

const STATUS_WORD = { met: ["Met", "ok"], close: ["Close", "warm"], not_met: ["Not met", "danger"], no_data: ["No data", ""] };

/** Actual against target, one row each. Every bar fills towards the same
    line — the target — so the rows can be read down the page however
    different their units are: short of the line, on it, or past it.
      rows  [{ label, html?, value, target, percent, status, unit }]
            percent: how much of the target is achieved (the API works it
            out, the right way round for indicators meant to go down)
      fmt   (value, unit) => text */
export function targetList(rows, { fmt = (v) => show(v), keepEmpty = false, empty = "No values or targets yet.", period = "", top = 0 } = {}) {
  const list = (rows || []).filter((r) => keepEmpty || r.value != null || r.target != null);
  if (!list.length) return none(empty);
  const LINE = 80; // the target sits 80% of the way along; the rest is room to pass it
  const row = (r) => {
    const [word, cls] = STATUS_WORD[r.status] || STATUS_WORD.no_data;
    const pctOf = r.percent ?? (r.value != null && r.target ? (r.value / r.target) * 100 : null);
    const hasTarget = r.target != null;
    // With a target: progress towards the line. Without one, a percentage can still sit on 0–100.
    const width = r.value == null ? 0
      : hasTarget ? Math.max(1.5, Math.min(125, pctOf ?? 0) * (LINE / 100))
      : r.unit === "percent" ? Math.max(1.5, Math.min(100, r.value)) : 0;
    const value = r.value == null ? "—" : fmt(r.value, r.unit);
    const said = [[value, "actual"]];
    if (hasTarget) said.push([fmt(r.target, r.unit), "target"]);
    if (hasTarget && pctOf != null) said.push([`${Math.round(pctOf)}%`, "of the target"]);
    return `
    <div class="tg-row" role="listitem"${tip(r.label, said, withPeriod(r.value == null ? "No value recorded yet" : hasTarget ? word : "No target set", period))}>
      <div class="bars-head"><span class="bars-label">${r.html ?? esc(r.label)}</span>
        <span class="bars-val"><b>${esc(value)}</b>${hasTarget ? `<small>target ${esc(fmt(r.target, r.unit))}</small>` : `<small>no target</small>`}${
          r.value != null && hasTarget ? `<span class="pill ${cls}">${word}</span>` : r.value == null ? `<span class="pill">No data</span>` : ""}</span></div>
      <div class="tg-track${hasTarget ? "" : " no-target"}">${width ? `<span class="tg-fill tg-${esc(r.status || "no_data")}" style="width:${width.toFixed(1)}%"></span>` : ""}${
        hasTarget ? `<i class="tg-line" style="left:${LINE}%"></i>` : ""}</div>${r.note ? `
      <p class="tg-note">${esc(r.note)}</p>` : ""}
    </div>`;
  };
  // `top`: the first rows, the rest one click away (a long list of schools).
  const shown = top && list.length > top + 2 ? list.slice(0, top) : list;
  const rest = list.slice(shown.length);
  return `<div class="tg" role="list">${shown.map(row).join("")}</div>${
    rest.length ? `<details class="bars-more"><summary>Show all ${num(list.length)}</summary><div class="tg" role="list">${rest.map(row).join("")}</div></details>` : ""}`;
}
/** One line under a target chart, saying how to read it. */
export const TARGET_KEY = `<p class="chart-note"><i class="tg-key" aria-hidden="true"></i>Bar: actual · line: target.</p>`;

/* ------------------------------------------------------------ a measure over time */

/** A round number at or above `max` whose half is round too (the middle gridline). */
function niceTop(max) {
  if (!(max > 0)) return 2;
  const p = 10 ** Math.floor(Math.log10(max));
  const f = max / p;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 6 ? 6 : f <= 8 ? 8 : 10;
  return Math.max(2, step * p);
}

/** A line over time.
      points  [{ label, full?, sub?, value, target?, note? }]  oldest first
              label: under the axis ("Oct") · full: in the tooltip ("October 2026")
              sub: a second line under the label (the year, where it changes)
      unit    "%" fixes the scale at 0–100
      noun    what the value is, for the tooltip and the screen-reader text
      target  name of a second, dashed series read from point.target ("Target")
      band    { from, label } — shade the points from this index on ("Last 7 days")
      ticks   which labels to show on the axis (indexes); all by default
      height  of the plot, in pixels (150 unless said)
      drill   each point with a `drill` (monthPoints/termPoints give one)
              narrows the dashboard to that period: click it, or step to it
              with the arrow keys and press Enter
      insight a sentence above: the latest complete period against the one before
      A last point with `partial` (the month under way — monthPoints marks it)
      is open and joined by a dashed line, and the insight leaves it out: a
      period that isn't over isn't compared with whole ones. */
export function lineChart(points, { unit = "", noun = "", target = "", band = null, ticks = null, name = "Actual", title = "", height = 0, drill = false, empty = "Nothing recorded yet.", insight = false } = {}) {
  const pts = points || [];
  const has = (k) => pts.some((p) => p[k] != null);
  if (!pts.length || !(pts.some((p) => p.value) || (target && has("target")))) return none(empty);
  const n = pts.length;
  const values = pts.flatMap((p) => [p.value, target ? p.target : null]).filter((v) => v != null);
  // A shaded band carries its label above the plot: leave the peak room beneath it.
  const top = unit === "%" ? 100 : niceTop(Math.max(...values) * (band ? 1.2 : 1));
  const x = (i) => ((i + 0.5) / n) * 100;
  const y = (v) => (v / top) * 100;
  const under = pts.at(-1)?.partial && pts.at(-1).value != null ? n - 1 : -1; // the period still under way
  const path = (key) => {
    let d = "", pen = false;
    pts.forEach((p, i) => {
      if (p[key] == null || (key === "value" && i === under)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(2)} ${(100 - y(p[key])).toFixed(2)} `;
      pen = true;
    });
    return d.trim();
  };
  // The area under a single unbroken series: a wash, so the shape reads at a glance (not under the period still going).
  const whole = under >= 0 ? pts.slice(0, -1) : pts;
  const solid = !target && whole.length > 1 && whole.every((p) => p.value != null);
  const area = solid ? `M${x(0).toFixed(2)} 100 ${whole.map((p, i) => `L${x(i).toFixed(2)} ${(100 - y(p.value)).toFixed(2)}`).join(" ")} L${x(whole.length - 1).toFixed(2)} 100 Z` : "";
  const fade = `lcg${++gradSeq}`; // the wash fades to nothing at the baseline
  const before = under > 0 ? pts.slice(0, under).map((p, i) => (p.value == null ? -1 : i)).filter((i) => i >= 0).at(-1) : undefined;
  const dashed = before != null ? `M${x(before).toFixed(2)} ${(100 - y(pts[before].value)).toFixed(2)} L${x(under).toFixed(2)} ${(100 - y(pts[under].value)).toFixed(2)}` : "";
  // Label a few points only: every one when there are a handful, otherwise the latest and the highest.
  const known = pts.map((p, i) => (p.value == null ? -1 : i)).filter((i) => i >= 0);
  const last = known.at(-1), peak = known.reduce((m, i) => (pts[i].value > pts[m].value ? i : m), known[0] ?? 0);
  const low = known.reduce((m, i) => (pts[i].value < pts[m].value ? i : m), known[0] ?? 0);
  const labelled = new Set(n <= 4 ? known : [last, peak, low]);
  const dotted = n <= 12;
  const picks = drill && pts.some((p) => p.drill);
  const said = `${title ? `${title}: ` : ""}${pts.map((p) => `${p.full || p.label} ${p.value == null ? "no value" : show(p.value, unit)}${target && p.target != null ? ` (target ${show(p.target, unit)})` : ""}`).join(", ")}${
    picks ? ". Step through the points with the arrow keys; press Enter to show only that period" : ""}`;
  const shown = new Set(ticks ?? pts.map((_, i) => i));
  const yLabels = [top, top / 2, 0].map((v) => show(v, unit));
  return `${insight ? insightLine(lineInsight(pts, under, unit, noun)) : ""}<div class="lc${picks ? " is-drill" : ""}" tabindex="0" role="img" aria-label="${esc(said)}" data-live-quiet${height ? ` style="--lc-h:${height}px"` : ""}>
    <div class="lc-y" style="width:${(Math.max(...yLabels.map((l) => l.length)) * 0.58 + 0.2).toFixed(2)}em" aria-hidden="true">${yLabels.map((l, i) => `<span style="bottom:${100 - i * 50}%">${esc(l)}</span>`).join("")}</div>
    <div class="lc-plot">
      <i class="lc-grid" style="bottom:100%"></i><i class="lc-grid" style="bottom:50%"></i>
      ${band ? `<i class="lc-band" style="left:${((band.from / n) * 100).toFixed(2)}%"><em>${esc(band.label)}</em></i>` : ""}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        ${area ? `<defs><linearGradient id="${fade}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="lc-fade-top"/><stop offset="1" class="lc-fade-end"/></linearGradient></defs>
        <path class="lc-area" d="${area}" style="fill:url(#${fade})"/>` : ""}
        ${target ? `<path class="lc-line lc-line-t" d="${path("target")}"/>` : ""}
        <path class="lc-line" d="${path("value")}"/>
        ${dashed ? `<path class="lc-line lc-line-partial" d="${dashed}"/>` : ""}
      </svg>
      ${pts.map((p, i) => {
        const rows = [];
        if (p.value != null) rows.push([show(p.value, unit), target ? name.toLowerCase() : noun, "var(--chart-1)"]);
        if (target && p.target != null) rows.push([show(p.target, unit), target.toLowerCase(), "var(--chart-target)"]);
        if (!rows.length) rows.push(["—", "no value"]);
        const pick = picks && p.drill && p.value != null ? ` data-drill="${esc(JSON.stringify(p.drill))}"` : "";
        const so = i === under ? "So far: this period isn't over" : "";
        const note = [so, p.note, pick ? "pick it to see only this period" : ""].filter(Boolean).join(" · ");
        return `<span class="lc-pt${labelled.has(i) || dotted ? " is-marked" : ""}" style="left:${((i / n) * 100).toFixed(2)}%;width:${(100 / n).toFixed(2)}%"${pick}${tip(p.full || p.label, rows, note ? note[0].toUpperCase() + note.slice(1) : "")}>${
          target && p.target != null ? `<i class="lc-dot lc-dot-t" style="bottom:${y(p.target).toFixed(2)}%"></i>` : ""}${
          p.value != null ? `<i class="lc-dot${i === under ? " is-partial" : ""}" data-tip-anchor style="bottom:${y(p.value).toFixed(2)}%"></i>` : ""}${
          p.value != null && labelled.has(i) ? `<b class="lc-val" style="bottom:${y(p.value).toFixed(2)}%">${esc(show(p.value, unit))}</b>` : ""}</span>`;
      }).join("")}
    </div>
    <div class="lc-x" aria-hidden="true">${pts.map((p, i) => `<span>${shown.has(i) ? `${esc(p.label)}${p.sub ? `<small>${esc(p.sub)}</small>` : ""}` : ""}</span>`).join("")}</div>
  </div>${target ? `<ul class="chart-key"><li><i class="key-line"></i>${esc(name)}</li><li><i class="key-line key-dash"></i>${esc(target)}</li></ul>` : ""}${
    under >= 0 ? `<p class="chart-note">${esc(pts[under].full || pts[under].label)} isn't over yet: its point is open and its line dashed.</p>` : ""}`;
}
/** "September 2026: 12 visits, up from 8 in August 2026." — the latest complete period against the one before. */
function lineInsight(pts, skip, unit, noun) {
  const done = pts.filter((p, i) => i !== skip && p.value != null);
  if (done.length < 3) return "";
  const [p, l] = done.slice(-2);
  const name = (q) => q.full || q.label;
  const d = l.value - p.value;
  const mid = (q) => name(q).replace(/^Week /, "the week "); // mid-sentence: "in the week of 12 October"
  const how = Math.abs(d) < 0.5 ? `the same as ${mid(p)}` : `${d > 0 ? "up" : "down"} from ${show(p.value, unit)} in ${mid(p)}`;
  return `${name(l)}: ${show(l.value, unit)}${noun && unit !== "%" ? ` ${nounFor(l.value, noun)}` : ""}, ${how}.`;
}

/** "2026-09" → { label: "Sep", full: "September 2026", sub: the year where it starts or changes };
    the month under way (Kenyan time) is marked `partial`. */
export function monthPoints(rows, pick = (r) => r.value) {
  let year = null;
  const thisMonth = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
  return (rows || []).map((r) => {
    const [y, m] = String(r.label).split("-").map(Number);
    if (!y || !m) return { label: String(r.label), value: pick(r) };
    const d = new Date(Date.UTC(y, m - 1, 1));
    const sub = y !== year ? String(y) : "";
    year = y;
    return {
      label: d.toLocaleString(undefined, { month: "short", timeZone: "UTC" }), sub,
      full: d.toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }), value: pick(r),
      drill: { month: String(r.label) }, ...(String(r.label) === thisMonth ? { partial: true } : {}),
    };
  });
}
/** "2026 Term 3" → { label: "Term 3", sub: "2026" (where the year starts or changes), full: as given }. */
export function termPoints(rows, pick = (r) => r.value, more = () => ({})) {
  let year = null;
  return (rows || []).map((r) => {
    const m = /^(\d{4}) Term (\d)$/.exec(String(r.label));
    const sub = m && m[1] !== year ? m[1] : "";
    if (m) year = m[1];
    return { label: m ? `Term ${m[2]}` : String(r.label), sub, full: String(r.label), value: pick(r), ...(m ? { drill: { term: String(r.label) } } : {}), ...more(r) };
  });
}
/** A trend needs three points to have a shape; with fewer, the periods are simply compared. */
export function trendOrBars(points, opts = {}) {
  const known = (points || []).filter((p) => p.value != null);
  if (known.length >= 3) return lineChart(points, opts);
  return barList(known.map((p) => ({ label: p.full || p.label, value: p.value, note: p.partial ? [p.note, "so far"].filter(Boolean).join(" · ") : p.note, drill: opts.drill ? p.drill : undefined })),
    { unit: opts.unit, noun: opts.noun, empty: opts.empty, act: opts.drill ? "show only this period" : "" });
}

/* ------------------------------------------------------------ parts of one whole */

function keyList(parts, total, { colours, noun, compact = false }) {
  if (compact) {
    return `<ul class="chart-key">${parts.map((p, i) => `<li${tip(p.label, [[num(p.value), noun], [`${share(p.value, total)}%`, `of ${num(total)}`]])}><i style="background:${p.colour || colours[i]}"></i>${esc(p.label)} <b>${num(p.value)}</b></li>`).join("")}</ul>`;
  }
  return `<ul class="chart-key chart-key-rows">${parts.map((p, i) => `
    <li${tip(p.label, [[num(p.value), noun], [`${share(p.value, total)}%`, `of ${num(total)}`]])}><i style="background:${p.colour || colours[i]}"></i><span>${esc(p.label)}</span><b>${num(p.value)}</b><small>${share(p.value, total)}%</small></li>`).join("")}</ul>`;
}

/** Parts of one whole: horizontal bars, each with its count and its share,
    largest first unless the parts have an order of their own. No pies or
    donuts (27 October 2026): lengths on one scale compare more exactly than
    angles, and a bar needs no colour key. */
export function proportion(parts, { noun = "", empty, sort = true, zeros = "", insight = false, period = "" } = {}) {
  return barList(parts || [], { share: true, sort, noun, empty, zeros, insight, period });
}

/** Two or three periods or groups side by side for each category — a
    baseline and a follow-up, last term and this term. One scale for every
    bar (0–100 for "%"), each labelled with its value; a key names the
    series, earliest (lightest) first, so the latest reads strongest.
      rows    [{ label, values: [v | null …] (one per series), notes?: [text…] }]
      series  [{ label }]   oldest first
      insight a sentence above: in how many categories the last series is higher */
export function groupedBars(rows, series, { unit = "", noun = "", empty = "Nothing recorded yet.", title = "", insight = false, period = "" } = {}) {
  const list = (rows || []).filter((r) => r.values.some((v) => v != null));
  if (!list.length || series.length < 2) return none(empty);
  const shades = series.length === 2 ? ["var(--seq-3)", "var(--chart-1)"] : ["var(--seq-4)", "var(--seq-2)", "var(--chart-1)"];
  const top = unit === "%" ? 100 : Math.max(1, ...list.flatMap((r) => r.values.filter((v) => v != null)));
  const said = list.map((r) => `${r.label}: ${series.map((s, i) => `${s.label} ${r.values[i] == null ? "no data" : show(r.values[i], unit)}`).join(", ")}`).join("; ");
  let text = "";
  if (insight) {
    const both = list.filter((r) => r.values.at(-1) != null && r.values.at(-2) != null);
    if (both.length >= 2) {
      const up = both.filter((r) => r.values.at(-1) - r.values.at(-2) >= 0.5).length;
      const down = both.filter((r) => r.values.at(-2) - r.values.at(-1) >= 0.5).length;
      const [a, b] = [series.at(-2).label, series.at(-1).label];
      const all = both.length === 2 ? "both" : `all ${both.length}`;
      text = up === both.length ? `Higher in ${b} than ${a} in ${all}.`
        : down === both.length ? `Lower in ${b} than ${a} in ${all}.`
        : `Higher in ${b} than ${a} in ${up} of ${both.length}; lower in ${down}.`;
    }
  }
  return `${insightLine(text)}<ul class="chart-key">${series.map((s, i) => `<li><i style="background:${shades[i]}"></i>${esc(s.label)}</li>`).join("")}</ul>
  <div class="gbars" role="img" aria-label="${esc(`${title ? `${title}: ` : ""}${said}`)}">${list.map((r) => `
    <div class="gbars-group">
      <div class="gbars-label">${esc(r.label)}</div>
      ${series.map((s, i) => {
        const v = r.values[i];
        return `<div class="gbars-row"${tip(`${r.label} · ${s.label}`, [[v == null ? "—" : show(v, unit), v == null ? "no data" : noun, shades[i]]], withPeriod(r.notes?.[i] || "", period))}>
        <div class="bars-track"><span class="bars-fill" style="width:${v == null ? 0 : Math.min(100, (v / top) * 100).toFixed(1)}%;background:${shades[i]}"></span></div>
        <span class="gbars-val">${v == null ? "No data" : esc(show(v, unit))}</span></div>`;
      }).join("")}
    </div>`).join("")}</div>`;
}

/** One bar split into the parts of a whole that come in an order — bands,
    how recently, better/same/worse. Each part carries its own colour
    (`colour`, a CSS value) because here colour is the scale.
      parts    [{ label, short?, value, colour }]
      compact  the key on one wrapping line, without shares (a summary card) */
export function stackBar(parts, { noun = "", empty = "Nothing recorded yet.", title = "", compact = false, period = "" } = {}) {
  const list = parts || [];
  const total = list.reduce((t, p) => t + (p.value || 0), 0);
  if (!total) return none(empty);
  const said = list.map((p) => `${p.label}: ${num(p.value)} (${share(p.value, total)}%)`).join(", ");
  // No figures inside the bar: on a narrow part they'd be clipped, and the key beneath has every one.
  return `<div class="stack" role="img" aria-label="${esc(`${title ? `${title} — ` : ""}${said}`)}">${list.filter((p) => p.value > 0).map((p) =>
    `<span style="flex:${p.value};background:${p.colour}"${tip(p.label, [[num(p.value), noun], [`${share(p.value, total)}%`, `of ${num(total)}`]], period)}></span>`).join("")}</div>
  ${keyList(list.map((p) => ({ ...p, label: p.short ? `${p.short} — ${p.label}` : p.label })), total, { colours: [], noun, compact })}`;
}

/** One stacked bar per group, every bar the whole of its group — the same ordered parts
    (the achievement bands) side by side, one key beneath. Each row says one figure of its
    own on the right (e.g. "64% at ME or above").
      rows   [{ label, parts: [n…] (in the order of `parts`), figure?, figureNote?, note? }]
      parts  [{ label, short?, colour }]
      noun   what is counted ("marked") */
export function stackRows(rows, parts, { noun = "", empty = "Nothing recorded yet.", title = "", period = "" } = {}) {
  const list = (rows || []).filter((r) => r.parts.some((v) => v > 0));
  if (!list.length) return none(empty);
  const all = parts.map((p, i) => ({ ...p, value: list.reduce((t, r) => t + (r.parts[i] || 0), 0) }));
  const grand = all.reduce((t, p) => t + p.value, 0);
  return `<div class="stack-rows" role="list"${title ? ` aria-label="${esc(title)}"` : ""}>${list.map((r) => {
    const total = r.parts.reduce((t, v) => t + (v || 0), 0);
    const said = parts.map((p, i) => `${p.short || p.label}: ${num(r.parts[i] || 0)} (${share(r.parts[i] || 0, total)}%)`).join(", ");
    return `<div class="stack-row" role="listitem">
      <div class="bars-head"><span class="bars-label">${esc(r.label)}</span>
        <span class="bars-val">${r.figure != null ? `<b>${esc(r.figure)}</b>` : ""}${r.figureNote ? `<small>${esc(r.figureNote)}</small>` : ""}${r.note ? `<small>${esc(r.note)}</small>` : ""}</span></div>
      <div class="stack" role="img" aria-label="${esc(`${r.label} — ${said}`)}">${parts.map((p, i) => (r.parts[i] > 0
        ? `<span style="flex:${r.parts[i]};background:${p.colour}"${tip(`${r.label} · ${p.short ? `${p.short} — ` : ""}${p.label}`, [[num(r.parts[i]), noun], [`${share(r.parts[i], total)}%`, `of ${num(total)}`]], period)}></span>` : "")).join("")}</div>
    </div>`;
  }).join("")}</div>
  ${keyList(all.map((p) => ({ ...p, label: p.short ? `${p.short} — ${p.label}` : p.label })), grand, { colours: [], noun, compact: true })}`;
}

/* ------------------------------------------------------------ counts on a grid */

/** A heatmap's shades: one hue in up to four steps for 1…max, each an equal
    run of whole counts ("1–2", "3–4" …); a cell of nothing has none. The
    busiest step is always the darkest, however many steps there are. */
function shadeSteps(max) {
  const w = Math.max(1, Math.ceil(max / 4));
  const steps = [];
  for (let lo = 1; lo <= max; lo += w) steps.push([lo, Math.min(max, lo + w - 1)]);
  return steps;
}

/** A heatmap: a count in each cell of a grid — a place by month, a day by a
    time of day — one hue from light (a few) to dark (many), a plain cell for
    none. It is a table, so it reads as one without the colour: every cell
    prints its count, the key names what each shade covers, and a screen
    reader reads it row by row.
      rows     [{ label, values: [n…], total?, drill?, pickSchool?, href? }]
               drill: the row's name narrows the dashboard ({ county }); pickSchool: to that school;
               href: it opens that page
      cols     [{ label, short?, sub?, full?, drill? }]   headings (short: on a phone; full: in the
               tooltip; drill: narrows the dates)
      corner   the rows' heading ("County")
      caption  what the grid counts, read out with the table
      noun     what a cell counts ("visits")
      totals   a last column with each row's total
      act      what picking a row's name does, for screen readers
      scale    a measure in each cell instead of a count — an average mark — shaded by
               the step it reaches: [{ from, label }] lowest first, up to four (the
               achievement bands). A cell is then a number, null (nothing to show: "—")
               or { value, note?, few? }: few marks it as too little to compare — it's
               printed with an asterisk, lighter, and the key says why.
      unit     "%" after each value (with a scale) */
export function heatmap(rows, cols, { corner = "", caption = "", noun = "", totals = true, act = "", empty = "Nothing recorded yet.", scale = null, unit = "", fewNote = "", insight = false, period = "" } = {}) {
  const list = rows || [];
  const valueOf = (v) => (v != null && typeof v === "object" ? v.value : v);
  const max = Math.max(0, ...list.flatMap((r) => r.values.map((v) => valueOf(v) ?? 0)));
  if (scale ? !list.some((r) => r.values.some((v) => valueOf(v) != null)) : !max) return none(empty);
  const steps = scale ? scale.slice(-4).map((s, i, all) => [s.from, all[i + 1] ? all[i + 1].from : Infinity, s.label]) : shadeSteps(max);
  const shadeOf = (i) => 4 - steps.length + 1 + i;
  const shade = (v) => (v == null || (!scale && !v) ? 0 : shadeOf(Math.max(0, steps.findIndex(([lo, hi]) => (scale ? v >= lo && v < hi : v >= lo && v <= hi)))));
  const range = ([lo, hi, label]) => (scale ? label : lo === hi ? num(lo) : `${num(lo)}–${num(hi)}`);
  const cellText = (v) => (scale ? (v == null ? "—" : show(v, unit)) : v ? num(v) : '<span class="sr-only">0</span>');
  const pick = (attr, value, html, how) => `<button type="button" class="bars-link" ${attr}="${esc(value)}">${html}${how ? `<span class="sr-only">: ${esc(how)}</span>` : ""}</button>`;
  // On a phone a column is headed by its short form ("N", "6"); the whole name stays for screen readers.
  const colName = (c) => (c.short ? `<span class="hm-long">${esc(c.label)}</span><span class="hm-short" aria-hidden="true">${esc(c.short)}</span>` : esc(c.label));
  const head = `<tr><th scope="col" class="hm-corner">${esc(corner)}</th>${cols.map((c) => `<th scope="col">${
    c.drill ? pick("data-drill", JSON.stringify(c.drill), colName(c), "show only this period") : colName(c)}${c.sub ? `<small>${esc(c.sub)}</small>` : ""}</th>`).join("")}${
    totals ? `<th scope="col" class="hm-total">Total</th>` : ""}</tr>`;
  const body = list.map((r) => {
    const name = r.href ? `<a class="bars-link" href="${esc(r.href)}">${esc(r.label)}</a>`
      : r.drill ? pick("data-drill", JSON.stringify(r.drill), esc(r.label), act) : r.pickSchool ? pick("data-pick-school", r.pickSchool, esc(r.label), act) : esc(r.label);
    const total = r.total ?? r.values.reduce((t, v) => t + (valueOf(v) ?? 0), 0);
    return `<tr><th scope="row">${name}</th>${r.values.map((cell, i) => {
      const v = valueOf(cell);
      const few = !!(cell && typeof cell === "object" && cell.few);
      const rows2 = [[scale ? (v == null ? "—" : show(v, unit)) : num(v), noun]];
      if (cell && typeof cell === "object" && cell.note) rows2.push(["", cell.note]);
      return `<td class="hm hm-${shade(v)}${few ? " hm-few" : ""}"${tip(`${r.label} · ${cols[i].full || cols[i].label}`, rows2, withPeriod(few ? fewNote : "", period))}>${cellText(v)}${few ? '<span aria-hidden="true">*</span>' : ""}</td>`;
    }).join("")}${totals ? `<td class="hm-total">${num(total)}</td>` : ""}</tr>`;
  }).join("");
  const anyFew = scale && list.some((r) => r.values.some((v) => v && typeof v === "object" && v.few));
  const key = `<ul class="chart-key hm-key" aria-hidden="true"><li><i class="hm-0"></i>${scale ? "Nothing yet" : "None"}</li>${
    steps.map((s, i) => `<li><i class="hm-${shadeOf(i)}"></i>${esc(range(s))}</li>`).join("")}<li>${esc(noun)} in a cell</li>${
    anyFew ? `<li>* ${esc(fewNote || "too few to compare")}</li>` : ""}</ul>`;
  // The busiest cell, when there's more than one to choose between (counts only). `insight`
  // may name it: "Largest" for a grid of learners rather than of times.
  let busiest = "";
  if (insight && !scale) {
    const cells = list.flatMap((r) => r.values.map((v, i) => ({ r, c: cols[i], v: valueOf(v) ?? 0 }))).filter((x) => x.v > 0);
    if (cells.length >= 2 && max >= 2) {
      const b = cells.reduce((m, x) => (x.v > m.v ? x : m));
      const ties = cells.filter((x) => x.v === b.v).length;
      busiest = ties === 1 ? `${typeof insight === "string" ? insight : "Busiest"}: ${b.r.label}, ${b.c.full || b.c.label} (${num(b.v)} ${nounFor(b.v, noun)}).` : "";
    }
  }
  return `${insightLine(busiest)}<div class="hm-wrap"><table class="heatmap">${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ""}<thead>${head}</thead><tbody>${body}</tbody></table></div>${key}`;
}

/* ------------------------------------------------------------ how values spread */

/** A histogram: how many fall in each range of a measure — learners by their
    average mark, in tens. Columns side by side on one scale, each with its
    count, the ranges' edges beneath. Colour only where the ranges mean
    something of their own (the achievement bands), named in the key.
      bins   [{ from, to, value, colour? }]   in order; the last `to` may be null ("60 or more")
      unit   "%" after the last edge and in the tooltip
      noun   what is counted ("learners")
      key    [{ label, colour, value }]   what the colours mean, with their counts */
export function histogram(bins, { unit = "", noun = "", key = [], title = "", empty = "Nothing recorded yet.", period = "" } = {}) {
  const list = bins || [];
  const total = list.reduce((t, b) => t + (b.value || 0), 0);
  if (!total) return none(empty);
  const top = niceTop(Math.max(...list.map((b) => b.value)));
  const yLabels = [top, top / 2, 0].map((v) => show(v));
  const range = (b) => (b.to == null ? `${b.from}${unit} or more` : `${b.from}–${b.to}${unit}`);
  const edges = [...list.map((b) => b.from), list.at(-1).to];
  const said = `${title ? `${title}: ` : ""}${list.map((b) => `${range(b)}: ${num(b.value)}`).join(", ")}`;
  return `<div class="hist" role="img" aria-label="${esc(said)}">
    <div class="lc-y" style="width:${(Math.max(...yLabels.map((l) => l.length)) * 0.58 + 0.2).toFixed(2)}em" aria-hidden="true">${yLabels.map((l, i) => `<span style="bottom:${100 - i * 50}%">${esc(l)}</span>`).join("")}</div>
    <div class="hist-plot"><i class="lc-grid" style="bottom:100%"></i><i class="lc-grid" style="bottom:50%"></i>${list.map((b) => `<div class="hist-col"${
      tip(range(b), [[num(b.value), noun, b.colour], [`${share(b.value, total)}%`, `of ${num(total)}`]], period)}>${
      b.value ? `<b>${num(b.value)}</b><i style="height:${((b.value / top) * 100).toFixed(1)}%;background:${b.colour || "var(--chart-1)"}"></i>` : ""}</div>`).join("")}</div>
    <div class="hist-x" aria-hidden="true">${edges.map((e, i) => `<span>${e == null ? "" : `${num(e)}${i === edges.length - 1 ? unit : ""}`}</span>`).join("")}</div>
  </div>${key.length ? keyList(key, total, { colours: [], noun, compact: true }) : ""}`;
}

/* ------------------------------------------------------------ how learners' marks spread */

/** Learners' averages in tens, each range with the band it falls in — as the API's marksHistogram. */
export function marksBins(averages, bands = []) {
  const byMin = [...bands].sort((a, b) => b.minPercent - a.minPercent);
  const bandOf = (p) => byMin.find((b) => p >= b.minPercent)?.code ?? byMin.at(-1)?.code ?? null;
  return Array.from({ length: 10 }, (_, i) => ({
    from: i * 10, to: i === 9 ? 100 : i * 10 + 9, band: bandOf(i * 10),
    value: averages.filter((v) => (i === 9 ? v >= 90 : v >= i * 10 && v < i * 10 + 10)).length,
  }));
}
/** The marks histogram every page uses: the ranges coloured by band (bands best first, as the
    API sends them), the band totals in the key. */
export function marksSpread(bins, bands = [], { empty = "No marked work yet.", period = "" } = {}) {
  const colourOf = (code) => { const i = bands.findIndex((b) => b.code === code); return i >= 0 ? `var(--band-${i + 1})` : "var(--chart-1)"; };
  return histogram(bins.map((b) => ({ ...b, colour: colourOf(b.band) })), {
    unit: "%", noun: "learners", title: "Learners by average mark", empty, period,
    key: bands.map((b, i) => ({ label: `${b.code} — ${b.label}`, colour: `var(--band-${i + 1})`, value: bins.filter((x) => x.band === b.code).reduce((t, x) => t + x.value, 0) })),
  });
}

/* ------------------------------------------------------------ columns: one value per period or group */

let gradSeq = 0;

/** Upright columns, one per period or group, each with its value on its
    cap — a count or share term by term, month by month or grade by grade
    (the programme growing; the average mark in each grade). One scale from
    zero (0–100 for "%"); the period still under way is paler and dashed and
    says "so far". `line` is a reference across them — an approved target or
    the overall figure — always named in the key, never assumed.
      points [{ label, full?, sub?, value, note?, partial?, drill?, base? }]
      time   the points are periods in order: the sentence is the latest against the one before
      line   { value, label } */
export function columnChart(points, { unit = "", noun = "", title = "", empty = "Nothing recorded yet.", period = "", drill = false, line = null, insight = false, time = false, height = 0 } = {}) {
  const pts = points || [];
  if (!pts.some((p) => p.value)) return none(empty);
  const vals = pts.map((p) => p.value).filter((v) => v != null);
  const top = unit === "%" ? 100 : niceTop(Math.max(...vals, line?.value ?? 0));
  const y = (v) => Math.max(0, Math.min(100, (v / top) * 100));
  const yLabels = [top, top / 2, 0].map((v) => show(v, unit));
  const picks = drill && pts.some((p) => p.drill);
  const ref = line?.value != null ? line : null;
  const said = `${title ? `${title}: ` : ""}${pts.map((p) => `${p.full || p.label} ${p.value == null ? "no value" : show(p.value, unit)}${p.partial ? " so far" : ""}`).join(", ")}${
    ref ? `; ${ref.label} ${show(ref.value, unit)}` : ""}`;
  const col = (p) => {
    const rows = p.value == null ? [["—", "no value"]] : [[show(p.value, unit), noun]];
    if (ref && p.value != null) rows.push([show(ref.value, unit), ref.label.toLowerCase()]);
    const note = withPeriod([p.partial ? "So far: this period isn't over" : "", p.note].filter(Boolean).join(" · "), p.partial ? "" : period);
    const inner = p.value != null
      ? `<b class="col-val">${esc(show(p.value, unit))}</b><i class="col-bar" style="height:${y(p.value).toFixed(1)}%"></i>`
      : `<b class="col-val is-none">—</b>`;
    const cls = `col${p.partial ? " is-partial" : ""}`;
    // A column that narrows the page is a button; the others are marks.
    return picks && p.drill && p.value != null
      ? `<button type="button" class="${cls} is-drill" data-drill="${esc(JSON.stringify(p.drill))}" aria-label="${esc(`${p.full || p.label}: ${show(p.value, unit)} — show only this`)}"${tip(p.full || p.label, rows, note)}>${inner}</button>`
      : `<div class="${cls}"${tip(p.full || p.label, rows, note)}>${inner}</div>`;
  };
  const sentence = !insight ? ""
    : time ? lineInsight(pts, pts.at(-1)?.partial ? pts.length - 1 : -1, unit, noun)
    : barsInsight(pts.filter((p) => p.value != null && !p.partial).map((p) => ({ ...p, label: p.full || p.label })), unit);
  return `${insightLine(sentence)}<div class="cols"${picks ? ' role="group"' : ' role="img"'} aria-label="${esc(said)}"${height ? ` style="--col-h:${height}px"` : ""}>
    <div class="lc-y" style="width:${(Math.max(...yLabels.map((l) => l.length)) * 0.58 + 0.2).toFixed(2)}em" aria-hidden="true">${yLabels.map((l, i) => `<span style="bottom:${100 - i * 50}%">${esc(l)}</span>`).join("")}</div>
    <div class="cols-plot"><i class="lc-grid" style="bottom:100%"></i><i class="lc-grid" style="bottom:50%"></i>${
      ref ? `<i class="cols-ref" style="bottom:${y(ref.value).toFixed(1)}%" aria-hidden="true"></i>` : ""}${pts.map(col).join("")}</div>
    <div class="cols-x" aria-hidden="true">${pts.map((p) => `<span>${esc(p.label)}${p.sub ? `<small>${esc(p.sub)}</small>` : ""}</span>`).join("")}</div>
  </div>${ref ? `<ul class="chart-key"><li><i class="key-ref"></i>${esc(ref.label)}: ${esc(show(ref.value, unit))}</li></ul>` : ""}${
    pts.at(-1)?.partial && pts.at(-1).value != null ? `<p class="chart-note">${esc(pts.at(-1).full || pts.at(-1).label)} isn't over yet: its column is paler.</p>` : ""}`;
}

/* ------------------------------------------------------------ a ring: one whole, a few parts */

/** One whole in a few parts, at a glance: a ring with the total in the
    middle and, beside it, every part's count and share — the exact numbers
    are always in the key, so nothing has to be read from an angle. Only for
    2 to 5 parts of a single whole (the achievement bands, the library's
    shelves, how teachers are employed); more parts — or parts to be compared
    closely — are bars (proportion()). Colour follows the part, in the order
    given (a part with nothing keeps its colour and shows 0).
      parts   [{ label, value, colour? }]
      colours tokens in order (default --cat-1…3: validated for three, unordered) */
export function donut(parts, { noun = "", title = "", empty = "Nothing recorded yet.", period = "", colours = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)"], centre = "" } = {}) {
  const list = (parts || []).filter((p) => p.value != null).map((p, i) => ({ ...p, colour: p.colour || colours[i] || "var(--neutral)" }));
  const total = list.reduce((t, p) => t + (p.value || 0), 0);
  if (!total) return none(empty);
  if (list.length > 5) return proportion(list, { noun, empty, period, sort: false });
  const shown = list.filter((p) => p.value > 0);
  const gap = shown.length > 1 ? 0.9 : 0; // the surface between parts
  let at = 0;
  const segs = shown.map((p) => {
    const len = (p.value / total) * 100;
    const draw = Math.max(0.01, len - gap);
    const seg = `<circle class="dn-seg" cx="21" cy="21" r="15.9155" style="stroke:${p.colour}" stroke-dasharray="${draw.toFixed(3)} ${(100 - draw).toFixed(3)}" stroke-dashoffset="${(25 - at - gap / 2).toFixed(3)}"${
      tip(p.label, [[num(p.value), noun], [`${share(p.value, total)}%`, `of ${num(total)}`]], period)}/>`;
    at += len;
    return seg;
  }).join("");
  const said = `${title ? `${title}: ` : ""}${list.map((p) => `${p.label} ${num(p.value)} (${share(p.value, total)}%)`).join(", ")}, of ${num(total)}${noun ? ` ${noun}` : ""}`;
  return `<div class="donut">
    <div class="dn-ring" role="img" aria-label="${esc(said)}">
      <svg viewBox="0 0 42 42" aria-hidden="true" focusable="false"><circle class="dn-track" cx="21" cy="21" r="15.9155"/>${segs}</svg>
      <div class="dn-centre" aria-hidden="true"><b>${esc(centre || num(total))}</b><span>${esc(noun)}</span></div>
    </div>
    ${keyList(list, total, { colours: [], noun })}
  </div>`;
}

/* ------------------------------------------------------------ each group against its line */

/** Each group against a line on one scale (0–100 for "%") — a school's own
    approved target, or the overall figure: the bar is the group, the mark
    across it the line. Bars at or past their line are full colour, those
    short of it paler, so the ones to look at stand out — without a warning
    colour, since a line that is only the average always has some below it.
    The key says what the line is. Highest first; a long list shows its top
    rows and the rest one click away.
      rows [{ label, value, line?, lineLabel?, base?, note?, href?, drill? }]  line: the row's own (its target)
      line { value, label }  the one line for every row without its own */
export function bulletList(rows, { unit = "", noun = "", line = null, empty = "Nothing recorded yet.", period = "", act = "", insight = false, top = null } = {}) {
  const list = (rows || []).filter((r) => r.value != null).sort((a, b) => b.value - a.value || String(a.label).localeCompare(String(b.label)));
  if (!list.length) return none(empty);
  const lineOf = (r) => r.line ?? line?.value ?? null;
  const max = unit === "%" ? 100 : niceTop(Math.max(...list.map((r) => Math.max(r.value, lineOf(r) ?? 0))));
  const at = (v) => Math.max(0, Math.min(100, (v / max) * 100));
  const lineName = line?.label || "Target";
  // Compared as shown (whole percentages, else one decimal): two figures that read the same are on the line.
  const asShown = (v) => (unit === "%" ? Math.round(v) : round1(v));
  const gapWords = (v, l) => {
    const d = Math.abs(asShown(v) - asShown(l));
    if (!d) return "on the line";
    const amount = unit === "%" ? `${d} ${d === 1 ? "pt" : "pts"}` : num(round1(d));
    return `${amount} ${asShown(v) > asShown(l) ? "above" : "below"}`;
  };
  const row = (r) => {
    const l = lineOf(r);
    const under = l != null && asShown(r.value) < asShown(l);
    const rows2 = [[show(r.value, unit), noun]];
    if (l != null) rows2.push([show(l, unit), (r.line != null ? r.lineLabel || "its target" : lineName).toLowerCase()]);
    const gap = l == null ? "" : gapWords(r.value, l);
    const said = act ? `<span class="sr-only"> — ${esc(act)}</span>` : "";
    const name = r.href ? `<a class="bars-link" href="${esc(r.href)}">${esc(r.label)}${said}</a>`
      : r.drill ? `<button type="button" class="bars-link" data-drill="${esc(JSON.stringify(r.drill))}">${esc(r.label)}${said}</button>` : esc(r.label);
    return `
    <div class="bars-row bul-row${under ? " is-under" : ""}${r.href || r.drill ? " is-drill" : ""}" role="listitem"${tip(r.label, rows2, withPeriod([gap, r.note].filter(Boolean).join(" · "), period))}>
      <div class="bars-head"><span class="bars-label">${name}</span>
        <span class="bars-val"><b>${esc(show(r.value, unit))}</b>${gap ? `<small>${esc(gap)}</small>` : ""}${r.note ? `<small>${esc(r.note)}</small>` : ""}</span></div>
      <div class="bul-track"><span class="bul-fill" style="width:${at(r.value).toFixed(1)}%"></span>${
        l != null ? `<i class="bul-line" style="left:${at(l).toFixed(1)}%" aria-hidden="true"></i>` : ""}</div>
    </div>`;
  };
  const cut = top ?? (list.length > 12 ? 10 : 0);
  const shown = cut && list.length > cut + 2 ? list.slice(0, cut) : list;
  const rest = list.slice(shown.length);
  const lined = list.filter((r) => lineOf(r) != null);
  const over = lined.filter((r) => asShown(r.value) >= asShown(lineOf(r))).length;
  const sentence = insight && lined.length >= 3 ? `${over} of ${lined.length} at or above ${line && !list.some((r) => r.line != null) ? `the ${lineName.toLowerCase()} line` : "their line"}.` : "";
  return `${insightLine(sentence)}<div class="bars" role="list">${shown.map(row).join("")}</div>${
    rest.length ? `<details class="bars-more"><summary>Show all ${num(list.length)}</summary><div class="bars" role="list">${rest.map(row).join("")}</div></details>` : ""}
    <ul class="chart-key"><li><i class="key-swatch"></i>At or above the line</li><li><i class="key-swatch is-under"></i>Below it</li>${
      line?.value != null ? `<li><i class="key-tick"></i>${esc(lineName)}: ${esc(show(line.value, unit))}</li>` : `<li><i class="key-tick"></i>${esc(lineName)}</li>`}</ul>`;
}

/* ------------------------------------------------------------ before and after, measure by measure */

/** Each measure at two points — the same point of the term before, and
    now — as two dots joined on one scale (0–100 for "%"): how far each
    moved, and which way, in one picture. The earlier dot is hollow, the
    latest solid; the change is said in words beside it (never colour
    alone). A measure with no earlier figure shows only where it is now.
      rows [{ label, before, after, better? ("up"|"down"), note? }]
      from, to  what the two points are ("Term 2 at this point", "Term 3 so far") */
export function dumbbell(rows, { unit = "%", from = "Before", to = "Now", empty = "Nothing to compare yet.", period = "", title = "" } = {}) {
  const list = (rows || []).filter((r) => r.after != null);
  if (!list.length) return none(empty);
  const max = unit === "%" ? 100 : niceTop(Math.max(...list.map((r) => Math.max(r.after, r.before ?? 0))));
  const at = (v) => Math.max(0, Math.min(100, (v / max) * 100));
  const said = `${title ? `${title}: ` : ""}${list.map((r) => `${r.label} ${r.before == null ? "" : `${show(r.before, unit)} to `}${show(r.after, unit)}`).join(", ")}`;
  const row = (r) => {
    const d = r.before == null ? null : round1(r.after - r.before);
    const good = d == null || d === 0 ? null : (r.better === "down" ? d < 0 : d > 0);
    const change = d == null ? "no earlier figure" : d === 0 ? "no change" : `${d > 0 ? "▲ +" : "▼ −"}${Math.abs(d)}${unit === "%" ? " pts" : ""}`;
    const lo = r.before == null ? at(r.after) : Math.min(at(r.before), at(r.after)), hi = r.before == null ? at(r.after) : Math.max(at(r.before), at(r.after));
    const rows2 = [[show(r.after, unit), to.toLowerCase()]];
    if (r.before != null) rows2.push([show(r.before, unit), from.toLowerCase()]);
    return `
    <div class="bars-row db-row" role="listitem"${tip(r.label, rows2, withPeriod([d == null ? "" : change.replace(/^[▲▼] /, ""), r.note].filter(Boolean).join(" · "), period))}>
      <div class="bars-head"><span class="bars-label">${esc(r.label)}</span>
        <span class="bars-val">${r.before != null ? `<small>${esc(show(r.before, unit))} →</small>` : ""}<b>${esc(show(r.after, unit))}</b><small class="db-change${good == null ? "" : good ? " good" : " bad"}">${esc(change)}</small></span></div>
      <div class="db-track">${r.before != null ? `<i class="db-span" style="left:${lo.toFixed(1)}%;width:${(hi - lo).toFixed(1)}%"></i><i class="db-dot db-before" style="left:${at(r.before).toFixed(1)}%"></i>` : ""}<i class="db-dot db-after" style="left:${at(r.after).toFixed(1)}%"></i></div>
    </div>`;
  };
  return `<div class="bars" role="list" aria-label="${esc(said)}">${list.map(row).join("")}</div>
    <ul class="chart-key"><li><i class="key-dot is-before"></i>${esc(from)}</li><li><i class="key-dot"></i>${esc(to)}</li></ul>`;
}

/* ------------------------------------------------------------ columns and a line together */

/** Columns and a line on ONE scale, for measures of the same kind (each
    result this term, last term beside it, and the share of its approved
    target — all percentages). Never two scales on one chart: measures of a
    different kind go in charts of their own, side by side or one above the
    other. One or two column series, side by side, the earlier lighter; the
    line is optional, its colour the card's --chart-line. Every value is in
    the tooltip; a period still under way is paler and says "so far".
      points  [{ label, full?, sub?, partial?, values: { [key]: number|null }, line?: number|null }]
      bars    [{ key, label }]   one or two series, the last one the brand colour
      line    { label }          the line's values are each point's `line`, on the same scale
      unit    the scale's unit ("%" puts it on 0–100) */
export function comboChart(points, { bars = [], line = null, unit = "", noun = "", title = "", empty = "Nothing recorded yet.", period = "", height = 0 } = {}) {
  const pts = points || [];
  const colVals = pts.flatMap((p) => bars.map((b) => p.values?.[b.key])).filter((v) => v != null);
  const lineVals = line ? pts.map((p) => p.line).filter((v) => v != null) : [];
  if (!colVals.some(Boolean) && !lineVals.some(Boolean)) return none(empty);
  const top = unit === "%" ? 100 : niceTop(Math.max(...colVals, ...lineVals, 0));
  const lUnit = unit, lTop = top; // one scale for both
  const y = (v, t) => Math.max(0, Math.min(100, (v / t) * 100));
  const n = pts.length;
  const x = (i) => ((i + 0.5) / n) * 100;
  const series = bars.map((b, i) => ({ ...b, cls: bars.length > 1 && i === 0 ? "is-earlier" : "" }));
  const caps = series.length === 1 && n <= 12;
  const label = (p) => p.full || p.label;
  const said = `${title ? `${title}: ` : ""}${pts.map((p) => `${label(p)} ${[...series.map((b) => `${b.label} ${show(p.values?.[b.key], unit)}`),
    ...(line ? [`${line.label} ${show(p.line, lUnit)}`] : [])].join(", ")}${p.partial ? " so far" : ""}`).join("; ")}`;
  let d = "", pen = false;
  pts.forEach((p, i) => {
    if (p.line == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i).toFixed(2)} ${(100 - y(p.line, lTop)).toFixed(2)} `;
    pen = true;
  });
  const yL = [top, top / 2, 0].map((v) => show(v, unit));
  const width = (ls) => `${(Math.max(...ls.map((l) => l.length)) * 0.58 + 0.2).toFixed(2)}em`;
  const group = (p, i) => {
    const rows = [...series.map((b, k) => [show(p.values?.[b.key], unit), b.label.toLowerCase(), series.length > 1 && k === 0 ? "var(--seq-4)" : "var(--chart-1)"]),
      ...(line ? [[show(p.line, lUnit), line.label.toLowerCase(), "var(--chart-line, var(--cat-2))"]] : [])];
    const note = withPeriod(p.partial ? "So far: this period isn't over" : p.note || "", p.partial ? "" : period);
    return `<div class="cmb-g${p.partial ? " is-partial" : ""}"${tip(label(p), rows, note)}>${series.map((b) => {
      const v = p.values?.[b.key];
      return `<span class="cmb-col ${b.cls}">${caps && v != null ? `<b class="col-val">${esc(show(v, unit))}</b>` : ""}<i class="cmb-bar" style="height:${v == null ? 0 : y(v, top).toFixed(1)}%"></i></span>`;
    }).join("")}${line && p.line != null ? `<i class="cmb-dot" style="bottom:${y(p.line, lTop).toFixed(1)}%" aria-hidden="true"></i>` : ""}</div>`;
  };
  return `<div class="cmb" role="img" aria-label="${esc(said)}"${height ? ` style="--col-h:${height}px"` : ""}>
    <div class="lc-y" style="width:${width(yL)}" aria-hidden="true">${yL.map((l, i) => `<span style="bottom:${100 - i * 50}%">${esc(l)}</span>`).join("")}</div>
    <div class="cmb-plot"><i class="lc-grid" style="bottom:100%"></i><i class="lc-grid" style="bottom:50%"></i>
      ${line ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="cmb-line" d="${d.trim()}"/></svg>` : ""}
      ${pts.map(group).join("")}</div>
    <div class="cmb-x" aria-hidden="true">${pts.map((p) => `<span>${esc(p.label)}${p.sub ? `<small>${esc(p.sub)}</small>` : ""}</span>`).join("")}</div>
  </div><ul class="chart-key">${series.map((b, k) => `<li><i class="key-sw${series.length > 1 && k === 0 ? " is-earlier" : ""}"></i>${esc(b.label)}${noun && series.length === 1 ? ` (${esc(noun)})` : ""}</li>`).join("")}${
    line ? `<li><i class="key-line key-cmb"></i>${esc(line.label)}</li>` : ""}</ul>${
    pts.at(-1)?.partial ? `<p class="chart-note">${esc(label(pts.at(-1)))} isn't over yet: its columns are paler.</p>` : ""}`;
}

/* ------------------------------------------------------------ two measures, one dot per group */

/** Two measures for each group, one dot each — across for one, up for the
    other (schools: work handed in across, average mark up) — so the groups
    doing well on both, or on one, stand out. With `avg`, a dashed line for
    each overall figure divides the plot into four, and one sentence says how
    many groups sit below both. Axes start at zero (0–100 for "%").
      points  [{ label, x, y, base?, href?, note? }]  (base: what both rest on; under 5, not counted in the sentence)
      xAxis / yAxis  { label, unit? }
      avg     { x, y } — the overall figures */
export function scatter(points, { xAxis = {}, yAxis = {}, avg = null, title = "", noun = "groups", empty = "Nothing recorded yet.", period = "", height = 0, insight = false } = {}) {
  const pts = (points || []).filter((p) => p.x != null && p.y != null);
  if (!pts.length) return none(empty);
  const xu = xAxis.unit ?? "", yu = yAxis.unit ?? "";
  const xTop = xu === "%" ? 100 : niceTop(Math.max(...pts.map((p) => p.x)));
  const yTop = yu === "%" ? 100 : niceTop(Math.max(...pts.map((p) => p.y)));
  const px = (v) => Math.max(0, Math.min(100, (v / xTop) * 100));
  const py = (v) => Math.max(0, Math.min(100, (v / yTop) * 100));
  const named = pts.slice(0, 20).map((p) => `${p.label} ${show(p.x, xu)}, ${show(p.y, yu)}`).join("; ");
  const said = `${title ? `${title}: ` : ""}${xAxis.label} across, ${yAxis.label} up. ${named}${pts.length > 20 ? `; and ${pts.length - 20} more` : ""}`;
  let sentence = "";
  if (insight && avg && pts.length >= 3) {
    const judged = pts.filter((p) => (p.base ?? MIN_BASE) >= MIN_BASE);
    const below = judged.filter((p) => p.x < avg.x && p.y < avg.y).length;
    const above = judged.filter((p) => p.x >= avg.x && p.y >= avg.y).length;
    sentence = judged.length >= 3 ? `${above} of ${judged.length} ${noun} are at or above both overall figures; ${below} ${below === 1 ? "is" : "are"} below both.` : "";
  }
  const yL = [yTop, yTop / 2, 0].map((v) => show(v, yu));
  const dot = (p) => {
    const rows = [[show(p.x, xu), xAxis.label.toLowerCase()], [show(p.y, yu), yAxis.label.toLowerCase()]];
    const cls = `sc-dot${avg && p.x < avg.x && p.y < avg.y ? " is-low" : ""}`;
    const at = `left:${px(p.x).toFixed(2)}%;bottom:${py(p.y).toFixed(2)}%`;
    return p.href
      ? `<a class="${cls}" href="${esc(p.href)}" style="${at}" aria-label="${esc(`${p.label}: ${rows.map((r) => r.join(" ")).join(", ")}`)}"${tip(p.label, rows, withPeriod(p.note || "", period))}></a>`
      : `<i class="${cls}" style="${at}"${tip(p.label, rows, withPeriod(p.note || "", period))}></i>`;
  };
  return `${insightLine(sentence)}<div class="sc"${pts.some((p) => p.href) ? ' role="group"' : ' role="img"'} aria-label="${esc(said)}"${height ? ` style="--sc-h:${height}px"` : ""}>
    <div class="sc-yt" aria-hidden="true">${esc(yAxis.label)}</div>
    <div class="lc-y" style="width:${(Math.max(...yL.map((l) => l.length)) * 0.58 + 0.2).toFixed(2)}em" aria-hidden="true">${yL.map((l, i) => `<span style="bottom:${100 - i * 50}%">${esc(l)}</span>`).join("")}</div>
    <div class="sc-plot"><i class="lc-grid" style="bottom:100%"></i><i class="lc-grid" style="bottom:50%"></i><i class="sc-gx" style="left:50%"></i>${
      avg ? `<i class="sc-avg sc-avg-x" style="left:${px(avg.x).toFixed(2)}%"></i><i class="sc-avg sc-avg-y" style="bottom:${py(avg.y).toFixed(2)}%"></i>` : ""}${pts.map(dot).join("")}</div>
    <div class="sc-x" aria-hidden="true"><span>0</span><span>${esc(show(xTop / 2, xu))}</span><span>${esc(show(xTop, xu))}</span></div>
    <div class="sc-xt" aria-hidden="true">${esc(xAxis.label)}</div>
  </div>${avg ? `<ul class="chart-key"><li><i class="key-ref"></i>Dashed: the overall figures, ${esc(show(avg.x, xu))} and ${esc(show(avg.y, yu))}</li>${
    pts.some((p) => avg && p.x < avg.x && p.y < avg.y) ? `<li><i class="key-sw is-low"></i>Below both</li>` : ""}</ul>` : ""}`;
}

/* ------------------------------------------------------------ inside a key figure */

/** A small trend inside a key-figure card — the shape only (the card says
    the numbers): a 2px line, a fading wash, the latest point marked; the
    period still under way left open. Nothing with fewer than three points. */
export function sparkline(values, { partial = false } = {}) {
  const v = (values || []).map((x) => (x == null ? null : Number(x)));
  const known = v.filter((x) => x != null);
  if (known.length < 3) return "";
  const lo = Math.min(...known), hi = Math.max(...known);
  const span = hi - lo || 1;
  const x = (i) => (i / (v.length - 1)) * 100;
  const y = (n) => 30 - ((n - lo) / span) * 24 - 3;
  const pts = v.map((n, i) => (n == null ? null : [x(i), y(n)])).filter(Boolean);
  const solid = partial ? pts.slice(0, -1) : pts;
  const line = solid.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)} ${b.toFixed(1)}`).join(" ");
  const id = `spk${++gradSeq}`;
  const [ex, ey] = pts.at(-1);
  const tail = partial && solid.length ? `<path class="spk-partial" d="M${solid.at(-1)[0].toFixed(1)} ${solid.at(-1)[1].toFixed(1)} L${ex.toFixed(1)} ${ey.toFixed(1)}"/>` : "";
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="lc-fade-top"/><stop offset="1" class="lc-fade-end"/></linearGradient></defs>
    <path d="${line} L${solid.at(-1)[0].toFixed(1)} 30 L${solid[0][0].toFixed(1)} 30 Z" style="fill:url(#${id})" stroke="none"/>
    <path class="spk-line" d="${line}"/>${tail}
  </svg><i class="spk-end${partial ? " is-partial" : ""}" style="left:${ex.toFixed(1)}%;top:${((ey / 30) * 100).toFixed(1)}%" aria-hidden="true"></i>`;
}

/** How far towards an approved target, inside a key-figure card: a bar on
    the target's scale with the target marked (the card's text says the numbers). */
export function meter(value, target, { direction = "increase" } = {}) {
  if (value == null || target == null || !(target > 0)) return "";
  const scaleTop = Math.max(target, value) * 1.12;
  const fill = Math.max(2, Math.min(100, (value / scaleTop) * 100));
  const met = direction === "decrease" ? value <= target : value >= target;
  return `<div class="s-meter${met ? " is-met" : ""}" aria-hidden="true"><span style="width:${fill.toFixed(1)}%"></span><i style="left:${((target / scaleTop) * 100).toFixed(1)}%"></i></div>`;
}

/* ------------------------------------------------------------ a picture inside a result's card

   Each small (about 70px tall) and each a different form, chosen for what
   its result counts. They sit beside the card's own figures, so they draw
   the shape rather than repeat the number — yet each says what it shows to
   a screen reader, and each mark explains itself on hover or tap. */

/** A few periods as small columns, each value on its cap; the latest strongest, the one under way paler. */
export function miniColumns(points, { unit = "", noun = "" } = {}) {
  const list = (points || []).filter((p) => p.value != null);
  if (list.length < 2) return "";
  const top = Math.max(...list.map((p) => p.value)) || 1;
  const said = list.map((p) => `${p.full || p.label}: ${show(p.value, unit)}${p.partial ? " so far" : ""}`).join(", ");
  return `<div class="mini-cols" role="img" aria-label="${esc(said)}">${list.map((p, i) => `<div class="mc${p.partial ? " is-partial" : ""}${i === list.length - 1 ? " is-last" : ""}"${
    tip(p.full || p.label, [[show(p.value, unit), noun]], p.partial ? "So far: this period isn't over" : "")}><b>${esc(show(p.value, unit))}</b><i style="height:${Math.max(6, (p.value / top) * 100).toFixed(1)}%"></i><span>${esc(p.label)}</span></div>`).join("")}</div>`;
}

/** One share of one whole as a ring filling round from the top, the part and the whole in the middle. */
export function ringGauge(value, { part = null, whole = null, noun = "", did = "" } = {}) {
  if (value == null) return "";
  const v = Math.max(0, Math.min(100, value));
  const counts = part != null && whole != null;
  return `<div class="ring-gauge" role="img" aria-label="${esc(`${show(v, "%")}${counts ? `: ${num(part)} of ${num(whole)} ${noun}${did ? ` ${did}` : ""}` : ""}`)}">
    <span class="rg-ring"><svg viewBox="0 0 42 42" aria-hidden="true" focusable="false"><circle class="rg-track" cx="21" cy="21" r="15.9155"/>${
      v > 0 ? `<circle class="rg-fill" cx="21" cy="21" r="15.9155" stroke-dasharray="${v.toFixed(2)} ${(100 - v).toFixed(2)}" stroke-dashoffset="25"/>` : ""}</svg>
      <b>${esc(show(v, "%"))}</b></span>
    ${counts ? `<span class="rg-text"><b>${num(part)}</b> of ${num(whole)} ${esc(noun)}${did ? ` ${esc(did)}` : ""}</span>` : ""}
  </div>`;
}

/** People as figures — one each up to 20, else each stands for several — the first `part` filled. */
export function pictogram(part, whole, { noun = "people", partWord = "", restWord = "not yet" } = {}) {
  if (part == null || !whole) return "";
  const per = Math.max(1, Math.ceil(whole / 20));
  const figures = Math.ceil(whole / per), filled = Math.min(figures, Math.round(part / per));
  const fig = (on) => `<svg class="pg-fig${on ? " is-on" : ""}" viewBox="0 0 12 20" aria-hidden="true" focusable="false"><circle cx="6" cy="3.6" r="3.1"/><path d="M1 19.5v-6.6c0-2.8 2.2-4.8 5-4.8s5 2 5 4.8v6.6z"/></svg>`;
  return `<div class="pictogram" role="img" aria-label="${esc(`${num(part)} of ${num(whole)} ${noun} ${partWord}`)}">
    <div class="pg-row">${Array.from({ length: figures }, (_, i) => fig(i < filled)).join("")}</div>
    <p class="pg-key"><span><i class="is-on"></i>${esc(partWord)} ${num(part)}</span><span><i></i>${esc(restWord)} ${num(whole - part)}</span>${per > 1 ? `<span>each figure ${num(per)} ${esc(noun)}</span>` : ""}</p>
  </div>`;
}

/** Steps, each inside the one before (everyone → active → doing it): centred bars narrowing, each with its count. */
export function ladder(steps, { noun = "" } = {}) {
  const list = (steps || []).filter((s) => s.value != null);
  if (list.length < 2 || !list[0].value) return "";
  const first = list[0].value;
  const said = list.map((s) => `${s.label}: ${num(s.value)}`).join(", ");
  return `<div class="ladder" role="img" aria-label="${esc(said)}">${list.map((s, i) => `<div class="ld-row"${tip(s.label, [[num(s.value), noun], [`${share(s.value, first)}%`, `of ${num(first)}`]])}>
    <span class="ld-head"><span class="ld-label">${esc(s.label)}</span><b class="ld-val">${num(s.value)}</b></span><span class="ld-track"><span class="ld-bar ld-${Math.min(i, 2)}${s.key ? " is-key" : ""}" style="width:${Math.max(4, (s.value / first) * 100).toFixed(1)}%"></span></span></div>`).join("")}</div>`;
}

/** One square per item (a school), filled where it happened, its name on hover. */
export function unitGrid(items, { on = "", off = "not yet", noun = "", max = 120 } = {}) {
  const all = items || [];
  const list = all.slice(0, max);
  if (!list.length) return "";
  const yes = list.filter((x) => x.on).length;
  return `<div class="unit-grid-wrap" role="img" aria-label="${esc(`${num(yes)} of ${num(list.length)} ${noun} ${on}`)}">
    <div class="unit-grid">${list.map((x) => `<i class="${x.on ? "is-on" : ""}"${tip(x.label, [[x.on ? on : off, ""]], x.note || "")}></i>`).join("")}</div>
    <p class="pg-key"><span><i class="is-on sq"></i>${esc(on)} ${num(yes)}</span><span><i class="sq"></i>${esc(off)} ${num(list.length - yes)}</span>${all.length > max ? `<span>the first ${num(max)} shown</span>` : ""}</p>
  </div>`;
}

/** A share on a half dial from 0 to 100: the arc fills to it. */
export function halfGauge(value, { label = "" } = {}) {
  if (value == null) return "";
  const v = Math.max(0, Math.min(100, value));
  const arc = "M5.08 21 A15.92 15.92 0 0 1 36.92 21";
  return `<div class="half-gauge" role="img" aria-label="${esc(`${show(v, "%")}${label ? ` ${label}` : ""}`)}">
    <svg viewBox="0 0 42 23" aria-hidden="true" focusable="false"><path class="hg-track" d="${arc}"/>${v > 0 ? `<path class="hg-fill" d="${arc}" pathLength="100" stroke-dasharray="${v.toFixed(1)} 100"/>` : ""}</svg>
    <span class="hg-scale" aria-hidden="true"><small>0</small><small>${esc(label)}</small><small>100%</small></span>
  </div>`;
}

/* ------------------------------------------------------------ tooltips
   One tooltip for the whole page. Hovering a mark shows it; so does a tap
   (it stays until the next tap or a scroll) and, on a line chart, the
   arrow keys. It repeats what the mark already says in print — nothing can
   be read only by pointing. */

let tipEl = null, tipFor = null;
function tipBox() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "chart-tip";
  tipEl.setAttribute("role", "tooltip");
  tipEl.hidden = true;
  document.body.append(tipEl);
  return tipEl;
}
function showTip(el, pointerX = null, pointerY = null) {
  let data;
  try { data = JSON.parse(el.dataset.tip); } catch { return; }
  const [title, rows = [], note = ""] = data;
  const box = tipBox();
  box.replaceChildren();
  const add = (cls, text, parent = box) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; parent.append(d); return d; };
  if (title) add("ct-title", title);
  for (const [value, label, colour] of rows) {
    const row = add("ct-row", "");
    if (colour) { const k = document.createElement("i"); k.style.background = colour; row.append(k); }
    const b = document.createElement("b"); b.textContent = value; row.append(b);
    if (label) { const s = document.createElement("span"); s.textContent = label; row.append(s); }
  }
  if (note) add("ct-note", note);
  box.hidden = false;
  tipFor?.classList.remove("is-on");
  tipFor = el;
  el.classList.add("is-on");
  // Above the mark (its dot, on a line), kept inside the window; below when there's no room above.
  const r = (el.querySelector("[data-tip-anchor]") || el).getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const cx = pointerX != null && r.width > 120 ? pointerX : r.left + r.width / 2;
  const left = Math.max(8, Math.min(window.innerWidth - b.width - 8, cx - b.width / 2));
  const above = r.top - b.height - 10;
  box.style.left = `${left}px`;
  box.style.top = `${above >= 8 ? above : Math.min(window.innerHeight - b.height - 8, r.bottom + 10)}px`;
}
function hideTip() {
  if (tipEl) tipEl.hidden = true;
  tipFor?.classList.remove("is-on");
  tipFor = null;
}

if (typeof document !== "undefined") {
  const mark = (t) => (t instanceof Element ? t.closest("[data-tip]") : null);
  document.addEventListener("pointerover", (e) => { const m = mark(e.target); if (m) showTip(m, e.clientX, e.clientY); });
  document.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch" || !tipFor) return; // a tap's tooltip stays until the next tap
    if (mark(e.relatedTarget) !== tipFor) hideTip();
  });
  document.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch" && !mark(e.target)) hideTip(); });
  document.addEventListener("scroll", hideTip, { capture: true, passive: true });
  // A line chart takes the keyboard: left and right step through its points.
  document.addEventListener("keydown", (e) => {
    const chart = e.target instanceof Element && e.target.matches(".lc") ? e.target : null;
    if (!chart) return;
    const pts = [...chart.querySelectorAll(".lc-pt")];
    const at = pts.indexOf(tipFor);
    const to = e.key === "ArrowRight" ? Math.min(pts.length - 1, at + 1) : e.key === "ArrowLeft" ? (at < 0 ? pts.length - 1 : Math.max(0, at - 1))
      : e.key === "Home" ? 0 : e.key === "End" ? pts.length - 1 : null;
    if (e.key === "Escape") { hideTip(); return; }
    if (e.key === "Enter" && tipFor?.dataset.drill && chart.contains(tipFor)) { e.preventDefault(); tipFor.click(); return; }
    if (to == null) return;
    e.preventDefault();
    showTip(pts[to]);
  });
  document.addEventListener("focusout", (e) => { if (e.target instanceof Element && e.target.matches(".lc")) hideTip(); });
}
