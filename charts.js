/* ============================================================
   HPF Digital Learning Portal — the charts.

   One small set, used on every dashboard, so the same kind of question
   always gets the same kind of picture:

     a measure over time      lineChart    a line — never a number on every point
     comparing groups         barList      one colour; length does the telling
     progress to a target     targetList   a bar that fills towards a marked line
     parts of one whole       donut        four parts at most; more become bars
     an ordered scale         stackBar     one bar, split in order
     counts on a grid         heatmap      a table of cells, one hue light → dark
     how values spread        histogram    columns side by side, one scale
     detailed values          a table      (not here)

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
             one line under the chart instead of each drawing an empty bar */
export function barList(rows, { unit = "", max = null, share: withShare = false, shareOf = null, shareWord = "", sort = false, noun = "", text = null, zeros = "", act = "", empty = "Nothing recorded yet." } = {}) {
  let list = (rows || []).filter((r) => r.value != null);
  if (!list.length || !list.some((r) => r.value)) return none(empty);
  if (sort) list = [...list].sort((a, b) => b.value - a.value);
  const nothing = zeros ? list.filter((r) => !r.value) : [];
  if (nothing.length) list = list.filter((r) => r.value);
  const top = max ?? (unit === "%" ? 100 : Math.max(1, ...list.map((r) => r.value)));
  const total = shareOf ?? list.reduce((t, r) => t + r.value, 0);
  return `<div class="bars" role="list">${list.map((r) => {
    const value = text ? text(r) : show(r.value, unit);
    const part = (withShare || shareOf != null) && total ? `${share(r.value, total)}%` : "";
    const rows = [[value, noun]];
    if (part) rows.push([part, `of ${num(total)}${shareWord ? ` ${shareWord}` : ""}`]);
    // A row that leads somewhere is one big target: its name is the link or button.
    const said = act ? `<span class="sr-only"> — ${esc(act)}</span>` : "";
    const name = r.href ? `<a class="bars-link" href="${esc(r.href)}">${r.html ?? esc(r.label)}${said}</a>`
      : r.drill ? `<button type="button" class="bars-link" data-drill="${esc(JSON.stringify(r.drill))}">${r.html ?? esc(r.label)}${said}</button>`
      : r.html ?? esc(r.label);
    return `
    <div class="bars-row${r.value ? "" : " is-zero"}${r.href || r.drill ? " is-drill" : ""}" role="listitem"${tip(r.label, rows, r.note || "")}>
      <div class="bars-head"><span class="bars-label">${name}</span>
        <span class="bars-val"><b>${esc(value)}</b>${part ? `<small>${part}</small>` : ""}${r.note ? `<small>${esc(r.note)}</small>` : ""}</span></div>
      <div class="bars-track"><span class="bars-fill" style="width:${Math.min(100, (r.value / top) * 100).toFixed(1)}%"></span></div>
    </div>`;
  }).join("")}</div>${nothing.length ? `<p class="chart-note">${esc(zeros)}: ${esc(nothing.map((r) => r.label).join(", "))}.</p>` : ""}`;
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
export function targetList(rows, { fmt = (v) => show(v), keepEmpty = false, empty = "No values or targets yet." } = {}) {
  const list = (rows || []).filter((r) => keepEmpty || r.value != null || r.target != null);
  if (!list.length) return none(empty);
  const LINE = 80; // the target sits 80% of the way along; the rest is room to pass it
  return `<div class="tg" role="list">${list.map((r) => {
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
    <div class="tg-row" role="listitem"${tip(r.label, said, r.value == null ? "No value recorded yet" : hasTarget ? word : "No target set")}>
      <div class="bars-head"><span class="bars-label">${r.html ?? esc(r.label)}</span>
        <span class="bars-val"><b>${esc(value)}</b>${hasTarget ? `<small>target ${esc(fmt(r.target, r.unit))}</small>` : `<small>no target</small>`}${
          r.value != null && hasTarget ? `<span class="pill ${cls}">${word}</span>` : r.value == null ? `<span class="pill">No data</span>` : ""}</span></div>
      <div class="tg-track${hasTarget ? "" : " no-target"}">${width ? `<span class="tg-fill tg-${esc(r.status || "no_data")}" style="width:${width.toFixed(1)}%"></span>` : ""}${
        hasTarget ? `<i class="tg-line" style="left:${LINE}%"></i>` : ""}</div>
    </div>`;
  }).join("")}</div>`;
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
              with the arrow keys and press Enter */
export function lineChart(points, { unit = "", noun = "", target = "", band = null, ticks = null, name = "Actual", title = "", height = 0, drill = false, empty = "Nothing recorded yet." } = {}) {
  const pts = points || [];
  const has = (k) => pts.some((p) => p[k] != null);
  if (!pts.length || !(pts.some((p) => p.value) || (target && has("target")))) return none(empty);
  const n = pts.length;
  const values = pts.flatMap((p) => [p.value, target ? p.target : null]).filter((v) => v != null);
  // A shaded band carries its label above the plot: leave the peak room beneath it.
  const top = unit === "%" ? 100 : niceTop(Math.max(...values) * (band ? 1.2 : 1));
  const x = (i) => ((i + 0.5) / n) * 100;
  const y = (v) => (v / top) * 100;
  const path = (key) => {
    let d = "", pen = false;
    pts.forEach((p, i) => {
      if (p[key] == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(2)} ${(100 - y(p[key])).toFixed(2)} `;
      pen = true;
    });
    return d.trim();
  };
  // The area under a single unbroken series: a wash, so the shape reads at a glance.
  const solid = !target && pts.every((p) => p.value != null);
  const area = solid ? `M${x(0).toFixed(2)} 100 ${pts.map((p, i) => `L${x(i).toFixed(2)} ${(100 - y(p.value)).toFixed(2)}`).join(" ")} L${x(n - 1).toFixed(2)} 100 Z` : "";
  // Label a few points only: every one when there are a handful, otherwise the latest and the highest.
  const known = pts.map((p, i) => (p.value == null ? -1 : i)).filter((i) => i >= 0);
  const last = known.at(-1), peak = known.reduce((m, i) => (pts[i].value > pts[m].value ? i : m), known[0] ?? 0);
  const labelled = new Set(n <= 4 ? known : [last, peak]);
  const dotted = n <= 8;
  const picks = drill && pts.some((p) => p.drill);
  const said = `${title ? `${title}: ` : ""}${pts.map((p) => `${p.full || p.label} ${p.value == null ? "no value" : show(p.value, unit)}${target && p.target != null ? ` (target ${show(p.target, unit)})` : ""}`).join(", ")}${
    picks ? ". Step through the points with the arrow keys; press Enter to show only that period" : ""}`;
  const shown = new Set(ticks ?? pts.map((_, i) => i));
  const yLabels = [top, top / 2, 0].map((v) => show(v, unit));
  return `<div class="lc${picks ? " is-drill" : ""}" tabindex="0" role="img" aria-label="${esc(said)}" data-live-quiet${height ? ` style="--lc-h:${height}px"` : ""}>
    <div class="lc-y" style="width:${(Math.max(...yLabels.map((l) => l.length)) * 0.58 + 0.2).toFixed(2)}em" aria-hidden="true">${yLabels.map((l, i) => `<span style="bottom:${100 - i * 50}%">${esc(l)}</span>`).join("")}</div>
    <div class="lc-plot">
      <i class="lc-grid" style="bottom:100%"></i><i class="lc-grid" style="bottom:50%"></i>
      ${band ? `<i class="lc-band" style="left:${((band.from / n) * 100).toFixed(2)}%"><em>${esc(band.label)}</em></i>` : ""}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        ${area ? `<path class="lc-area" d="${area}"/>` : ""}
        ${target ? `<path class="lc-line lc-line-t" d="${path("target")}"/>` : ""}
        <path class="lc-line" d="${path("value")}"/>
      </svg>
      ${pts.map((p, i) => {
        const rows = [];
        if (p.value != null) rows.push([show(p.value, unit), target ? name.toLowerCase() : noun, "var(--chart-1)"]);
        if (target && p.target != null) rows.push([show(p.target, unit), target.toLowerCase(), "var(--chart-2)"]);
        if (!rows.length) rows.push(["—", "no value"]);
        const pick = picks && p.drill && p.value != null ? ` data-drill="${esc(JSON.stringify(p.drill))}"` : "";
        return `<span class="lc-pt${labelled.has(i) || dotted ? " is-marked" : ""}" style="left:${((i / n) * 100).toFixed(2)}%;width:${(100 / n).toFixed(2)}%"${pick}${tip(p.full || p.label, rows, p.note ? `${p.note}${pick ? " · pick it to see only this period" : ""}` : pick ? "Pick it to see only this period" : "")}>${
          target && p.target != null ? `<i class="lc-dot lc-dot-t" style="bottom:${y(p.target).toFixed(2)}%"></i>` : ""}${
          p.value != null ? `<i class="lc-dot" data-tip-anchor style="bottom:${y(p.value).toFixed(2)}%"></i>` : ""}${
          p.value != null && labelled.has(i) ? `<b class="lc-val" style="bottom:${y(p.value).toFixed(2)}%">${esc(show(p.value, unit))}</b>` : ""}</span>`;
      }).join("")}
    </div>
    <div class="lc-x" aria-hidden="true">${pts.map((p, i) => `<span>${shown.has(i) ? `${esc(p.label)}${p.sub ? `<small>${esc(p.sub)}</small>` : ""}` : ""}</span>`).join("")}</div>
  </div>${target ? `<ul class="chart-key"><li><i class="key-line"></i>${esc(name)}</li><li><i class="key-line key-dash"></i>${esc(target)}</li></ul>` : ""}`;
}

/** "2026-09" → { label: "Sep", full: "September 2026", sub: the year where it starts or changes }. */
export function monthPoints(rows, pick = (r) => r.value) {
  let year = null;
  return (rows || []).map((r) => {
    const [y, m] = String(r.label).split("-").map(Number);
    if (!y || !m) return { label: String(r.label), value: pick(r) };
    const d = new Date(Date.UTC(y, m - 1, 1));
    const sub = y !== year ? String(y) : "";
    year = y;
    return {
      label: d.toLocaleString(undefined, { month: "short", timeZone: "UTC" }), sub,
      full: d.toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }), value: pick(r),
      drill: { month: String(r.label) },
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
  return barList(known.map((p) => ({ label: p.full || p.label, value: p.value, note: p.note, drill: opts.drill ? p.drill : undefined })),
    { unit: opts.unit, noun: opts.noun, empty: opts.empty, act: opts.drill ? "show only this period" : "" });
}

/* ------------------------------------------------------------ parts of one whole */

const CAT = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)"];

function keyList(parts, total, { colours, noun, compact = false }) {
  if (compact) {
    return `<ul class="chart-key">${parts.map((p, i) => `<li${tip(p.label, [[num(p.value), noun], [`${share(p.value, total)}%`, `of ${num(total)}`]])}><i style="background:${p.colour || colours[i]}"></i>${esc(p.label)} <b>${num(p.value)}</b></li>`).join("")}</ul>`;
  }
  return `<ul class="chart-key chart-key-rows">${parts.map((p, i) => `
    <li${tip(p.label, [[num(p.value), noun], [`${share(p.value, total)}%`, `of ${num(total)}`]])}><i style="background:${p.colour || colours[i]}"></i><span>${esc(p.label)}</span><b>${num(p.value)}</b><small>${share(p.value, total)}%</small></li>`).join("")}</ul>`;
}

/** A donut — only for a simple proportion: up to four parts of one whole.
    Each part keeps its colour by its place in the list (not by its size, and
    not by which others happen to be empty), and the key beside it carries
    every number, so the ring is never the only way to read it.
      parts  [{ label, value }]   in their own fixed order
      noun   what is counted ("answers") */
export function donut(parts, { noun = "", empty = "Nothing recorded yet." } = {}) {
  const list = parts || [];
  const total = list.reduce((t, p) => t + (p.value || 0), 0);
  if (!total) return none(empty);
  const live = list.filter((p) => p.value > 0).length;
  const gap = live > 1 ? 1.1 : 0; // a sliver of surface between parts, not an outline around them
  let at = 0;
  const segs = list.map((p, i) => {
    if (!(p.value > 0)) return "";
    const size = (p.value / total) * 100;
    const seg = `<circle class="donut-seg" r="15.915" cx="21" cy="21" fill="none" stroke="${CAT[i]}" stroke-width="5.5" pathLength="100"
      stroke-dasharray="${Math.max(0.5, size - gap).toFixed(2)} ${(100 - Math.max(0.5, size - gap)).toFixed(2)}" stroke-dashoffset="${(-at).toFixed(2)}"${
      tip(p.label, [[num(p.value), noun], [`${share(p.value, total)}%`, `of ${num(total)}`]])}></circle>`;
    at += size;
    return seg;
  }).join("");
  const said = list.map((p) => `${p.label}: ${num(p.value)} (${share(p.value, total)}%)`).join(", ");
  return `<div class="chart-donut-wrap">
    <svg class="donut" viewBox="0 0 42 42" role="img" aria-label="${esc(`${num(total)} ${noun} — ${said}`)}">
      <circle r="15.915" cx="21" cy="21" fill="none" stroke="var(--paper-sunk)" stroke-width="5.5"></circle>
      <g transform="rotate(-90 21 21)">${segs}</g>
      <text x="21" y="${noun ? 19.8 : 21}" class="donut-total" aria-hidden="true">${num(total)}</text>
      ${noun ? `<text x="21" y="25.4" class="donut-noun" aria-hidden="true">${esc(noun)}</text>` : ""}
    </svg>
    ${keyList(list, total, { colours: CAT, noun })}
  </div>`;
}

/** Parts of one whole: a donut when there are two to four of them, bars (each
    with its share) otherwise — a ring with many slices can't be compared,
    and a ring that is all one part says nothing a number doesn't. */
export function proportion(parts, { noun = "", empty, sort = true, zeros = "" } = {}) {
  const list = parts || [];
  const live = list.filter((p) => p.value > 0).length;
  return list.length <= 4 && live >= 2 ? donut(list, { noun, empty }) : barList(list, { share: true, sort, noun, empty, zeros });
}

/** One bar split into the parts of a whole that come in an order — bands,
    how recently, better/same/worse. Each part carries its own colour
    (`colour`, a CSS value) because here colour is the scale.
      parts    [{ label, short?, value, colour }]
      compact  the key on one wrapping line, without shares (a summary card) */
export function stackBar(parts, { noun = "", empty = "Nothing recorded yet.", title = "", compact = false } = {}) {
  const list = parts || [];
  const total = list.reduce((t, p) => t + (p.value || 0), 0);
  if (!total) return none(empty);
  const said = list.map((p) => `${p.label}: ${num(p.value)} (${share(p.value, total)}%)`).join(", ");
  // No figures inside the bar: on a narrow part they'd be clipped, and the key beneath has every one.
  return `<div class="stack" role="img" aria-label="${esc(`${title ? `${title} — ` : ""}${said}`)}">${list.filter((p) => p.value > 0).map((p) =>
    `<span style="flex:${p.value};background:${p.colour}"${tip(p.label, [[num(p.value), noun], [`${share(p.value, total)}%`, `of ${num(total)}`]])}></span>`).join("")}</div>
  ${keyList(list.map((p) => ({ ...p, label: p.short ? `${p.short} — ${p.label}` : p.label })), total, { colours: [], noun, compact })}`;
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
      rows     [{ label, values: [n…], total?, drill?, pickSchool? }]
               drill: the row's name narrows the dashboard ({ county }); pickSchool: to that school
      cols     [{ label, short?, sub?, full?, drill? }]   headings (short: on a phone; full: in the
               tooltip; drill: narrows the dates)
      corner   the rows' heading ("County")
      caption  what the grid counts, read out with the table
      noun     what a cell counts ("visits")
      totals   a last column with each row's total
      act      what picking a row's name does, for screen readers */
export function heatmap(rows, cols, { corner = "", caption = "", noun = "", totals = true, act = "", empty = "Nothing recorded yet." } = {}) {
  const list = rows || [];
  const max = Math.max(0, ...list.flatMap((r) => r.values));
  if (!max) return none(empty);
  const steps = shadeSteps(max);
  const shadeOf = (i) => 4 - steps.length + 1 + i;
  const shade = (v) => (v ? shadeOf(steps.findIndex(([lo, hi]) => v >= lo && v <= hi)) : 0);
  const range = ([lo, hi]) => (lo === hi ? num(lo) : `${num(lo)}–${num(hi)}`);
  const pick = (attr, value, html, how) => `<button type="button" class="bars-link" ${attr}="${esc(value)}">${html}${how ? `<span class="sr-only">: ${esc(how)}</span>` : ""}</button>`;
  // On a phone a column is headed by its short form ("N", "6"); the whole name stays for screen readers.
  const colName = (c) => (c.short ? `<span class="hm-long">${esc(c.label)}</span><span class="hm-short" aria-hidden="true">${esc(c.short)}</span>` : esc(c.label));
  const head = `<tr><th scope="col" class="hm-corner">${esc(corner)}</th>${cols.map((c) => `<th scope="col">${
    c.drill ? pick("data-drill", JSON.stringify(c.drill), colName(c), "show only this period") : colName(c)}${c.sub ? `<small>${esc(c.sub)}</small>` : ""}</th>`).join("")}${
    totals ? `<th scope="col" class="hm-total">Total</th>` : ""}</tr>`;
  const body = list.map((r) => {
    const name = r.drill ? pick("data-drill", JSON.stringify(r.drill), esc(r.label), act) : r.pickSchool ? pick("data-pick-school", r.pickSchool, esc(r.label), act) : esc(r.label);
    const total = r.total ?? r.values.reduce((t, v) => t + v, 0);
    return `<tr><th scope="row">${name}</th>${r.values.map((v, i) => `<td class="hm hm-${shade(v)}"${
      tip(`${r.label} · ${cols[i].full || cols[i].label}`, [[num(v), noun]])}>${v ? num(v) : '<span class="sr-only">0</span>'}</td>`).join("")}${
      totals ? `<td class="hm-total">${num(total)}</td>` : ""}</tr>`;
  }).join("");
  const key = `<ul class="chart-key hm-key" aria-hidden="true"><li><i class="hm-0"></i>None</li>${
    steps.map((s, i) => `<li><i class="hm-${shadeOf(i)}"></i>${range(s)}</li>`).join("")}<li>${esc(noun)} in a cell</li></ul>`;
  return `<div class="hm-wrap"><table class="heatmap">${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ""}<thead>${head}</thead><tbody>${body}</tbody></table></div>${key}`;
}

/* ------------------------------------------------------------ how values spread */

/** A histogram: how many fall in each range of a measure — learners by their
    average mark, in tens. Columns side by side on one scale, each with its
    count, the ranges' edges beneath. Colour only where the ranges mean
    something of their own (the achievement bands), named in the key.
      bins   [{ from, to, value, colour? }]   in order
      unit   "%" after the last edge and in the tooltip
      noun   what is counted ("learners")
      key    [{ label, colour, value }]   what the colours mean, with their counts */
export function histogram(bins, { unit = "", noun = "", key = [], title = "", empty = "Nothing recorded yet." } = {}) {
  const list = bins || [];
  const total = list.reduce((t, b) => t + (b.value || 0), 0);
  if (!total) return none(empty);
  const top = niceTop(Math.max(...list.map((b) => b.value)));
  const yLabels = [top, top / 2, 0].map((v) => show(v));
  const range = (b) => `${b.from}–${b.to}${unit}`;
  const edges = [...list.map((b) => b.from), list.at(-1).to];
  const said = `${title ? `${title}: ` : ""}${list.map((b) => `${range(b)}: ${num(b.value)}`).join(", ")}`;
  return `<div class="hist" role="img" aria-label="${esc(said)}">
    <div class="lc-y" style="width:${(Math.max(...yLabels.map((l) => l.length)) * 0.58 + 0.2).toFixed(2)}em" aria-hidden="true">${yLabels.map((l, i) => `<span style="bottom:${100 - i * 50}%">${esc(l)}</span>`).join("")}</div>
    <div class="hist-plot"><i class="lc-grid" style="bottom:100%"></i><i class="lc-grid" style="bottom:50%"></i>${list.map((b) => `<div class="hist-col"${
      tip(range(b), [[num(b.value), noun, b.colour], [`${share(b.value, total)}%`, `of ${num(total)}`]])}>${
      b.value ? `<b>${num(b.value)}</b><i style="height:${((b.value / top) * 100).toFixed(1)}%;background:${b.colour || "var(--chart-1)"}"></i>` : ""}</div>`).join("")}</div>
    <div class="hist-x" aria-hidden="true">${edges.map((e, i) => `<span>${num(e)}${i === edges.length - 1 ? unit : ""}</span>`).join("")}</div>
  </div>${key.length ? keyList(key, total, { colours: [], noun, compact: true }) : ""}`;
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
  // (A ring's part has the whole ring as its box, so there the pointer itself is the place.)
  const ring = el.matches(".donut-seg") && pointerX != null && pointerY != null;
  const r = ring ? { left: pointerX, right: pointerX, top: pointerY - 6, bottom: pointerY + 6, width: 0 }
    : (el.querySelector("[data-tip-anchor]") || el).getBoundingClientRect();
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
