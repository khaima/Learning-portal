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
import { ICON } from "./navigation.js";
import { barList as bars0, heatmap as heat0, lineChart as line0, marksSpread, monthPoints, proportion as parts0, stackBar as stack0, TARGET_KEY, targetList, termPoints, trendOrBars as trend0 } from "./charts.js";
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

const icon = (name) => (ICON[name] ? `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICON[name]}</svg>` : "");
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
/** A line under a chart that leads to its detail. */
const seeAll = (href, text) => (href ? `<p class="chart-note"><a href="${esc(href)}">${esc(text)} →</a></p>` : "");
/** The latest entry of a series and the one before it, if there are two. */
const lastTwo = (list) => { const l = (list || []).filter(Boolean); return [l.at(-2), l.at(-1)]; };
const monthName = (ym) => {
  const [y, m] = String(ym).split("-").map(Number);
  return y && m ? new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, { month: "long", timeZone: "UTC" }) : String(ym);
};
const warn = (t) => `<b class="warn-text">${t}</b>`;
/** Learners who joined in the latest term: "+11 joined in Term 3". */
const joinedLine = (growth) => {
  if (datedScope) return "";
  const last = (growth || []).at(-1);
  return last?.joined ? `+${num(last.joined)} joined in ${esc(termName(last.label))}` : "";
};
function card(title, meta, body, { wide = false } = {}) {
  return `<div class="chart-card${wide ? " intel-wide" : ""}">
    <div class="chart-card-head"><b>${esc(title)}</b>${meta ? `<span>${meta}</span>` : ""}</div>
    ${body}
  </div>`;
}
/* An empty chart says what is missing and where: "No visits recorded in
   Narok County for this period." — the place and dates are the filters the
   dashboard was drawn with (d.scope; set by forScope() as each one starts). */
let where = " yet";
let datedScope = false; // dates chosen above: figures about "this term" don't describe them
function forScope(d) {
  const s = d.scope || {};
  datedScope = !!(s.from || s.to);
  const place = s.school ? ` at ${s.school}` : s.county ? ` in ${s.county} County` : "";
  where = `${place}${s.from || s.to ? " for this period" : ""}` || " yet";
}
const none = (noun = "") => (/^[a-z][a-z ]*s$/.test(noun) && !/^of /.test(noun) ? `No ${noun} recorded${where}.` : `Nothing recorded${where}.`);
const barList = (rows, o = {}) => bars0(rows, { empty: none(o.noun), ...o });
const lineChart = (points, o = {}) => line0(points, { empty: none(o.noun), ...o });
const trendOrBars = (points, o = {}) => trend0(points, { empty: none(o.noun), ...o });
const proportion = (parts, o = {}) => parts0(parts, { empty: none(o.noun), ...o });
const stackBar = (parts, o = {}) => stack0(parts, { empty: none(o.noun), ...o });
const heatmap = (rows, cols, o = {}) => heat0(rows, cols, { empty: none(o.noun), ...o });
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
const melFirst = (theme) => `<div class="intel-wide" data-live-keep data-mel-theme="${theme}" data-mel-when="some" hidden></div>`;
const melLast = (theme) => `<div class="mel-foot" data-live-keep data-mel-theme="${theme}" data-mel-when="none" hidden></div>`;

function table(head, rows, { wrap = true } = {}) {
  if (!rows.length) return empty();
  const t = `<table class="lms-table intel-table"${rows.length > 3 ? " data-sortable" : ""}><thead><tr>${head.map((h, i) => `<th${i === 0 ? ' class="lms-name"' : ""}>${h}</th>`).join("")}</tr></thead>
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
function bandChart(bands, counts) {
  const parts = (bands || []).map((b, i) => ({ label: b.label, short: b.code, value: counts?.[b.code] || 0, colour: `var(--band-${i + 1})` }));
  if (!parts.some((p) => p.value)) return "";
  return parts.length <= 4 ? stackBar(parts, { noun: "marked", title: "Marked work by band" })
    : barList(parts.map((p) => ({ label: `${p.short} — ${p.label}`, value: p.value })), { share: true, noun: "marked" });
}

const schoolLink = (name) => `<button type="button" class="intel-link" data-pick-school="${esc(name)}">${esc(name)}</button>`;

/** An indicator (or a place's value for one) as a row of the target chart. */
const indicatorRow = (i) => ({
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
    return card(`M&E indicators — ${THEMES[theme]}`, dash.period ? esc(dash.period.label) : "", `<p class="chart-empty">No indicators here yet.${canManage
      ? ` Choose some on <a href="#mel-framework">Results framework</a> (“Also show on: ${esc(THEMES[theme])}”).` : ""}</p>`, { wide: true });
  }
  return card(`M&E indicators — ${THEMES[theme]}`, `${dash.period ? esc(dash.period.label) : ""}${where} · <a href="#me-dashboard">all indicators</a>`,
    targetList(rows.map(indicatorRow), { fmt: fmtValue }) + TARGET_KEY, { wide: true });
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
  return card("Field visits by place and month", `${byCounty ? "Counties" : "Schools"} · last 12 months`,
    heatmap(placeRows(d, V, place), monthCols(V.months), { corner: byCounty ? "County" : "School", caption: "Field visits each month", noun: "visits", act: placeAct(V) }), { wide: true });
}
/** Each learner's average mark, in tens, coloured by the band it falls in; the band totals in the key. */
function marksCard(d, M) {
  if (!M) return "";
  return card("Learners' average marks", M.learners ? `${plural(M.learners, "learner")} · median ${M.median}%` : "",
    marksSpread(M.bins, d.learning?.bands || [], { empty: `No marked work${where}.` }));
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
  return card("Learners by place and grade", byCounty ? "Counties" : "Schools",
    heatmap(placeRows(d, G), G.grades.map((g) => ({ label: g, short: g.replace(/^Grade\s*/i, ""), full: g })),
      { corner: byCounty ? "County" : "School", caption: "Active learners by place and grade", noun: "learners", act: placeAct(G) }), { wide: true });
}

/** The overview's pictures, under the key figures: where and when the visits
    happen, how learners' marks spread, how much work is handed in term by
    term, and when the portal is used. (An API from before them: none.)
    `place(kind, name)`, where given, makes a county's or school's name a link
    (the Super Admin's Overview, which has no filters of its own to narrow). */
function overviewCharts(d, { place = null } = {}) {
  const O = d.overview;
  if (!O) return "";
  const handedIn = card("Work handed in", "By term",
    trendOrBars(termPoints(d.learning.progress.byTerm, (t) => t.completionRate), { unit: "%", noun: "handed in", title: "Work handed in by term", drill: !place, empty: `No work set${where}.` }));
  return visitsHeatCard(d, place) + marksCard(d, O.marks) + handedIn
    + whenCard(O.activity, "When the portal is used", "Opened, handed in and marked · Kenyan time", "actions", "Portal use by day of the week and time of day");
}
/** The same pictures for the Super Admin's Overview: a county or school opens the Executive overview narrowed to it. */
export function overviewPictures(d, href = (kind, name) => `#overview?${kind}=${encodeURIComponent(name)}&via=platform-overview`) {
  forScope(d);
  return overviewCharts(d, { place: href });
}

export function executiveHtml(d, opts = {}) {
  forScope(d);
  const E = d.executive, R = d.reach, L = d.learning, T = d.teachers, F = d.fieldOps, S = d.resources;
  const AREA_ICON = { reach: "globe", learning: "results", "teacher-development": "teacher", "field-operations": "pin", "digital-resources": "book" };
  const area = (page, title, lines) => `
    <a class="intel-area" href="${linkTo(opts, page) || `#${page}`}">
      <b>${icon(AREA_ICON[page])}${esc(title)}</b>
      ${lines.map(([v, l]) => `<span><strong>${v}</strong> ${esc(l)}</span>`).join("")}
      <em aria-hidden="true">→</em>
    </a>`;
  const c = E.completion;
  // The headline is who the programme reaches and how learning is going
  // (console.js adds data quality beside them). Every other figure sits
  // with its own area below, once — not as a tile and again in a card.
  return {
    charts: overviewCharts(d),
    headline: [
      kpiCard({ label: "Schools", icon: "school", value: num(E.schools), href: linkTo(opts, "school-profiles"),
        sub: `${E.schoolsVisited.visited} visited · ${pct(E.schoolsVisited.coverage)} coverage` }),
      kpiCard({ label: "Learners", icon: "cap", value: num(E.learners), href: linkTo(opts, "learners"),
        sub: [joinedLine(R.growth), `${pct(E.activeUsers.learnerShare)} used the portal ${esc(E.activeUsers.window)}`].filter(Boolean).join(" · ") }),
      kpiCard({ label: "Teachers", icon: "teacher", value: num(E.teachers), href: linkTo(opts, "teachers"),
        sub: `${pct(T.training.share)} trained · ${pct(T.activity.participation.active.rate)} active` }),
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
        [num(E.activeUsers.total), `active ${E.activeUsers.total === 1 ? "user" : "users"} ${E.activeUsers.window} · ${plural(E.activeUsers.learners, "learner")}, ${num(E.activeUsers.staff)} staff`],
        [num(R.summary.fieldOfficers), R.summary.fieldOfficers === 1 ? "field officer" : "field officers"],
      ]),
      area("learning", "Learning", [
        [num(L.assignments.published + L.assignments.closed), "assignments set"],
        [num(L.assignments.awaitingMarking), "waiting to be marked"],
        [pct(L.progress.learners.improvedShare), "of learners improving term to term"],
      ]),
      area("teacher-development", "Teacher development", [
        [num(T.training.sessions), T.training.sessions === 1 ? "training session" : "training sessions"],
        [`${num(T.training.teachersTrained)}/${num(T.total)}`, "teachers trained"],
        [num(T.digital.teachersUsingLibrary), "teachers using digital resources"],
      ]),
      area("field-operations", "Field operations", [
        [num(F.visits.visits), `field ${F.visits.visits === 1 ? "visit" : "visits"} · ${F.visits.officersReporting}/${F.visits.officers} officers reporting`],
        [num(F.forms.visitFormsFilled), F.forms.visitFormsFilled === 1 ? "visit form completed" : "visit forms completed"],
        [pct(F.forms.responseRateOverall), "form response rate"],
        [num(F.kobo.counted), `Kobo ${F.kobo.counted === 1 ? "submission" : "submissions"} counted · ${num(F.kobo.totalSubmissions)} received`],
      ]),
      area("digital-resources", "Digital resources", [
        [num(S.items.total), "resources published"],
        [num(S.opens), `${S.opens === 1 ? "opening" : "openings"} · ${plural(S.activeUsers.total, "reader")}`],
        [hrs(E.libraryHours), "of library use"],
        [S.top[0] ? esc(S.top[0].title) : "—", "most used"],
      ]),
      `<a class="intel-area" href="#me-dashboard" data-live-keep data-exec-mel>
        <b>${icon("target")}M&amp;E</b><span>Indicator targets and actuals</span><em aria-hidden="true">→</em>
      </a>`,
    ].join(""),
  };
}

/** The M&E card on the executive overview, once /mel/dashboard is in. */
export function execMelArea(dash) {
  const s = dash.summary;
  const n = dash.indicators.length;
  return `<b>${icon("target")}M&amp;E</b>
    ${n ? `<span><strong>${s.met}</strong> of ${n} indicators met${dash.period ? ` · ${esc(dash.period.label)}` : ""}</span>
      <span><strong>${s.close}</strong> close · <strong>${s.not_met}</strong> not met</span>
      <span><strong>${s.no_data}</strong> without data</span>` : `<span>No indicators set up yet</span>`}
    <em aria-hidden="true">→</em>`;
}

/* ------------------------------------------------------------ 2. reach */

export function reachHtml(d, opts = {}) {
  forScope(d);
  const R = d.reach, S = R.summary;
  const lg = R.gender.learners;
  return `
    <div class="stat-row">
      ${kpiCard({ label: "Counties reached", icon: "globe", value: `${S.counties}/${S.countiesTotal}`, sub: "with active learners or teachers" })}
      ${kpiCard({ label: "Schools reached", icon: "school", value: `${S.schoolsReached}/${S.schoolsTotal}`, sub: `${S.schoolsVisited} visited`, href: linkTo(opts, "school-profiles") })}
      ${kpiCard({ label: "Learners", icon: "cap", value: num(S.learners), href: linkTo(opts, "learners"),
        sub: [joinedLine(R.growth), `${num(S.learnersEverEnrolled)} enrolled since the start`].filter(Boolean).join(" · ") })}
      ${kpiCard({ label: "Teachers", icon: "teacher", value: num(S.teachers), href: linkTo(opts, "teachers"),
        sub: `${pct(d.teachers.training.share)} trained · ${plural(S.fieldOfficers, "field officer")} supporting them` })}
      ${kpiCard({ label: "Gender recorded", icon: "users", value: pct(lg.recordedShare), sub: `for ${num(lg.recorded)} of ${num(lg.total)} learners · optional` })}
    </div>
    <div class="chart-grid">
      ${melFirst("reach")}
      ${card("Schools by county", "",
        barList(byPlace(d, R.schoolsByCounty, (c) => ({ label: c.label, value: c.schools, note: `${c.reached} reached` })), { sort: true, noun: "schools", ...PLACE }))}
      ${card("Learners by county", `${num(S.learners)} active`, barList(byPlace(d, R.learnersByCounty), { share: true, sort: true, noun: "learners", ...PLACE }))}
      ${card("Teachers by county", `${num(S.teachers)} active`, barList(byPlace(d, R.teachersByCounty), { share: true, sort: true, noun: "teachers", ...PLACE })
        + seeAll(linkTo(opts, "teachers"), "All teachers"))}
      ${card("Learner growth", "",
        trendOrBars(termPoints(R.growth, (t) => t.learners, (t) => ({ note: `${num(t.joined)} joined this term` })), { noun: "learners on roll", title: "Learners on roll by term", drill: true }))}
      ${card("Grade distribution", "", barList(R.grades, { share: true, noun: "learners" }))}
      ${gradesHeatCard(d)}
    </div>
    ${more("reach", "Gender, roles, employment", `
      ${card("Learners by gender", "Where recorded", genderHtml(R.gender.learners, "learners"), { wide: true })}
      ${card("Teachers by gender", "Where recorded", genderHtml(R.gender.teachers, "teachers"), { wide: true })}
      ${card("Accounts by role", "", barList(R.accountsByRole, { share: true, sort: true, noun: "accounts" }))}
      ${card("Teachers by employment type", "BOM or TSC", proportion(R.teachersByType, { noun: "teachers" }))}`)}
    ${melLast("reach")}`;
}

/* ------------------------------------------------------------ 3. learning */

export function learningHtml(d, opts = {}) {
  forScope(d);
  const L = d.learning, A = L.assignments, c = L.completion, a = L.results, P = L.progress.learners;
  const band = bandNames(L.bands);
  const byBand = bandChart(L.bands, a.bands);
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
        sub: P.compared ? `${P.improved} of ${P.compared} with marks in two or more terms` : "needs marks in two terms" })}
    </div>
    <div class="chart-grid">
      ${melFirst("learning")}
      ${card("Completion by grade", "Work handed in",
        barList(L.completionByGrade.map((r) => ({ ...r, note: `of ${num(r.n)} set` })), { unit: "%", noun: "handed in" })
        + seeAll(linkTo(opts, "results", { by: "grade" }), "Results by grade, in full"))}
      ${card("Results by grade", "Average mark",
        barList(L.resultsByGrade.map((r) => ({ ...r, note: `${num(r.n)} marked` })), { unit: "%", noun: "average mark" })
        + (byBand ? `<div class="chart-subhead">All marked work, by band</div>${byBand}` : ""))}
      ${marksCard(d, d.overview?.marks)}
      ${card("Learner progress", "Average mark by term",
        trendOrBars(termPoints(terms, (t) => t.averagePercent, (t) => ({ note: `${num(t.marked)} marked${t.band ? ` · ${t.band}` : ""}` })), { unit: "%", noun: "average mark", title: "Average mark by term", drill: true }))}
      ${L.compare ? subjectsCard(L.compare, L.bands) : ""}
      ${card("Subject performance", "", table(
        ["Subject", "Handed in", "Average mark", "Marked"],
        L.subjects.map((s) => [esc(s.label), s.assigned ? rate(s.completionRate) : "—", s.marked ? band.mark(s.averagePercent, s.band) : "—", num(s.marked)]))
        + seeAll(linkTo(opts, "results", { by: "subject" }), "Results by subject, in full"), { wide: true })}
    </div>
    ${more("learning", "Schools, subjects, learners", `
      ${card("School performance", "", table(
        ["School", "County", "Learners", "Handed in", "Average mark", "Library"],
        L.schools.map((s) => [schoolLink(s.school), esc(s.county), num(s.learners),
          s.assigned ? rate(s.completionRate) : "—",
          s.marked ? band.mark(s.averagePercent, s.band) : "—", mins(s.libraryMinutes)])), { wide: true })}
      ${card("Assignments by subject", "Drafts left out",
        barList(A.bySubject.map((s) => ({ ...s, href: linkTo(opts, "assignments", { subject: s.label }) })), { share: true, sort: true, noun: "assignments", act: "see its assignments" }))}
      ${card("Learners' own progress", "Latest term against first",
        P.compared ? stackBar([
          { label: "Improved", value: P.improved, colour: "var(--band-1)" },
          { label: "Steady", value: P.steady, colour: "var(--neutral)" },
          { label: "Declined", value: P.declined, colour: "var(--band-4)" },
        ], { noun: "learners", title: "Learners' own progress" }) + `<p class="chart-note">Of ${plural(P.compared, "learner")} with marked work in two or more terms.</p>` : empty("Shows once learners have marked work in two terms."))}`)}
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
  forScope(d);
  const T = d.teachers, Tr = T.training, D = T.digital, P = T.activity.participation;
  return `
    <div class="stat-row">
      ${kpiCard({ label: "Teachers", icon: "teacher", value: num(T.total), href: linkTo(opts, "teachers"),
        sub: T.byType.filter((t) => t.label !== "Not specified").map((t) => `${t.value} ${esc(t.label)}`).join(" · ") || "active · type not recorded" })}
      ${kpiCard({ label: "Trained", icon: "star", value: num(Tr.teachersTrained), href: linkTo(opts, "training"),
        sub: `${pct(Tr.share)} of teachers · ${plural(Tr.sessions, "session")}` })}
      ${kpiCard({ label: "Using digital resources", icon: "book", value: num(D.teachersUsingLibrary),
        sub: `${pct(D.share)} of teachers · ${hrs(D.hours)} · ${plural(D.teacherResourceOpens, "Teacher Resource")} opened` })}
      ${kpiCard({ label: "Active teachers", icon: "activity", value: num(T.activity.activeInWindow),
        sub: `${esc(T.activity.window)} · ${num(P.settingWork.count)} set work (${pct(P.settingWork.rate)})` })}
      ${kpiCard({ label: "Teacher support visits", icon: "pin", value: num(T.activity.supportVisits.visits), href: linkTo(opts, "field-visits"),
        sub: plural(T.activity.supportVisits.schools, "school") })}
    </div>
    <div class="chart-grid chart-pairs">
      ${melFirst("teacher_development")}
      ${card("Training by county", "% of teachers trained",
        barList(byPlace(d, Tr.byCounty, (c) => ({ label: c.label, value: c.share ?? 0, note: `${num(c.trained)} of ${num(c.teachers)}` })), { unit: "%", noun: "trained", ...PLACE })
        + seeAll(linkTo(opts, "training"), "The training register"))}
      ${card("Sessions by kind", `${plural(Tr.sessions, "session")}`,
        barList(Tr.byKind.map((k) => ({ label: KIND_LABEL[k.label] || k.label, value: k.value })), { share: true, sort: true, noun: "sessions" }))}
      ${card("Teacher activity", `${num(P.teachers)} active teachers`, barList([
        { label: "Active in any way", value: P.active.rate ?? 0, note: `${num(P.active.count)} teachers` },
        { label: "Set work", value: P.settingWork.rate ?? 0, note: `${num(P.settingWork.count)} teachers` },
        { label: "Marked work", value: P.marking.rate ?? 0, note: `${num(P.marking.count)} teachers` },
        { label: "Used digital resources", value: P.usingLibrary.rate ?? 0, note: `${num(P.usingLibrary.count)} teachers` },
        { label: "Answered forms", value: P.answeringForms.rate ?? 0, note: `${num(P.answeringForms.count)} teachers` },
      ], { unit: "%", noun: "of teachers" }))}
      ${card("Active by county", `% active ${esc(T.activity.window)}`,
        barList(byPlace(d, T.activity.byCounty, (c) => ({ label: c.label, value: c.share ?? 0, note: `${num(c.active)} of ${num(c.teachers)}` })), { unit: "%", noun: "active", ...PLACE }))}
    </div>
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
  forScope(d);
  const F = d.fieldOps, V = F.visits, K = F.kobo, Fm = F.forms;
  // This term so far, and last term: two counts side by side, no arrow — a term under way has had less time.
  const [prevT, lastT] = lastTwo(V.byTerm);
  // "so far" is about the term under way: shown only when no dates are chosen above.
  const dated = !!(d.scope?.from || d.scope?.to);
  const termCounts = lastT && !dated ? `${esc(termName(lastT.label))} so far: ${num(lastT.value)}${prevT ? ` · ${esc(termName(prevT.label))}: ${num(prevT.value)}` : ""}` : "";
  const koboAside = [K.needsReview ? warn(`${num(K.needsReview)} need review`) : "", K.byStatus.duplicate ? `${num(K.byStatus.duplicate)} duplicates` : "",
    K.byStatus.rejected ? `${num(K.byStatus.rejected)} rejected in Kobo` : ""].filter(Boolean).join(" · ");
  return `
    <div class="stat-row">
      ${kpiCard({ label: "Field visits", icon: "pin", value: num(V.visits), href: linkTo(opts, "field-visits"),
        sub: [termCounts, `by ${plural(V.officersReporting, "officer")} (${V.officers} active)`].filter(Boolean).join("<br>") })}
      ${kpiCard({ label: "Schools visited", icon: "school", value: `${V.schools.visited}/${V.schools.total}`, href: linkTo(opts, "school-profiles"),
        sub: `${pct(V.schools.coverage)} · ${V.schools.visitedThisTerm} in ${esc(V.schools.currentTerm ? termName(V.schools.currentTerm) : "this term")}` })}
      ${kpiCard({ label: "Visit forms completed", icon: "form", value: num(Fm.visitFormsFilled), sub: `${pct(Fm.visitsWithFormsShare)} of visits have one` })}
      ${kpiCard({ label: "Form response rate", icon: "check", value: pct(Fm.responseRateOverall), href: linkTo(opts, "forms"), sub: plural(Fm.responses, "response") })}
      ${kpiCard({ label: "Kobo submissions", icon: "survey", value: num(K.counted), href: linkTo(opts, "kobo"),
        sub: `counted of ${num(K.totalSubmissions)} received${koboAside ? `<br>${koboAside}` : ""}` })}
    </div>
    <div class="chart-grid">
      ${melFirst("field_operations")}
      ${card("Visits by month", "Last 12 months",
        lineChart(monthPoints(F.visitsByMonth), { noun: "visits", title: "Field visits by month", drill: true }) + seeAll(linkTo(opts, "field-visits"), "Every visit, newest first"))}
      ${card("Schools not visited yet", `${V.schools.total - V.schools.visited} of ${V.schools.total} schools`,
        V.schools.notVisited.length
          ? `<div class="intel-chips">${V.schools.notVisited.map((n) => `<button type="button" class="pill" data-pick-school="${esc(n)}">${esc(n)}</button>`).join(" ")}</div>`
          : empty("Every school in view has had a visit."))}
      ${card("Visit types", "",
        barList(V.byType.map((t) => ({ label: t.label, value: t.visits, note: plural(t.schools, "school"), href: linkTo(opts, "field-visits", { type: t.label }) })), { sort: true, noun: "visits", act: "see these visits" }))}
      ${d.overview ? visitsHeatCard(d) : card("Visits by county", "", barList(byPlace(d, V.byCounty), { share: true, sort: true, noun: "visits", ...PLACE }))}
      ${card("Kobo submissions by month", "Last 12 months",
        lineChart(monthPoints(K.byMonth), { noun: "submissions", title: "Kobo submissions by month", drill: true }) + seeAll(linkTo(opts, "kobo"), "Kobo submissions and their checks"))}
    </div>
    ${more("field-operations", "Forms, Kobo, visits by term", `
      ${card("Completed forms", "Answered, of those reached", table(["Form", "For", "Expected", "Received", "Rate"],
        Fm.responseRates.map((r) => [esc(r.label), esc(r.kind === "visit" ? "Visit form" : audience(r.audience)), num(r.expected), num(r.received), rate(r.rate)])), { wide: true })}
      ${card("Kobo surveys", "Counted submissions only", table(["Survey", "Received", "Counted", "Failing checks", "Duplicates", "Rejected in Kobo", "Officers done"],
        K.forms.map((f) => [esc(f.title), num(f.submissions), num(f.counted), num(f.invalid), num(f.duplicate), num(f.rejected), num(f.officersDone)])), { wide: true })}
      ${card("Kobo checks", `${plural(K.schoolsCovered, "school")}`,
        barList(K.issuesByRule.map((r) => ({ label: KOBO_RULE_LABEL[r.rule] || r.rule, value: r.errors, note: r.warnings ? `+${plural(r.warnings, "warning")}` : "" })), { sort: true, noun: "failing", empty: "No submissions are failing a check." })
        + `<p class="chart-note">Review them on Kobo Surveys → Data pipeline, or in the <a href="#data-quality">Data Quality Center</a>.</p>`)}
      ${card("Kobo submissions by county", "", barList(byPlace(d, K.byCounty), { share: true, sort: true, noun: "submissions", ...PLACE }))}
      ${card("Visits by term", "", trendOrBars(termPoints(V.byTerm), { noun: "visits", title: "Field visits by term", drill: true }))}
      ${card("Forms by audience", "", barList(Fm.byAudience.map((a) => ({ ...a, label: audience(a.label) })), { sort: true, noun: "forms" }))}`, { pairs: true })}
    ${melLast("field_operations")}`;
}

/* ------------------------------------------------------------ 6. digital resources */

export function resourcesHtml(d, opts = {}) {
  forScope(d);
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
    <div class="chart-grid chart-pairs">
      ${melFirst("digital_resources")}
      ${card("Most-used content", "", table(["Resource", "Shelf", "Opens", "Readers", "Time"],
        S.top.map((r) => { const href = linkTo(opts, "content", { q: r.title }); return [href ? `<a href="${esc(href)}">${esc(r.title)}</a>` : esc(r.title), esc(r.destination), num(r.opens), num(r.readers), mins(r.minutes)]; })), { wide: true })}
      ${card("Opens by month", "Last 12 months",
        lineChart(monthPoints(S.byMonth, (m) => m.opens), { noun: "openings", title: "Resource openings by month", drill: true }))}
      ${whenCard(S.when, "When resources are opened", "Kenyan time", "openings", "Resources opened by day of the week and time of day")}
      ${card("Usage by term", "Sessions and hours",
        S.byTerm.length
          ? `<div class="chart-subhead">Sessions</div>${trendOrBars(termPoints(S.byTerm, (t) => t.sessions, (t) => ({ note: `${plural(t.readers, "reader")}` })), { noun: "sessions", height: 84, title: "Reading sessions by term", drill: true })}
             <div class="chart-subhead">Hours</div>${trendOrBars(termPoints(S.byTerm, (t) => Math.round(t.minutes / 6) / 10), { noun: "hours", height: 84, title: "Reading hours by term", drill: true })}`
          : empty())}
    </div>
    <p class="field-hint">Time: how long a resource stayed open.</p>
    ${more("digital-resources", "Shelves, subjects, types", `
      ${card("Resources by shelf", "", proportion(S.items.byDestination, { noun: "resources" }))}
      ${card("Resources by subject", "",
        barList(S.items.bySubject.map((s) => ({ ...s, href: linkTo(opts, "content", { q: s.label }) })), { share: true, sort: true, noun: "resources", act: "find them in the library" }))}
      ${card("Resources by type", "", barList(S.items.byType, { share: true, sort: true, noun: "resources" }))}`)}
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
        ${targetList(g.rows.map(indicatorRow), { fmt: fmtValue, keepEmpty: true })}
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
      ${card("Trend over time", esc(trend?.scope?.label || ""),
        trend ? lineChart(points, { unit: unit === "percent" ? "%" : "", target: "Target", name: "Actual", height: 190, title: `${ind.name} by term`, empty: "No values for any term yet." }) : skeleton(3, { avatar: false }), { wide: true })}
      ${card("County comparison", breakdown ? `Each county's progress to its target · ${esc(breakdown.period.label)}` : "", breakdown ? targetList(counties, { fmt: fmtValue }) : skeleton(3, { avatar: false }))}
      ${card("School comparison", breakdown ? `Schools with a value or a target · ${esc(breakdown.period.label)}` : "", breakdown ? targetList(schools.slice(0, 25), { fmt: fmtValue }) + TARGET_KEY : skeleton(3, { avatar: false }))}
    </div>`;
}
