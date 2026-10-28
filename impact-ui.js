/* ============================================================
   HPF Digital Learning Portal — the impact dashboards.

   Seven views for the Education Team, from one GET /impact read (and
   GET /mel/dashboard for the M&E indicators):

     Executive overview · Reach · Learning · Teacher development ·
     Field operations · Digital resources · M&E

   Every number is computed server-side (supabase/functions/api/impact.ts);
   this file only lays it out. Two measures are never merged: COMPLETION
   (work handed in) and ACHIEVEMENT (the marks on marked work). Gender is
   shown only as totals, with any group under 5 hidden.

   Each page reads top to bottom in the order it's needed
   (docs/DASHBOARD-HIERARCHY.md): the key figures, then — where M&E has
   tagged indicators for the page — target against actual, then the few
   charts that answer the page's question, and last "More detail": the
   long tables and narrower breakdowns, one click away.

   The charts are the shared set in charts.js (docs/CHARTS.md says which
   is used for what): a line for change over time, bars for comparing
   groups, a bar filling towards a line for progress to a target, a donut
   or a split bar for parts of a whole, and a table where the detail is
   the point. Every card says in a line what it shows.
   ============================================================ */

import { esc, formatDuration, skeleton } from "./util.js";
import { fmtValue, ragPill } from "./mel-format.js";
import { barList as bars0, heatmap as heat0, lineChart as line0, marksSpread, monthPoints, periodChip, periodLabel, proportion as parts0, TARGET_KEY, targetList, termPoints, trendOrBars as trend0 } from "./charts.js";
import { kpiCard, periodTrend, termName } from "./kpi.js";
import { compareHtml } from "./compare-ui.js";

const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const num = (v) => (v == null ? "—" : Number(v).toLocaleString());
const mins = (m) => (m ? formatDuration(m * 60) : "0m");
const hrs = (h) => `${num(Math.round((h || 0) * 10) / 10)} hrs`;
const plural = (n, word, many = `${word}s`) => `${num(n)} ${n === 1 ? word : many}`;
const KOBO_RULE_LABEL = {
  required: "Required answers", type: "Answer types", school: "School code", county: "County",
  officer: "Field officer", duplicate: "Duplicates", date: "Dates",
};
const KIND_LABEL = { workshop: "Workshop", cluster: "Cluster meeting", coaching: "Coaching", online: "Online course", other: "Other" };
const AUDIENCE = { teacher: "Teachers", school_leader: "School heads", field_officer: "Field officers" };
const audience = (a) => AUDIENCE[a] || a;
export const THEMES = {
  reach: "Reach", learning: "Learning", teacher_development: "Teacher development",
  field_operations: "Field operations", digital_resources: "Digital resources",
};

/* ------------------------------------------------------------ building blocks */

/* The key figures are kpi.js cards. `opts.canOpen(page)` says which pages
   this person may open: a figure links to its page only then — with any
   filter it needs (`params`) and `via`, the dashboard it came from, so the
   page's breadcrumb leads back here. The county, school and dates chosen
   above go along by themselves (console.js keeps them). */
const linkTo = (opts, page, params = {}) => {
  if (!opts?.canOpen?.(page)) return "";
  const qs = new URLSearchParams(Object.entries({ ...params, via: opts.via || "" }).filter(([, v]) => v)).toString();
  return `#${page}${qs ? `?${qs}` : ""}`;
};
/* Picking a county in a chart narrows the whole dashboard to it (and the
   filter's "×" widens it again). The counties' own names only — "(not set)"
   isn't a place. */
const byPlace = (d, rows, more = (r) => r) => (rows || []).map((r) => ({ ...more(r),
  ...(r.label && !/^\(/.test(r.label) && !d.scope?.county ? { drill: { county: r.label } } : {}) })); // already one county: nothing to narrow
const PLACE = { act: "show only this county" };
/** Where a dashboard's figures come from, at its foot: one plain line. */
const source = (text) => `<p class="field-hint dash-source">Source: ${text}</p>`;
const when = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** How fresh the Kobo records are: when they last synced, and — said plainly — when a sync failed. */
function koboFreshness(d) {
  const F = d.freshness;
  if (!F) return "";
  const failing = F.koboSyncFailing || [];
  return [F.koboLastSynced ? `Kobo surveys last synced ${esc(when(F.koboLastSynced))}.` : "",
    failing.length ? `<b>The last sync failed for ${plural(failing.length, "survey")} (${esc(failing.join(", "))}): their newest records may be missing.</b>` : ""].filter(Boolean).join(" ");
}
/** A line under a chart that leads to its detail. */
const seeAll = (href, text) => (href ? `<p class="chart-note"><a href="${esc(href)}">${esc(text)} →</a></p>` : "");
/** The latest entry of a series and the one before it, if there are two. */
const lastTwo = (list) => { const l = (list || []).filter(Boolean); return [l.at(-2), l.at(-1)]; };
const monthName = (ym) => {
  const [y, m] = String(ym).split("-").map(Number);
  return y && m ? new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, { month: "long", timeZone: "UTC" }) : String(ym);
};
/** Learners who joined in the latest term: "+11 joined in Term 3". */
const joinedLine = (growth) => {
  if (datedScope) return "";
  const last = (growth || []).at(-1);
  return last?.joined ? `+${num(last.joined)} joined in ${esc(termName(last.label))}` : "";
};
/* A chart card: a title that asks the chart's question, what it counts,
   and the dates it covers — the dashboard's (`period`, from the filters)
   unless the chart has its own window ("Last 12 months", "Term by term"). */
function card(title, meta, body, { wide = false, period: when = period } = {}) {
  return `<div class="chart-card${wide ? " intel-wide" : ""}">
    <div class="chart-card-head"><b>${esc(title)}</b>${meta ? `<span>${meta}</span>` : ""}${periodChip(when)}</div>
    ${body}
  </div>`;
}
const LAST_12 = "Last 12 months";
const TERMLY = "Term by term";
const NOW = "On roll now";
/** "in the last 30 days" → "Last 30 days"; "in the period" → the dashboard's dates. */
const windowPeriod = (w) => (/period/.test(w || "") ? period : String(w || "").replace(/^in the /, "").replace(/^./, (c) => c.toUpperCase()));
/* An empty chart says what is missing and where: "No visits recorded in
   Narok County for this period." — the place and dates are the filters the
   dashboard was drawn with (d.scope; set by forScope() as each one starts). */
let where = " yet";
let datedScope = false; // dates chosen above: figures about "this term" don't describe them
let period = "All time"; // the dates the dashboard covers, on every chart
let exportOK = false; // may this person download a table's rows (reports.export)?
let fileTag = "all"; // the filters, in a downloaded file's name
const slug = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function forScope(d, opts = {}) {
  const s = d.scope || {};
  datedScope = !!(s.from || s.to);
  period = periodLabel(s);
  exportOK = !!opts.canExport;
  fileTag = [slug(s.school || s.county || "all"), s.from || s.to ? `${s.from || "start"}-to-${s.to || "today"}` : "all-time"].join("-");
  const place = s.school ? ` at ${s.school}` : s.county ? ` in ${s.county} County` : "";
  where = `${place}${s.from || s.to ? " for this period" : ""}` || " yet";
}
const none = (noun = "") => (/^[a-z][a-z ]*s$/.test(noun) && !/^of /.test(noun) ? `No ${noun} recorded${where}.` : `Nothing recorded${where}.`);
const barList = (rows, o = {}) => bars0(rows, { empty: none(o.noun), period, insight: true, ...o });
const lineChart = (points, o = {}) => line0(points, { empty: none(o.noun), insight: true, ...o });
const trendOrBars = (points, o = {}) => trend0(points, { empty: none(o.noun), insight: true, ...o });
const proportion = (parts, o = {}) => parts0(parts, { empty: none(o.noun), period, ...o });
const heatmap = (rows, cols, o = {}) => heat0(rows, cols, { empty: none(o.noun), period, insight: true, ...o });
const empty = (msg) => `<div class="chart-empty">${esc(msg ?? none())}</div>`;

/** The detail behind a page — long tables and narrower breakdowns — closed
    until it's wanted. `what` says what's inside, so nobody opens it to find out. */
function more(key, what, cards, { pairs = false } = {}) {
  return `<details class="more-detail" data-more="${key}">
    <summary><b>More detail</b><span>${esc(what)}</span></summary>
    <div class="chart-grid${pairs ? " chart-pairs" : ""}">${cards}</div>
  </details>`;
}
/** Where the M&E indicators tagged for a page go (console.js fills them):
    first on the page when there are some; when there are none, the note
    about choosing them waits at the foot instead. */
/* "Key findings" for this dashboard (insights-ui.js), filled by console.js once
   GET /impact/insights is in: kept through a refresh, hidden when there are none. */
const insightSlot = (area, page) => `<div class="insights-slot" data-live-keep data-insights-area="${area}" data-via="${page}" hidden></div>`;
const melFirst = (theme) => `<div class="intel-wide" data-live-keep data-mel-theme="${theme}" data-mel-when="some" hidden></div>`;
const melLast = (theme) => `<div class="mel-foot" data-live-keep data-mel-theme="${theme}" data-mel-when="none" hidden></div>`;

/* A detail table. More than 10 rows: a search box and pages (tables.js).
   `name`: it can be downloaded as CSV, for someone allowed to export —
   the filters above and the search decide which rows. */
function table(head, rows, { wrap = true, name = "" } = {}) {
  if (!rows.length) return empty();
  const t = `<table class="lms-table intel-table"${rows.length > 3 ? " data-sortable" : ""}${rows.length > 10 ? " data-find" : ""}${
    exportOK && name ? ` data-export="${esc(`${name}-${fileTag}`)}"` : ""}><thead><tr>${head.map((h, i) => `<th${i === 0 ? ' class="lms-name"' : ""}>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="lms-name"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return wrap ? `<div class="lms-table-wrap">${t}</div>` : t;
}
/** A percentage in a table, with a thin bar beside it so a column can be scanned. */
const rate = (v) => (v == null ? "—" : `<span class="cell-rate">${pct(v)}<i style="--w:${Math.max(0, Math.min(100, v)).toFixed(0)}%"></i></span>`);

/** A band's code ("ME") with its full name on hover, and the mark that goes with it. */
function bandNames(bands) {
  const names = Object.fromEntries((bands || []).map((b) => [b.code, b.label]));
  const tag = (code) => (code ? `<abbr class="band-abbr" title="${esc(names[code] || code)}">${esc(code)}</abbr>` : "");
  return { tag, mark: (percent, code) => `${rate(percent)}${code ? ` ${tag(code)}` : ""}` };
}
/** Marked work by achievement band: one bar split best to weakest (four
    bands have their own colours; a longer scale is listed as bars). */

const schoolLink = (name) => `<button type="button" class="intel-link" data-pick-school="${esc(name)}">${esc(name)}</button>`;

const VALUE_IS = { verified: "verified actual", recorded: "recorded, not yet verified", live: "worked out live, not yet recorded" };
/** What to read an indicator's value against: its last recorded value before
    this period, its baseline, and whether the value is verified, recorded or live. */
export function indicatorContext(i, periodId = "") {
  const before = (i.history || []).filter((h) => h.period !== periodId).at(-1);
  return [
    before ? `${before.label}: ${fmtValue(before.value, i.unit)}` : "",
    i.baselineValue != null ? `baseline ${fmtValue(i.baselineValue, i.unit)}${i.baselinePeriod ? ` (${i.baselinePeriod})` : ""}` : "",
    i.value != null ? VALUE_IS[i.valueSource] || "" : "",
  ].filter(Boolean).join(" · ");
}

/** An indicator (or a place's value for one) as a row of the target chart. */
const indicatorRow = (i, periodId = "") => ({
  note: indicatorContext(i, periodId),
  label: `${i.code ? `${i.code} ` : ""}${i.name}`,
  html: `<button type="button" class="intel-link" data-mel-dash-ind="${esc(i.id)}">${i.code ? `${esc(i.code)} ` : ""}${esc(i.name)}</button>`,
  value: i.value, target: i.target?.value ?? null, percent: i.achievement.percent, status: i.achievement.status, unit: i.unit,
});

/** Gender as totals: any group under 5 is shown as "<5". */
function genderHtml(g, who) {
  if (!g.total) return empty(`No ${who} in view.`);
  if (!g.recorded) {
    return `<p class="chart-empty">Not recorded for any ${who.replace(/s$/, "")} yet.</p>`;
  }
  const cell = (v) => (v == null ? `<span class="hint-inline" title="Fewer than ${g.threshold ?? 5} — hidden so no one can be picked out">&lt;5</span>` : num(v));
  const keys = ["female", "male", "prefer_not_to_say", "not_recorded"];
  const overall = Object.fromEntries(g.overall.map((x) => [x.key, x.value]));
  return table(["", "Female", "Male", "Prefer not to say", "Not recorded"], [
    [`<b>All</b> <small class="hint-inline">${num(g.total)}</small>`, ...keys.map((k) => cell(overall[k]))],
    ...g.byCounty.map((c) => [`${esc(c.county)} <small class="hint-inline">${num(c.total)}</small>`, ...keys.map((k) => cell(c.values[k]))]),
  ]) + `<p class="field-hint">Recorded for ${num(g.recorded)} of ${num(g.total)} (${pct(g.recordedShare)}) · groups under 5 show as &lt;5</p>`;
}

/* ------------------------------------------------------------ M&E indicators on a dashboard */

/** The M&E indicators tagged for one dashboard, target against actual. */
export function themeIndicatorsHtml(dash, theme, { canManage = false } = {}) {
  if (!dash) return "";
  const rows = dash.indicators.filter((i) => i.dashboardTheme === theme);
  const where = dash.scope?.label ? ` · ${esc(dash.scope.label)}` : "";
  if (!rows.length) {
    return card(`Progress against M&E targets — ${THEMES[theme]}`, "", `<p class="chart-empty">No indicators here yet.${canManage
      ? ` Choose some on <a href="#mel-framework">Results framework</a> (“Also show on: ${esc(THEMES[theme])}”).` : ""}</p>`, { wide: true });
  }
  return card(`Progress against M&E targets — ${THEMES[theme]}`, `Each indicator's actual against its approved target${where} · <a href="#me-dashboard">all indicators</a>`,
    targetList(rows.map((i) => indicatorRow(i, dash.period?.id)), { fmt: fmtValue, period: dash.period?.label || "" }) + TARGET_KEY, { wide: true, period: dash.period?.label || "" });
}

/* ------------------------------------------------------------ 1. executive overview */

/** The overview's pictures, under the key figures: where and when the visits
    happen, how learners' marks spread, how much work is handed in term by
    term, and when the portal is used. (An API from before them: none.)
    `place(kind, name)`, where given, makes a county's or school's name a link
    (the Super Admin's Overview, which has no filters of its own to narrow). */
/* ---- the grids and spreads, shared by the overview and the area dashboards ---- */

/** A grid's rows by place: a county's name narrows the dashboard to it, a
    school's to that school — or, with `place(kind, name)`, opens that link. */
function placeRows(d, grid, place = null) {
  const s = d.scope || {};
  const byCounty = grid.rowsAre === "county";
  return grid.rows.map((r) => ({ ...r,
    ...(place ? { href: place(byCounty ? "county" : "school", r.label) }
      : byCounty && !s.county ? { drill: { county: r.label } } : !byCounty && !s.school ? { pickSchool: r.label } : {}) }));
}
const placeAct = (grid) => (grid.rowsAre === "county" ? "show only this county" : "show only this school");
/** Twelve months as heatmap columns. Plain headings: twelve can't be finger-sized (a month line picks one). */
const monthCols = (months) => monthPoints(months.map((m) => ({ label: m, value: 0 }))).map(({ drill: _, ...m }) => ({ ...m, short: m.label.slice(0, 1) }));
/** Field visits by place × month. */
function visitsHeatCard(d, place = null) {
  const V = d.overview?.visits;
  if (!V) return "";
  const byCounty = V.rowsAre === "county";
  return card("Where and when field visits happened", `Visits each month, by ${byCounty ? "county" : "school"}`,
    heatmap(placeRows(d, V, place), monthCols(V.months), { corner: byCounty ? "County" : "School", caption: "Field visits each month", noun: "visits", act: placeAct(V), period: LAST_12 }), { wide: true, period: LAST_12 });
}
/** Each learner's average mark, in tens, coloured by the band it falls in; the band totals in the key. */
function marksCard(d, M) {
  if (!M) return "";
  return card("How learners' average marks are spread", M.learners ? `Each learner's average on marked work · ${plural(M.learners, "learner")} · median ${M.median}%` : "Each learner's average on marked work",
    marksSpread(M.bins, d.learning?.bands || [], { empty: `No marked work${where}.`, period }));
}
/** Counts by day of the week × three-hour block (Kenyan time). */
function whenCard(A, title, sub, noun, caption) {
  if (!A) return "";
  return card(title, sub, heatmap(A.days.map((day, i) => ({ label: day, values: A.cells[i] })), A.blocks.map((b) => ({ label: b, short: b.split("–")[0], full: `${b} h` })),
    { corner: "", caption, noun }), { wide: true });
}
/** Active learners by place × grade. */
function gradesHeatCard(d) {
  const G = d.reach?.gradeByPlace;
  if (!G) return "";
  const byCounty = G.rowsAre === "county";
  return card("Where learners are, by grade", `Learners on roll, by ${byCounty ? "county" : "school"}`,
    heatmap(placeRows(d, G), G.grades.map((g) => ({ label: g, short: g.replace(/^Grade\s*/i, ""), full: g })),
      { corner: byCounty ? "County" : "School", caption: "Active learners by place and grade", noun: "learners", act: placeAct(G), period: NOW, insight: "Largest" }), { wide: true, period: NOW });
}

/** The overview's pictures, under the key figures: where and when the visits
    happen, how learners' marks spread, how much work is handed in term by
    term, and when the portal is used. (An API from before them: none.)
    `place(kind, name)`, where given, makes a county's or school's name a link
    (the Super Admin's Overview, which has no filters of its own to narrow). */
function overviewCharts(d, { place = null } = {}) {
  const O = d.overview;
  if (!O) return "";
  const handedIn = card("How much set work is handed in, term by term", "% of set work handed in",
    trendOrBars(termPoints(d.learning.progress.byTerm, (t) => t.completionRate), { unit: "%", noun: "handed in", title: "Work handed in by term", drill: !place, empty: `No work set${where}.` }), { period: TERMLY });
  return visitsHeatCard(d, place) + marksCard(d, O.marks) + handedIn;
}
/** When the portal is used — a question about the system, not the
    programme: on the Super Admin's Platform overview, not the Executive
    overview (docs/DASHBOARD-HIERARCHY.md). */
export function overviewPictures(d) {
  forScope(d);
  const O = d.overview;
  return O ? whenCard(O.activity, "By day and time", "Resources opened, work handed in and marked · Kenyan time", "actions", "Portal use by day of the week and time of day") : "";
}

export function executiveHtml(d, opts = {}) {
  forScope(d, opts);
  const E = d.executive, R = d.reach, L = d.learning, T = d.teachers, F = d.fieldOps, S = d.resources;
  const area = (page, title, lines) => `
    <a class="intel-area" href="${linkTo(opts, page) || `#${page}`}">
      <b>${esc(title)}</b>
      ${lines.map(([v, l]) => `<span><strong>${v}</strong> ${esc(l)}</span>`).join("")}
      <em aria-hidden="true">→</em>
    </a>`;
  const c = E.completion;
  // The headline is who the programme reaches and how learning is going
  // (console.js adds data quality beside them). Every other figure sits
  // with its own area below, once — not as a tile and again in a card.
  const counts = [
    ["Schools", "The programme's schools registered on the portal, in the county or school chosen above. Visited: had a field visit in the period."],
    ["Learners", "Learners on roll now (active enrolment) at those schools. Used the portal: started or handed in work, or opened a library resource."],
    ["Teachers", "Active teacher accounts at those schools. Trained: attended a session in the training register. Active: set or marked work, opened a resource or answered a form."],
    ["Completion", "Work handed in, out of all work set: each published assignment counts once for every learner it was set for. Drafts are left out."],
    ["Average mark", "The mean percentage of every piece of work teachers marked on the portal — classwork, not a standardised assessment."],
  ];
  const defs = `<details class="more-detail intel-wide exec-defs" data-more="exec-defs"><summary><b>What these figures count</b><span>Definitions, and what each leaves out</span></summary>
    <dl class="defs">${counts.map(([t, x]) => `<dt>${esc(t)}</dt><dd>${esc(x)}</dd>`).join("")}</dl></details>`;
  return {
    charts: defs + overviewCharts(d),
    headline: [
      kpiCard({ label: "Schools", icon: "school", value: num(E.schools), href: linkTo(opts, "school-profiles"),
        sub: `${E.schoolsVisited.visited} visited · ${pct(E.schoolsVisited.coverage)} coverage` }),
      kpiCard({ label: "Learners", icon: "cap", value: num(E.learners), href: linkTo(opts, "learners"),
        sub: [joinedLine(R.growth), `${pct(E.activeUsers.learnerShare)} used the portal ${esc(E.activeUsers.window)}`].filter(Boolean).join(" · ") }),
      kpiCard({ label: "Teachers", icon: "teacher", value: num(E.teachers), href: linkTo(opts, "teachers"),
        sub: `${T.training.recorded === false ? "training not recorded yet" : `${pct(T.training.share)} trained`} · ${pct(T.activity.participation.active.rate)} active` }),
      kpiCard({ label: "Completion", icon: "assignment", value: pct(c.rate), href: linkTo(opts, "learning"),
        trend: periodTrend(L.progress.byTerm, (t) => t.completionRate),
        sub: c.assigned ? `${num(c.submitted)} of ${num(c.assigned)} pieces of work handed in` : "no work set yet" }),
      kpiCard({ label: "Average mark", icon: "results", value: pct(E.averageMark), href: linkTo(opts, "learning"),
        trend: periodTrend(L.progress.byTerm.filter((t) => t.marked), (t) => t.averagePercent),
        sub: L.results.marked ? `${plural(L.results.marked, "piece")} marked${L.results.band ? ` · ${esc(L.results.band)}` : ""}` : "nothing marked yet" }),
    ].join(""),
    areas: [
      area("reach", "Reach", [
        [`${R.summary.counties}/${R.summary.countiesTotal}`, "counties reached"],
        [`${R.summary.schoolsReached}/${R.summary.schoolsTotal}`, "schools with active learners or teachers"],
        [num(E.activeUsers.total), `active ${E.activeUsers.total === 1 ? "participant" : "participants"} ${E.activeUsers.window} · ${plural(E.activeUsers.learners, "learner")}, ${num(E.activeUsers.staff)} school and field staff`],
        [num(R.summary.fieldOfficers), R.summary.fieldOfficers === 1 ? "field officer" : "field officers"],
      ]),
      area("learning", "Learning", [
        [num(L.assignments.published + L.assignments.closed), "assignments set"],
        [num(L.assignments.awaitingMarking), "waiting to be marked"],
        [pct(L.progress.learners.improvedShare), "of learners improving term to term"],
      ]),
      area("teacher-development", "Teacher development", [
        [num(T.training.sessions), T.training.sessions === 1 ? "training session" : "training sessions"],
        T.training.recorded === false ? ["—", "teachers trained: no sessions in the register yet"] : [`${num(T.training.teachersTrained)}/${num(T.total)}`, "teachers trained"],
        [num(T.digital.teachersUsingLibrary), "teachers using digital resources"],
      ]),
      area("field-operations", "Field operations", [
        [num(F.visits.visits), `field ${F.visits.visits === 1 ? "visit" : "visits"} · ${F.visits.officersReporting}/${F.visits.officers} officers reporting`],
        [num(F.forms.visitFormsFilled), F.forms.visitFormsFilled === 1 ? "visit form completed" : "visit forms completed"],
        [pct(F.forms.responseRateOverall), "form response rate"],
        [num(F.kobo.counted), `Kobo ${F.kobo.counted === 1 ? "submission" : "submissions"} counted · ${num(F.kobo.totalSubmissions)} received${
          d.freshness?.koboLastSynced ? ` · synced ${esc(when(d.freshness.koboLastSynced))}` : ""}${d.freshness?.koboSyncFailing?.length ? " · last sync failed" : ""}`],
      ]),
      area("digital-resources", "Digital resources", [
        [num(S.items.total), "resources published"],
        [num(S.opens), `${S.opens === 1 ? "opening" : "openings"} · ${plural(S.activeUsers.total, "reader")}`],
        [hrs(E.libraryHours), "of library use"],
        [S.top[0] ? esc(S.top[0].title) : "—", "most used"],
      ]),
      `<a class="intel-area" href="#me-dashboard" data-live-keep data-exec-mel>
        <b>M&amp;E</b><span>Indicator targets and actuals</span><em aria-hidden="true">→</em>
      </a>`,
    ].join(""),
  };
}

/** The M&E card on the executive overview, once /mel/dashboard is in. */
export function execMelArea(dash) {
  const s = dash.summary;
  const n = dash.indicators.length;
  return `<b>M&amp;E</b>
    ${n ? `<span><strong>${s.met}</strong> of ${n} indicators met${dash.period ? ` · ${esc(dash.period.label)}` : ""}</span>
      <span><strong>${s.close}</strong> close · <strong>${s.not_met}</strong> not met</span>
      <span><strong>${s.no_data}</strong> without data</span>` : `<span>No indicators set up yet</span>`}
    <em aria-hidden="true">→</em>`;
}

/* ------------------------------------------------------------ 2. reach */

export function reachHtml(d, opts = {}) {
  forScope(d, opts);
  const R = d.reach, S = R.summary;
  const lg = R.gender.learners;
  // One row per county: its schools (on the portal, of all), learners and
  // teachers — side by side rather than three charts of four bars each. A
  // county's name narrows the dashboard to it.
  const learnersIn = new Map(R.learnersByCounty.map((c) => [c.label, c.value]));
  const teachersIn = new Map(R.teachersByCounty.map((c) => [c.label, c.value]));
  const countyName = (c) => (!d.scope?.county && !/^\(/.test(c)
    ? `<button type="button" class="bars-link" data-drill="${esc(JSON.stringify({ county: c }))}">${esc(c)}<span class="sr-only">: show only this county</span></button>` : esc(c));
  const counties = [...R.schoolsByCounty].sort((a, b) => (learnersIn.get(b.label) ?? 0) - (learnersIn.get(a.label) ?? 0) || b.schools - a.schools || a.label.localeCompare(b.label));
  return `
    <div class="stat-row">
      ${kpiCard({ label: "Counties reached", icon: "globe", value: `${S.counties}/${S.countiesTotal}`, sub: "with active learners or teachers" })}
      ${kpiCard({ label: "Schools on the portal", icon: "school", value: `${S.schoolsReached}/${S.schoolsTotal}`, sub: `with active learners or teachers · ${S.schoolsVisited} visited`, href: linkTo(opts, "school-profiles") })}
      ${kpiCard({ label: "Learners", icon: "cap", value: num(S.learners), href: linkTo(opts, "learners"),
        sub: [joinedLine(R.growth), `${num(S.learnersEverEnrolled)} enrolled since the start`].filter(Boolean).join(" · ") })}
      ${kpiCard({ label: "Teachers", icon: "teacher", value: num(S.teachers), href: linkTo(opts, "teachers"),
        sub: `${pct(d.teachers.training.share)} trained · ${plural(S.fieldOfficers, "field officer")} supporting them` })}
    </div>
    ${insightSlot("reach", "reach")}
    <div class="chart-grid">
      ${melFirst("reach")}
      ${card("Reach in each county", d.scope?.county ? "Schools on the portal of all schools · learners · teachers" : "Schools on the portal of all schools · learners · teachers · pick a county to see only it",
        table(["County", "Schools on the portal", "Learners", "Teachers"],
          counties.map((c) => [countyName(c.label), `${num(c.reached)} of ${num(c.schools)}`, num(learnersIn.get(c.label) ?? 0), num(teachersIn.get(c.label) ?? 0)]), { name: "reach-by-county" })
        + seeAll(linkTo(opts, "teachers"), "All teachers"), { wide: true })}
      ${card("Learners on roll, term by term", "Learners enrolled at some point in each term",
        trendOrBars(termPoints(R.growth, (t) => t.learners, (t) => ({ note: `${num(t.joined)} joined this term` })), { noun: "learners on roll", title: "Learners on roll by term", drill: true }), { period: TERMLY })}
      ${gradesHeatCard(d)}
    </div>
    ${more("reach", "Gender, employment", `
      ${card("Learners by gender", `Recorded for ${pct(lg.recordedShare)} (${num(lg.recorded)} of ${num(lg.total)}) · optional`, genderHtml(R.gender.learners, "learners"), { wide: true, period: NOW })}
      ${card("Teachers by gender", "Where recorded", genderHtml(R.gender.teachers, "teachers"), { wide: true, period: "Active now" })}
      ${card("How teachers are employed", "BOM or TSC, of active teachers", proportion(R.teachersByType, { noun: "teachers", period: "Active now" }), { period: "Active now" })}`)}
    ${source("schools, learner and staff accounts in the portal.")}
    ${melLast("reach")}`;
}

/* ------------------------------------------------------------ 3. learning */

export function learningHtml(d, opts = {}) {
  forScope(d, opts);
  const L = d.learning, A = L.assignments, c = L.completion, a = L.results, P = L.progress.learners;
  const band = bandNames(L.bands);
  const terms = L.progress.byTerm.filter((t) => t.marked);
  return `
    <div class="stat-row">
      ${kpiCard({ label: "Assignments set", icon: "assignment", value: num(A.published + A.closed), href: linkTo(opts, "assignments"),
        sub: `${A.published} open · ${A.closed} closed · ${A.draft} drafts` })}
      ${kpiCard({ label: "Completion", icon: "check", value: pct(c.rate), href: linkTo(opts, "assignments"),
        trend: periodTrend(L.progress.byTerm, (t) => t.completionRate),
        sub: `${num(c.submitted)} of ${num(c.assigned)} handed in · ${c.late} late · ${c.missing} missing` })}
      ${kpiCard({ label: "Average mark", icon: "results", value: pct(a.averagePercent), href: linkTo(opts, "results"),
        trend: periodTrend(terms, (t) => t.averagePercent),
        sub: a.marked ? `${plural(a.marked, "piece")} marked${a.band ? ` · ${band.tag(a.band)}` : ""}` : "nothing marked yet" })}
      ${kpiCard({ label: "To be marked", icon: "clock", value: num(A.awaitingMarking), tone: A.awaitingMarking ? "warn" : "", href: linkTo(opts, "assignments"),
        sub: A.awaitingMarking ? "handed in, waiting for a mark" : "nothing waiting" })}
      ${kpiCard({ label: "Learners improving", icon: "activity", value: pct(P.improvedShare),
        sub: P.compared ? `${P.improved} improved · ${P.steady} steady · ${P.declined} declined, of ${P.compared} with marks in two terms<br>Different work each term: not a like-for-like test` : "needs marks in two terms" })}
    </div>
    ${insightSlot("learning", "learning")}
    <div class="chart-grid">
      ${melFirst("learning")}
      ${card("Which grades hand in their work", "% of set work handed in",
        barList(L.completionByGrade.map((r) => ({ ...r, base: r.n, note: `of ${num(r.n)} set` })), { unit: "%", noun: "handed in", compare: { value: c.rate, label: "all grades" } })
        + seeAll(linkTo(opts, "results", { by: "grade" }), "Results by grade, in full"))}
      ${card("Average mark in each grade", "Average mark on marked work",
        barList(L.resultsByGrade.map((r) => ({ ...r, base: r.n, note: `${num(r.n)} marked` })), { unit: "%", noun: "average mark", compare: { value: a.averagePercent, label: "all grades" } }))}
      ${marksCard(d, d.overview?.marks)}
      ${card("Average mark, term by term", "Average mark on marked work",
        trendOrBars(termPoints(terms, (t) => t.averagePercent, (t) => ({ note: `${num(t.marked)} marked${t.band ? ` · ${t.band}` : ""}` })), { unit: "%", noun: "average mark", title: "Average mark by term", drill: true }), { period: TERMLY })}
      ${L.compare ? subjectsCard(L.compare, L.bands) : ""}
    </div>
    ${more("learning", "Subjects, schools", `
      ${card("How each subject is doing", "Work handed in and average mark, subject by subject", table(
        ["Subject", "Handed in", "Average mark", "Marked"],
        L.subjects.map((s) => [esc(s.label), s.assigned ? rate(s.completionRate) : "—", s.marked ? band.mark(s.averagePercent, s.band) : "—", num(s.marked)]), { name: "subjects" })
        + seeAll(linkTo(opts, "results", { by: "subject" }), "Results by subject, in full"), { wide: true })}
      ${card("How each school is doing", "Learners, work handed in, average mark and library time", table(
        ["School", "County", "Learners", "Handed in", "Average mark", "Library"],
        L.schools.map((s) => [schoolLink(s.school), esc(s.county), num(s.learners),
          s.assigned ? rate(s.completionRate) : "—",
          s.marked ? band.mark(s.averagePercent, s.band) : "—", mins(s.libraryMinutes)]), { name: "schools" }), { wide: true })}
      ${card("Work set in each subject", "Assignments published (drafts left out)",
        barList(A.bySubject.map((s) => ({ ...s, href: linkTo(opts, "assignments", { subject: s.label }) })), { share: true, sort: true, noun: "assignments", act: "see its assignments" }))}`)}
    ${source("assignments and marks recorded in the portal. Kobo learner assessments are not included yet.")}
    ${melLast("learning")}`;
}

/** Which subject does best: across the schools in view — or, with one school in view, its grades. */
function subjectsCard(cmp, bands = []) {
  const bySchool = (cmp.school?.rows || []).filter((r) => r.marked).length >= 2;
  const d = bySchool ? cmp.school : cmp.grade;
  if (!d) return "";
  return card("Which subject does best?", bySchool ? "subjects across schools" : "subjects across grades",
    compareHtml({ ...d, bands }, { rowsBy: bySchool ? "school" : "grade" }), { wide: true });
}

/* ------------------------------------------------------------ 4. teacher development */

export function teachersHtml(d, opts = {}) {
  forScope(d, opts);
  const T = d.teachers, Tr = T.training, D = T.digital, P = T.activity.participation;
  return `
    <div class="stat-row">
      ${kpiCard({ label: "Teachers", icon: "teacher", value: num(T.total), href: linkTo(opts, "teachers"),
        sub: T.byType.filter((t) => t.label !== "Not specified").map((t) => `${t.value} ${esc(t.label)}`).join(" · ") || "active · type not recorded" })}
      ${kpiCard({ label: "Trained", icon: "star", value: Tr.recorded === false ? "—" : num(Tr.teachersTrained), href: linkTo(opts, "training"),
        sub: Tr.recorded === false ? "No sessions in the training register yet" : `${pct(Tr.share)} of teachers · ${plural(Tr.sessions, "session")}` })}
      ${kpiCard({ label: "Using digital resources", icon: "book", value: num(D.teachersUsingLibrary),
        sub: `${pct(D.share)} of teachers · ${hrs(D.hours)} · ${plural(D.teacherResourceOpens, "Teacher Resource")} opened` })}
      ${kpiCard({ label: "Active teachers", icon: "activity", value: num(T.activity.activeInWindow),
        sub: `${esc(T.activity.window)} · ${num(P.settingWork.count)} set work (${pct(P.settingWork.rate)})` })}
      ${kpiCard({ label: "Teacher support visits", icon: "pin", value: num(T.activity.supportVisits.visits), href: linkTo(opts, "field-visits"),
        sub: plural(T.activity.supportVisits.schools, "school") })}
    </div>
    ${insightSlot("teachers", "teacher-development")}
    <div class="chart-grid chart-pairs">
      ${melFirst("teacher_development")}
      ${card("Share of teachers trained, by county", "% of active teachers who attended a session",
        barList(Tr.recorded === false ? [] : byPlace(d, Tr.byCounty, (c) => ({ label: c.label, value: c.share ?? 0, base: c.teachers, note: `${num(c.trained)} of ${num(c.teachers)}` })),
          { unit: "%", noun: "trained", sort: true, compare: { value: Tr.share, label: "all counties" }, empty: "No sessions in the training register yet.", ...PLACE })
        + seeAll(linkTo(opts, "training"), "The training register"))}
      ${card("Training sessions, by kind", `${plural(Tr.sessions, "session")}`,
        barList(Tr.byKind.map((k) => ({ label: KIND_LABEL[k.label] || k.label, value: k.value })), { share: true, sort: true, noun: "sessions" }))}
      ${card("What teachers do on the portal", `% of ${plural(P.teachers, "active teacher")} who did each`, barList([
        { label: "Active in any way", value: P.active.rate ?? 0, note: `${num(P.active.count)} teachers` },
        { label: "Set work", value: P.settingWork.rate ?? 0, note: `${num(P.settingWork.count)} teachers` },
        { label: "Marked work", value: P.marking.rate ?? 0, note: `${num(P.marking.count)} teachers` },
        { label: "Used digital resources", value: P.usingLibrary.rate ?? 0, note: `${num(P.usingLibrary.count)} teachers` },
        { label: "Answered forms", value: P.answeringForms.rate ?? 0, note: `${num(P.answeringForms.count)} teachers` },
      ], { unit: "%", noun: "of teachers" }))}
      ${card("Share of teachers active, by county", `% of teachers who did anything on the portal ${esc(T.activity.window)}`,
        barList(byPlace(d, T.activity.byCounty, (c) => ({ label: c.label, value: c.share ?? 0, base: c.teachers, note: `${num(c.active)} of ${num(c.teachers)}` })), { unit: "%", noun: "active", sort: true, period: windowPeriod(T.activity.window), compare: { value: T.total ? (T.activity.activeInWindow / T.total) * 100 : null, label: "all counties" }, ...PLACE }), { period: windowPeriod(T.activity.window) })}
    </div>
    ${source("the training register, teachers' activity in the portal and field visits.")}
    ${melLast("teacher_development")}`;
}

/** The training register list. */
export function trainingListHtml(list, { canManage = false, archived = false } = {}) {
  if (!list.length) {
    return `<div class="empty-state">${archived ? "No sessions." : "No training sessions recorded yet."}${canManage && !archived ? " Use “Record a session” to add the first, with who attended." : ""}</div>`;
  }
  return list.map((t) => `
    <div class="task-row" data-training="${esc(t.id)}">
      <div style="flex:1;min-width:0"><b>${esc(t.title)}</b>
        <span>${esc(KIND_LABEL[t.kind] || t.kind)} · ${esc(new Date(t.heldOn + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }))}${t.endsOn && t.endsOn !== t.heldOn ? ` – ${esc(new Date(t.endsOn + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }))}` : ""}
          · ${esc(t.school || (t.county ? `${t.county} County` : "No one place"))} · ${plural(t.attendees, "teacher")}${t.archived ? ` · <span class="pill">Archived</span>` : ""}</span></div>
      <button type="button" class="btn btn-outline q-small">${canManage ? "Open" : "View"}</button>
    </div>`).join("");
}

/* ------------------------------------------------------------ 5. field operations */

export function fieldOpsHtml(d, opts = {}) {
  forScope(d, opts);
  const F = d.fieldOps, V = F.visits, K = F.kobo, Fm = F.forms;
  // This term so far, and last term: two counts side by side, no arrow — a term under way has had less time.
  const [prevT, lastT] = lastTwo(V.byTerm);
  // "so far" is about the term under way: shown only when no dates are chosen above.
  const dated = !!(d.scope?.from || d.scope?.to);
  const termCounts = lastT && !dated ? `${esc(termName(lastT.label))} so far: ${num(lastT.value)}${prevT ? ` · ${esc(termName(prevT.label))}: ${num(prevT.value)}` : ""}` : "";
  return `
    <div class="stat-row">
      ${kpiCard({ label: "Field visits", icon: "pin", value: num(V.visits), href: linkTo(opts, "field-visits"),
        sub: [termCounts, `by ${plural(V.officersReporting, "officer")} (${V.officers} active)`,
          V.notLinked ? `${num(V.notLinked)} not linked to a portal school` : ""].filter(Boolean).join("<br>") })}
      ${kpiCard({ label: "Schools visited", icon: "school", value: `${V.schools.visited}/${V.schools.total}`, href: linkTo(opts, "school-profiles"),
        sub: `${pct(V.schools.coverage)} · ${V.schools.visitedThisTerm} in ${esc(V.schools.currentTerm ? termName(V.schools.currentTerm) : "this term")}` })}
      ${kpiCard({ label: "Visit forms completed", icon: "form", value: num(Fm.visitFormsFilled), sub: `${pct(Fm.visitsWithFormsShare)} of visits have one` })}
      ${kpiCard({ label: "Form response rate", icon: "check", value: pct(Fm.responseRateOverall), href: linkTo(opts, "forms"),
        sub: Fm.responseRateOverall == null ? "No forms sent to staff yet" : plural(Fm.responses, "response") })}
      ${kpiCard({ label: "Survey records", icon: "survey", value: num(K.counted), href: linkTo(opts, "kobo"),
        sub: [`from ${plural(K.forms.length, "Kobo survey")} · ${plural(K.schoolsCovered, "school")}`,
          K.countedNoSchool ? `${num(K.countedNoSchool)} name no portal school` : ""].filter(Boolean).join("<br>") })}
    </div>
    ${insightSlot("field", "field-operations")}
    <div class="chart-grid">
      ${melFirst("field_operations")}
      ${card("Field visits, month by month", "Visits recorded each month",
        lineChart(monthPoints(F.visitsByMonth), { noun: "visits", title: "Field visits by month", drill: true }) + seeAll(linkTo(opts, "field-visits"), "Every visit, newest first"), { period: LAST_12 })}
      ${card("Schools not visited yet", `${V.schools.total - V.schools.visited} of ${V.schools.total} schools`,
        V.schools.notVisited.length
          ? `<div class="intel-chips">${V.schools.notVisited.map((n) => `<button type="button" class="pill" data-pick-school="${esc(n)}">${esc(n)}</button>`).join(" ")}</div>`
          : empty("Every school in view has had a visit."))}
      ${card("What field visits were for", "Visits by type",
        barList(V.byType.map((t) => ({ label: t.label, value: t.visits, note: plural(t.schools, "school"), href: linkTo(opts, "field-visits", { type: t.label }) })), { sort: true, noun: "visits", act: "see these visits" }))}
      ${d.overview ? visitsHeatCard(d) : card("Field visits in each county", "Visits and each county's share", barList(byPlace(d, V.byCounty), { share: true, sort: true, noun: "visits", ...PLACE }))}
      ${card("Survey records collected, month by month", "Kobo records that passed their checks",
        lineChart(monthPoints(K.byMonth), { noun: "records", title: "Survey records by month", drill: true }) + seeAll(linkTo(opts, "kobo"), "Kobo surveys and their checks"), { period: LAST_12 })}
    </div>
    ${more("field-operations", "Forms, survey records by county", `
      ${card("Forms answered, of those sent", "Responses received against responses expected", table(["Form", "For", "Expected", "Received", "Rate"],
        Fm.responseRates.map((r) => [esc(r.label), esc(r.kind === "visit" ? "Visit form" : audience(r.audience)), num(r.expected), num(r.received), rate(r.rate)]), { name: "forms" }), { wide: true })}
      ${card("Survey records in each county", "Records and each county's share", barList(byPlace(d, K.byCounty), { share: true, sort: true, noun: "records", ...PLACE }))}`, { pairs: true })}
    ${source(`field visit reports, forms and Kobo survey records that passed their checks.${linkTo(opts, "kobo") ? ` Checks and the data pipeline: <a href="${esc(linkTo(opts, "kobo"))}">Kobo surveys</a>.` : ""} ${koboFreshness(d)}`)}
    ${melLast("field_operations")}`;
}

/* ------------------------------------------------------------ 6. digital resources */

export function resourcesHtml(d, opts = {}) {
  forScope(d, opts);
  const S = d.resources, U = S.activeUsers;
  const [prevM, lastM] = lastTwo(S.byMonth);
  const monthCounts = lastM && !(d.scope?.from || d.scope?.to) ? `${esc(monthName(lastM.label))} so far: ${num(lastM.opens)}${prevM ? ` · ${esc(monthName(prevM.label))}: ${num(prevM.opens)}` : ""}` : "";
  return `
    <div class="stat-row">
      ${kpiCard({ label: "Resources", icon: "book", value: num(S.items.total), href: linkTo(opts, "content"),
        sub: `published · ${num(S.neverOpened)} never opened` })}
      ${kpiCard({ label: "Opens", icon: "activity", value: num(S.opens), sub: [monthCounts, `${num(S.finished)} read to the end`].filter(Boolean).join("<br>") })}
      ${kpiCard({ label: "Usage time", icon: "clock", value: num(Math.round((S.hours || 0) * 10) / 10), unit: "hrs", sub: "while a resource was open" })}
      ${kpiCard({ label: "Active users", icon: "users", value: num(U.total),
        sub: `${num(U.learners)} learners — ${pct(U.learnerReach)} of active learners · ${num(U.staff)} staff` })}
    </div>
    ${insightSlot("resources", "digital-resources")}
    <div class="chart-grid chart-pairs">
      ${melFirst("digital_resources")}
      ${card("Which resources are used most", "Opens, readers and time, most opened first", table(["Resource", "Shelf", "Opens", "Readers", "Time"],
        S.top.map((r) => { const href = linkTo(opts, "content", { q: r.title }); return [href ? `<a href="${esc(href)}">${esc(r.title)}</a>` : esc(r.title), esc(r.destination), num(r.opens), num(r.readers), mins(r.minutes)]; }), { name: "resources" }), { wide: true })}
      ${card("Usage in detail", "Opens week by week, when, by school and by topic",
        `<p class="chart-few">Opens over time, who opens resources, when, school by school and by topic are on Content usage.</p>`
        + seeAll(linkTo(opts, "content-usage"), "Content usage"), { period: "" })}
    </div>
    ${more("digital-resources", "Shelves, subjects, types", `
      ${card("What the library holds, by shelf", "Published resources and each shelf's share", proportion(S.items.byDestination, { noun: "resources", period: "Published now" }), { period: "Published now" })}
      ${card("What the library holds, by subject", "Published resources and each subject's share",
        barList(S.items.bySubject.map((s) => ({ ...s, href: linkTo(opts, "content", { q: s.label }) })), { share: true, sort: true, noun: "resources", act: "find them in the library", period: "Published now" }), { period: "Published now" })}
      ${card("What the library holds, by type", "Published resources and each type's share", barList(S.items.byType, { share: true, sort: true, noun: "resources", period: "Published now" }), { period: "Published now" })}`)}
    ${source(`library opens recorded in the portal; time is how long a resource stayed open.${S.hpf?.opens ? ` ${plural(S.hpf.opens, "open")} by HPF staff checking content ${S.hpf.opens === 1 ? "is" : "are"} left out.` : ""}`)}
    ${melLast("digital_resources")}`;
}

/* ------------------------------------------------------------ 7. M&E */

export function melDashHtml(dash, { canManage = false } = {}) {
  if (!dash.indicators.length) {
    return `<div class="empty-state">No indicators yet. ${canManage ? "Set up programmes, outcomes and indicators on the <a href=\"#mel-framework\">Results framework</a> page." : "M&E sets them up on the Results framework page."}</div>`;
  }
  const s = dash.summary;
  const groups = [];
  for (const i of dash.indicators) {
    const key = `${i.programme.id}|${i.outcome.id}`;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, programme: i.programme.name, outcome: i.outcome, rows: [] });
    g.rows.push(i);
  }
  return `
    <div class="mel-summary">
      <span class="pill ok">${s.met} met</span><span class="pill warm">${s.close} close</span>
      <span class="pill danger">${s.not_met} not met</span><span class="pill">${s.no_data} without data</span>
    </div>
    ${groups.map((g) => `
      <div class="mel-outcome">
        <h3><span class="hint-inline">${esc(g.programme)} ·</span> ${g.outcome.code ? `<span class="code-chip">${esc(g.outcome.code)}</span> ` : ""}${esc(g.outcome.title)}</h3>
        ${targetList(g.rows.map((i) => indicatorRow(i, dash.period?.id)), { fmt: fmtValue, keepEmpty: true })}
      </div>`).join("")}
    <p class="chart-note"><i class="tg-key" aria-hidden="true"></i>Bar: actual · line: target · <b>met</b> 100%+ · <b>close</b> 80%+ · recorded where entered, otherwise live.</p>`;
}

/** One indicator: trend over time, and by county and school. */
export function melIndicatorHtml(ind, trend, breakdown) {
  const unit = ind.unit;
  const row = (r) => ({ label: r.label, value: r.value, target: r.target?.value ?? null, percent: r.achievement.percent, status: r.achievement.status, unit });
  const counties = breakdown ? breakdown.rows.filter((r) => r.scopeType === "county").map(row) : [];
  const schools = breakdown ? breakdown.rows.filter((r) => r.scopeType === "school" && (r.value != null || r.target)).map(row)
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1)) : [];
  const points = trend ? termPoints(trend.points, (p) => p.value, (p) => ({
    target: p.target, note: p.valueSource && p.valueSource !== "none" ? `Actual: ${p.valueSource}` : "",
  })) : [];
  return `
    <div class="mel-ind-head">
      <h3 style="margin:.2rem 0">${ind.code ? `<span class="code-chip">${esc(ind.code)}</span> ` : ""}${esc(ind.name)}</h3>
      <span class="hint-inline">${esc(ind.programme?.name || "")}${ind.outcome ? ` · ${esc(ind.outcome.title)}` : ""}</span>
      ${ind.achievement ? `<p style="margin:.4rem 0">${ragPill(ind.achievement)} <span class="hint-inline">${fmtValue(ind.value, unit)} against a target of ${fmtValue(ind.target?.value, unit)}</span></p>` : ""}
    </div>
    <div class="chart-grid">
      ${card("Actual against target, term by term", `Actual and the approved target, one scale${trend?.scope?.label ? ` · ${esc(trend.scope.label)}` : ""}`,
        trend ? lineChart(points, { unit: unit === "percent" ? "%" : "", target: "Target", name: "Actual", height: 190, title: `${ind.name} by term`, empty: "No values for any term yet.", insight: true }) : skeleton(3, { avatar: false }), { wide: true, period: TERMLY })}
      ${card("Progress to target in each county", "Each county's actual against its target", breakdown ? targetList(counties, { fmt: fmtValue, period: breakdown.period.label }) : skeleton(3, { avatar: false }), { period: breakdown?.period.label || "" })}
      ${card("Progress to target in each school", "Schools with a value or a target, highest first", breakdown ? targetList(schools, { fmt: fmtValue, period: breakdown.period.label, top: 25 }) + TARGET_KEY : skeleton(3, { avatar: false }), { period: breakdown?.period.label || "" })}
    </div>`;
}
