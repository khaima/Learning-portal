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
   ============================================================ */

import { esc, formatDuration } from "./util.js";
import { fmtValue, ragPill } from "./mel-ui.js";

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

function tile(label, value, sub = "", tone = "") {
  return `<div class="stat-tile${tone ? ` intel-${tone}` : ""}"><div class="s-label">${esc(label)}</div><div class="s-num">${value}</div><div class="s-sub">${sub}</div></div>`;
}
function card(title, meta, body, { wide = false } = {}) {
  return `<div class="chart-card${wide ? " intel-wide" : ""}">
    <div class="chart-card-head"><b>${esc(title)}</b>${meta ? `<span>${meta}</span>` : ""}</div>
    ${body}
  </div>`;
}
const empty = (msg = "Nothing recorded yet.") => `<div class="chart-empty">${esc(msg)}</div>`;

/** Horizontal bars. `max` fixes the scale (100 for percentages). */
function bars(rows, { suffix = "", max = null, note = null, none = "Nothing recorded yet." } = {}) {
  const list = (rows || []).filter((r) => r.value != null);
  if (!list.length || !list.some((r) => r.value)) return empty(none);
  const top = max ?? Math.max(1, ...list.map((r) => r.value));
  return `<div class="bar-chart">${list.map((r) => `
    <div class="bar-row">
      <span class="bar-label" title="${esc(r.label)}">${esc(r.label)}${note && note(r) ? ` <small class="hint-inline">${esc(note(r))}</small>` : ""}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, (r.value / top) * 100)}%"></span></span>
      <span class="bar-num">${num(Math.round(r.value * 10) / 10)}${suffix}</span>
    </div>`).join("")}</div>`;
}

/** Columns over time (e.g. the last 12 months). */
function columns(rows, { label = (l) => l } = {}) {
  if (!(rows || []).some((r) => r.value)) return empty();
  const top = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="col-chart">${rows.map((r) => `
    <div class="col" title="${esc(label(r.label, true))}: ${num(r.value)}">
      <span class="col-num">${r.value ? num(r.value) : ""}</span>
      <span class="col-track"><span class="col-bar" style="height:${(r.value / top) * 100}%"></span></span>
      <span class="col-lbl">${esc(label(r.label))}</span>
    </div>`).join("")}</div>`;
}
/** "2026-09" → "Sep" (or "Sep 2026" in full). */
function monthLabel(ym, full = false) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return ym;
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString(undefined, { month: "short", ...(full ? { year: "numeric" } : {}), timeZone: "UTC" });
}

function table(head, rows, { wrap = true } = {}) {
  if (!rows.length) return empty();
  const t = `<table class="lms-table intel-table"><thead><tr>${head.map((h, i) => `<th${i === 0 ? ' class="lms-name"' : ""}>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="lms-name"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return wrap ? `<div class="lms-table-wrap">${t}</div>` : t;
}

function stats(items) {
  return `<div class="chart-stats" style="grid-template-columns:repeat(${items.length},1fr)">${items.map(([v, l]) => `<div><b>${v}</b><span>${esc(l)}</span></div>`).join("")}</div>`;
}

function bandStrip(bands, counts) {
  const total = Object.values(counts || {}).reduce((a, b) => a + b, 0);
  if (!total) return "";
  return `<div class="intel-bands">${(bands || []).map((b) => {
    const n = counts[b.code] || 0;
    return n ? `<span class="pill band-pill band-${esc(b.code)}" title="${esc(b.label)}">${esc(b.code)} · ${n} (${Math.round((n / total) * 100)}%)</span>` : "";
  }).join(" ")}</div>`;
}

const schoolLink = (name) => `<button type="button" class="intel-link" data-pick-school="${esc(name)}">${esc(name)}</button>`;

/** Actual against target, one bar per place or indicator: the bar is the
    actual (coloured by achievement), the line is the target. */
export function compareBars(rows, unit, { keepEmpty = false, key = true } = {}) {
  const list = (rows || []).filter((r) => keepEmpty || r.value != null || r.target != null);
  if (!list.length) return empty("No values or targets yet.");
  // Each row in its own unit (a row may say so); percentages on a 0–100 scale.
  const uOf = (r) => r.unit || unit;
  const others = list.filter((r) => uOf(r) !== "percent");
  const topOther = Math.max(1, ...others.flatMap((r) => [r.value ?? 0, r.target ?? 0])) * 1.1;
  const at = (r, v) => Math.max(0, Math.min(100, (v / (uOf(r) === "percent" ? 100 : topOther)) * 100));
  return `<div class="bar-chart cmp-chart">${list.map((r) => `
    <div class="bar-row">
      <span class="bar-label" title="${esc(r.label)}">${r.html ?? esc(r.label)}</span>
      <span class="bar-track cmp-track">${r.value != null ? `<span class="bar-fill cmp-${esc(r.status || "no_data")}" style="width:${at(r, r.value)}%"></span>` : ""}${r.target != null ? `<i class="cmp-target" style="left:${at(r, r.target)}%" title="Target ${esc(fmtValue(r.target, uOf(r)))}"></i>` : ""}</span>
      <span class="bar-num">${r.value == null && r.target == null ? `<small class="hint-inline">no data</small>` : fmtValue(r.value, uOf(r))}${r.target != null ? `<small class="hint-inline"> / ${fmtValue(r.target, uOf(r))}</small>` : ""}</span>
    </div>`).join("")}</div>
    ${key ? CMP_KEY : ""}`;
}
const CMP_KEY = `<p class="field-hint cmp-key"><i class="cmp-key-target"></i> target · bar colour: <span class="pill ok">met</span> <span class="pill warm">close (80%+)</span> <span class="pill danger">not met</span></p>`;

/** A line over time: the actual, and the target dashed. */
export function trendSvg(points, unit) {
  if (!(points || []).some((p) => p.value != null || p.target != null)) return empty("No values for any term yet.");
  const W = 640, H = 230, L = 46, R = 18, T = 18, B = 42;
  const vals = points.flatMap((p) => [p.value, p.target]).filter((v) => v != null);
  const raw = Math.max(1, ...vals) * 1.05;
  // Gridlines on round numbers: 0/25/50/75/100% for percentages.
  const p10 = Math.pow(10, Math.floor(Math.log10(raw / 4)));
  const f = raw / 4 / p10;
  const step = unit === "percent" ? 25 : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p10;
  const max = unit === "percent" ? 100 : Math.ceil(raw / step) * step;
  const x = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const path = (key) => {
    let d = "", pen = false;
    points.forEach((p, i) => {
      if (p[key] == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const grid = [];
  for (let v = 0; v <= max + 1e-9; v += step) {
    grid.push(`<line class="t-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="t-lbl" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(fmtValue(v, unit))}</text>`);
  }
  const short = (l) => String(l).replace(/^(\d{4}) Term (\d)$/, "T$2 $1");
  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Actual against target, term by term">
    ${grid.join("")}
    ${points.map((p, i) => `<text class="t-lbl" x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${esc(short(p.label))}</text>`).join("")}
    <path class="t-tgt" d="${path("target")}"/>
    <path class="t-val" d="${path("value")}"/>
    ${points.map((p, i) => p.target != null ? `<circle class="t-tgt-dot" cx="${x(i)}" cy="${y(p.target)}" r="3"><title>${esc(p.label)} target: ${esc(fmtValue(p.target, unit))}</title></circle>` : "").join("")}
    ${points.map((p, i) => p.value != null ? `<circle class="t-dot" cx="${x(i)}" cy="${y(p.value)}" r="4.5"><title>${esc(p.label)}: ${esc(fmtValue(p.value, unit))}${p.valueSource && p.valueSource !== "none" ? ` (${esc(p.valueSource)})` : ""}</title></circle>` : "").join("")}
  </svg>
  <p class="field-hint trend-key"><i class="trend-key-val"></i> actual <i class="trend-key-tgt"></i> target</p>`;
}

/** Gender as totals: any group under 5 is shown as "<5". */
function genderHtml(g, who) {
  if (!g.total) return empty(`No ${who} in view.`);
  if (!g.recorded) {
    return `<p class="chart-empty">Not recorded for any ${who.replace(/s$/, "")} yet. It's optional — ${who === "learners"
      ? "teachers and school heads can add it when adding or editing a learner"
      : "administrators can add it on a staff account"} (female, male or prefer not to say).</p>`;
  }
  const cell = (v) => (v == null ? `<span class="hint-inline" title="Fewer than ${g.threshold ?? 5} — hidden so no one can be picked out">&lt;5</span>` : num(v));
  const keys = ["female", "male", "prefer_not_to_say", "not_recorded"];
  const overall = Object.fromEntries(g.overall.map((x) => [x.key, x.value]));
  return table(["", "Female", "Male", "Prefer not to say", "Not recorded"], [
    [`<b>All</b> <small class="hint-inline">${num(g.total)}</small>`, ...keys.map((k) => cell(overall[k]))],
    ...g.byCounty.map((c) => [`${esc(c.county)} <small class="hint-inline">${num(c.total)}</small>`, ...keys.map((k) => cell(c.values[k]))]),
  ]) + `<p class="field-hint">Recorded for ${num(g.recorded)} of ${num(g.total)} (${pct(g.recordedShare)}). Totals only — any group under 5 shows as &lt;5 so no one can be picked out.</p>`;
}

/* ------------------------------------------------------------ M&E indicators on a dashboard */

/** The M&E indicators tagged for one dashboard, target against actual. */
export function themeIndicatorsHtml(dash, theme, { canManage = false } = {}) {
  if (!dash) return "";
  const rows = dash.indicators.filter((i) => i.dashboardTheme === theme);
  const where = dash.scope?.label ? ` · ${esc(dash.scope.label)}` : "";
  if (!rows.length) {
    return card(`M&E indicators — ${THEMES[theme]}`, dash.period ? esc(dash.period.label) : "", `<p class="chart-empty">No indicators are shown here yet.${canManage
      ? ` Edit an indicator on <a href="#mel-framework">Results framework</a> and choose “Also show on: ${esc(THEMES[theme])}”${theme === "teacher_development" ? " — e.g. “% of teachers integrating ICT”" : ""}.`
      : " M&E chooses which indicators appear on each dashboard."}</p>`, { wide: true });
  }
  return card(`M&E indicators — ${THEMES[theme]}`, `${dash.period ? esc(dash.period.label) : ""}${where} · <a href="#me-dashboard">all indicators</a>`,
    compareBars(rows.map((i) => ({
      label: i.name, html: `<button type="button" class="intel-link" data-mel-dash-ind="${esc(i.id)}">${i.code ? `${esc(i.code)} ` : ""}${esc(i.name)}</button>`,
      value: i.value, target: i.target?.value ?? null, status: i.achievement.status, unit: i.unit,
    })), "percent"), { wide: true });
}

/* ------------------------------------------------------------ 1. executive overview */

export function executiveHtml(d) {
  const E = d.executive, R = d.reach, L = d.learning, T = d.teachers, F = d.fieldOps, S = d.resources;
  const area = (page, title, lines) => `
    <a class="intel-area" href="#${page}">
      <b>${esc(title)}</b>
      ${lines.map(([v, l]) => `<span><strong>${v}</strong> ${esc(l)}</span>`).join("")}
      <em>Open ${esc(title.toLowerCase())} →</em>
    </a>`;
  const c = E.completion;
  return {
    headline: [
      tile("Schools", num(E.schools), `${E.schoolsVisited.visited} visited · ${pct(E.schoolsVisited.coverage)} coverage`),
      tile("Learners", num(E.learners), `active · ${pct(E.activeUsers.learnerShare)} used the portal ${esc(E.activeUsers.window)}`),
      tile("Teachers", num(E.teachers), `${pct(T.training.share)} trained · ${pct(T.activity.participation.active.rate)} active`),
      tile("Active users", num(E.activeUsers.total), `${num(E.activeUsers.learners)} learners · ${num(E.activeUsers.staff)} staff · ${esc(E.activeUsers.window)}`),
      tile("Completion", pct(c.rate), c.assigned ? `${num(c.submitted)}/${num(c.assigned)} pieces of work handed in` : "no work set yet"),
      tile("Library use", `${num(Math.round((E.libraryHours || 0) * 10) / 10)}<small class="s-unit"> hrs</small>`, `${plural(S.opens, "opening")} · ${plural(S.activeUsers.total, "reader")}`),
    ].join(""),
    secondary: [
      tile("Average mark", pct(E.averageMark), L.results.marked ? `${plural(L.results.marked, "piece")} marked${L.results.band ? ` · ${esc(L.results.band)}` : ""} — achievement` : "nothing marked yet"),
      tile("Field visits", num(F.visits.visits), `${F.visits.officersReporting}/${F.visits.officers} officers reporting`),
      tile("Kobo submissions", num(F.kobo.counted), `counted · ${num(F.kobo.totalSubmissions)} received`),
    ].join(""),
    areas: [
      area("reach", "Reach", [
        [`${R.summary.counties}/${R.summary.countiesTotal}`, "counties reached"],
        [`${R.summary.schoolsReached}/${R.summary.schoolsTotal}`, "schools with active learners or teachers"],
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
        [num(F.visits.visits), "field visits"],
        [num(F.forms.visitFormsFilled), F.forms.visitFormsFilled === 1 ? "visit form completed" : "visit forms completed"],
        [pct(F.forms.responseRateOverall), "form response rate"],
      ]),
      area("digital-resources", "Digital resources", [
        [num(S.items.total), "resources published"],
        [num(S.opens), "openings"],
        [S.top[0] ? esc(S.top[0].title) : "—", "most used"],
      ]),
      `<a class="intel-area" href="#me-dashboard" data-exec-mel>
        <b>M&amp;E</b><span>Indicator targets and actuals</span><em>Open M&amp;E →</em>
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
    <em>Open M&amp;E →</em>`;
}

/* ------------------------------------------------------------ 2. reach */

export function reachHtml(d) {
  const R = d.reach, S = R.summary;
  const lg = R.gender.learners;
  return `
    <div class="stat-row">
      ${tile("Counties reached", `${S.counties}/${S.countiesTotal}`, "with active learners or teachers")}
      ${tile("Schools reached", `${S.schoolsReached}/${S.schoolsTotal}`, `${S.schoolsVisited} visited`)}
      ${tile("Learners", num(S.learners), `${num(S.learnersEverEnrolled)} enrolled since the start`)}
      ${tile("Teachers", num(S.teachers), plural(S.fieldOfficers, "field officer"))}
      ${tile("Gender recorded", pct(lg.recordedShare), `for ${num(lg.recorded)} of ${num(lg.total)} learners · optional`)}
    </div>
    <div class="chart-grid">
      ${card("Schools by county", "schools · how many have active learners or teachers",
        bars(R.schoolsByCounty.map((c) => ({ label: c.label, value: c.schools, r: c.reached })), { note: (r) => `${r.r} reached` }))}
      ${card("Learners by county", `${num(S.learners)} active`, bars(R.learnersByCounty))}
      ${card("Teachers by county", `${num(S.teachers)} active`, bars(R.teachersByCounty))}
      ${card("Grade distribution", "active learners by grade", bars(R.grades))}
      ${card("Learners by gender", "where recorded", genderHtml(R.gender.learners, "learners"), { wide: true })}
      ${card("Teachers by gender", "where recorded", genderHtml(R.gender.teachers, "teachers"), { wide: true })}
      ${card("Accounts by role", "active accounts in view", bars(R.accountsByRole))}
      ${card("Teachers by employment type", "BOM or TSC, as each teacher declared", bars(R.teachersByType))}
      ${card("Learner growth", "learners on roll each term · +N joined that term",
        bars(R.growth.map((t) => ({ label: t.label, value: t.learners, j: t.joined })), { note: (r) => `+${r.j}` }))}
      <div class="intel-wide" data-mel-theme="reach"></div>
    </div>`;
}

/* ------------------------------------------------------------ 3. learning */

export function learningHtml(d) {
  const L = d.learning, A = L.assignments, c = L.completion, a = L.results, P = L.progress.learners;
  return `
    <div class="stat-row">
      ${tile("Assignments set", num(A.published + A.closed), `${A.published} open · ${A.closed} closed · ${A.draft} drafts`)}
      ${tile("Completion", pct(c.rate), `${num(c.submitted)}/${num(c.assigned)} handed in · ${c.late} late`)}
      ${tile("Average mark", pct(a.averagePercent), a.marked ? `${plural(a.marked, "piece")} marked${a.band ? ` · ${esc(a.band)}` : ""}` : "nothing marked yet")}
      ${tile("To be marked", num(A.awaitingMarking), "handed in, not yet marked")}
      ${tile("Learners improving", pct(P.improvedShare), P.compared ? `${P.improved} of ${P.compared} with marks in 2+ terms` : "needs marks in two terms")}
    </div>
    <div class="chart-grid">
      ${card("Completion", "work handed in, of what each learner was set", stats([[pct(c.rate), "Rate"], [`${num(c.submitted)}/${num(c.assigned)}`, "Handed in"], [c.late, "Late"], [c.missing, "Missing"]]))}
      ${card("Assessment results", "average mark on marked work — achievement",
        stats([[pct(a.averagePercent), "Average mark"], [esc(a.band || "—"), "Band"], [a.marked, "Marked"]]) + bandStrip(L.bands, a.bands))}
      ${card("Assignments by subject", "set (not drafts)", bars(A.bySubject))}
      ${card("Completion by grade", "% of the work set that was handed in — not marks",
        bars(L.completionByGrade, { suffix: "%", max: 100, note: (r) => `${r.n} set` }))}
      ${card("Results by grade", "average mark on marked work",
        bars(L.resultsByGrade, { suffix: "%", max: 100, note: (r) => `${r.n} marked${r.band ? " · " + r.band : ""}` }))}
      ${card("Subject performance", "completion and results side by side — never combined", table(
        ["Subject", "Handed in", "Average mark", "Marked"],
        L.subjects.map((s) => [esc(s.label), s.assigned ? pct(s.completionRate) : "—", s.marked ? `${pct(s.averagePercent)}${s.band ? ` · ${esc(s.band)}` : ""}` : "—", s.marked])), { wide: true })}
      ${card("Learner progress", "average mark by term — achievement",
        bars(L.progress.byTerm.filter((t) => t.marked).map((t) => ({ label: t.label, value: t.averagePercent, n: t.marked, b: t.band })), { suffix: "%", max: 100, note: (r) => `${r.n} marked${r.b ? " · " + r.b : ""}` }))}
      ${card("Learners' own progress", "each learner's latest term against their first",
        P.compared ? stats([[P.improved, "Improved"], [P.steady, "Steady"], [P.declined, "Declined"]]) + `<p class="field-hint">Of ${plural(P.compared, "learner")} with marked work in two or more terms.</p>` : empty("Shows once learners have marked work in two terms."))}
      ${card("School performance", "completion and results side by side", table(
        ["School", "County", "Learners", "Handed in", "Average mark", "Library"],
        L.schools.map((s) => [schoolLink(s.school), esc(s.county), num(s.learners),
          s.assigned ? pct(s.completionRate) : "—",
          s.marked ? `${pct(s.averagePercent)}${s.band ? ` · ${esc(s.band)}` : ""}` : "—", mins(s.libraryMinutes)])), { wide: true })}
      <div class="intel-wide" data-mel-theme="learning"></div>
    </div>`;
}

/* ------------------------------------------------------------ 4. teacher development */

export function teachersHtml(d) {
  const T = d.teachers, Tr = T.training, D = T.digital, P = T.activity.participation;
  return `
    <div class="stat-row">
      ${tile("Teachers", num(T.total), T.byType.map((t) => `${t.value} ${esc(t.label)}`).join(" · ") || "active")}
      ${tile("Trained", num(Tr.teachersTrained), `${pct(Tr.share)} of teachers · ${plural(Tr.sessions, "session")}`)}
      ${tile("Using digital resources", num(D.teachersUsingLibrary), `${pct(D.share)} of teachers · ${hrs(D.hours)}`)}
      ${tile("Active teachers", num(T.activity.activeInWindow), esc(T.activity.window))}
      ${tile("Setting work", num(P.settingWork.count), `${pct(P.settingWork.rate)} of teachers`)}
      ${tile("Teacher support visits", num(T.activity.supportVisits.visits), plural(T.activity.supportVisits.schools, "school"))}
    </div>
    <div class="chart-grid">
      <div class="intel-wide" data-mel-theme="teacher_development"></div>
      ${card("Training by county", "share of teachers who attended a session",
        bars(Tr.byCounty.map((c) => ({ label: c.label, value: c.share ?? 0, t: c.trained, n: c.teachers })), { suffix: "%", max: 100, note: (r) => `${r.t}/${r.n}` }))}
      ${card("Sessions by kind", plural(Tr.sessions, "session"), bars(Tr.byKind.map((k) => ({ label: KIND_LABEL[k.label] || k.label, value: k.value }))))}
      ${card("Teacher activity", `of ${num(P.teachers)} active teachers`, bars([
        { label: "Active in any way", value: P.active.rate ?? 0 },
        { label: "Set work", value: P.settingWork.rate ?? 0 },
        { label: "Marked work", value: P.marking.rate ?? 0 },
        { label: "Used digital resources", value: P.usingLibrary.rate ?? 0 },
        { label: "Answered forms", value: P.answeringForms.rate ?? 0 },
      ], { suffix: "%", max: 100 }))}
      ${card("Active by county", esc(T.activity.window),
        bars(T.activity.byCounty.map((c) => ({ label: c.label, value: c.share ?? 0, a: c.active, n: c.teachers })), { suffix: "%", max: 100, note: (r) => `${r.a}/${r.n}` }))}
      ${card("Digital resource use", "teachers' own reading in the library",
        stats([[num(D.teachersUsingLibrary), "Teachers"], [hrs(D.hours), "Time"], [num(D.teacherResourceOpens), "Teacher Resources opened"]]))}
    </div>`;
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

export function fieldOpsHtml(d) {
  const F = d.fieldOps, V = F.visits, K = F.kobo, Fm = F.forms;
  return `
    <div class="stat-row">
      ${tile("Field visits", num(V.visits), `by ${plural(V.officersReporting, "officer")} (${V.officers} active)`)}
      ${tile("Schools visited", `${V.schools.visited}/${V.schools.total}`, `${pct(V.schools.coverage)} · ${V.schools.visitedThisTerm} ${esc(V.schools.currentTerm ? `in ${V.schools.currentTerm}` : "this term")}`)}
      ${tile("Visit forms completed", num(Fm.visitFormsFilled), `${pct(Fm.visitsWithFormsShare)} of visits have one`)}
      ${tile("Form response rate", pct(Fm.responseRateOverall), plural(Fm.responses, "response"))}
      ${tile("Kobo submissions", num(K.counted), `counted · ${num(K.totalSubmissions)} received`)}
      ${tile("Kobo needing review", num(K.needsReview), `${K.byStatus.duplicate} duplicates · ${K.byStatus.rejected} rejected in Kobo`, K.needsReview ? "warn" : "")}
    </div>
    <div class="chart-grid">
      ${card("Visit types", "Learning · Infrastructure · ICT · MEP · Teacher support",
        bars(V.byType.map((t) => ({ label: t.label, value: t.visits, s: t.schools })), { note: (r) => `${r.s} school${r.s === 1 ? "" : "s"}` }))}
      ${card("Visits by month", "the last 12 months", columns(F.visitsByMonth, { label: monthLabel }))}
      ${card("Visits by county", "", bars(V.byCounty))}
      ${card("Visits by term", "", bars(V.byTerm))}
      ${card("Schools not visited yet", `${V.schools.total - V.schools.visited} of ${V.schools.total}`,
        V.schools.notVisited.length
          ? `<div class="intel-chips">${V.schools.notVisited.map((n) => `<button type="button" class="pill" data-pick-school="${esc(n)}">${esc(n)}</button>`).join(" ")}</div>`
          : empty("Every school in view has had a visit."))}
      ${card("Completed forms", "who each form reaches against who answered", table(["Form", "For", "Expected", "Received", "Rate"],
        Fm.responseRates.map((r) => [esc(r.label), esc(r.kind === "visit" ? "Visit form" : audience(r.audience)), r.expected, r.received, pct(r.rate)])), { wide: true })}
      ${card("Kobo submissions by month", "received in the last 12 months", columns(K.byMonth, { label: monthLabel }))}
      ${card("Kobo submissions by county", "", bars(K.byCounty))}
      ${card("Kobo surveys", "validated in the portal — only “counted” reaches the dashboards", table(["Survey", "Received", "Counted", "Failing checks", "Duplicates", "Rejected in Kobo", "Officers done"],
        K.forms.map((f) => [esc(f.title), f.submissions, f.counted, f.invalid, f.duplicate, f.rejected, f.officersDone])), { wide: true })}
      ${card("Kobo checks", `${K.schoolsCovered} school${K.schoolsCovered === 1 ? "" : "s"} covered`,
        bars(K.issuesByRule.map((r) => ({ label: KOBO_RULE_LABEL[r.rule] || r.rule, value: r.errors, w: r.warnings })), { note: (r) => r.w ? `+${r.w} warning${r.w === 1 ? "" : "s"}` : "", none: "No submissions are failing a check." })
        + `<p class="field-hint">Submissions failing each check — review them on Kobo Surveys → Data pipeline, or in the <a href="#data-quality">Data Quality Center</a>.</p>`)}
      ${card("Forms by audience", "", bars(Fm.byAudience.map((a) => ({ ...a, label: audience(a.label) }))))}
      <div class="intel-wide" data-mel-theme="field_operations"></div>
    </div>`;
}

/* ------------------------------------------------------------ 6. digital resources */

export function resourcesHtml(d) {
  const S = d.resources, U = S.activeUsers;
  return `
    <div class="stat-row">
      ${tile("Resources", num(S.items.total), `published · ${num(S.neverOpened)} never opened`)}
      ${tile("Opens", num(S.opens), `${num(S.finished)} read to the end`)}
      ${tile("Usage time", hrs(S.hours), "while a resource was open")}
      ${tile("Active users", num(U.total), `${num(U.learners)} learners · ${num(U.staff)} staff`)}
      ${tile("Learner reach", pct(U.learnerReach), "of active learners opened something")}
    </div>
    <div class="chart-grid">
      ${card("Most-used content", "by openings", table(["Resource", "Shelf", "Opens", "Readers", "Time"],
        S.top.map((r) => [esc(r.title), esc(r.destination), num(r.opens), num(r.readers), mins(r.minutes)])), { wide: true })}
      ${card("Opens by month", "the last 12 months", columns(S.byMonth.map((m) => ({ label: m.label, value: m.opens })), { label: monthLabel }))}
      ${card("Usage by term", "sessions and time",
        S.byTerm.length
          ? `<div class="chart-subhead">Sessions</div>${bars(S.byTerm.map((t) => ({ label: t.label, value: t.sessions })))}
             <div class="chart-subhead">Hours</div>${bars(S.byTerm.map((t) => ({ label: t.label, value: Math.round(t.minutes / 6) / 10 })))}`
          : empty())}
      ${card("Resources by shelf", "", bars(S.items.byDestination))}
      ${card("Resources by subject", "", bars(S.items.bySubject))}
      ${card("Resources by type", "", bars(S.items.byType))}
      <div class="intel-wide" data-mel-theme="digital_resources"></div>
    </div>
    <p class="field-hint">Time is how long a resource stayed open in the portal — an honest measure of attention, not proof of reading.</p>`;
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
      <span class="hint-inline">${esc(dash.period?.label || "")} · ${esc(dash.scope.label)}</span>
    </div>
    ${groups.map((g) => `
      <div class="mel-outcome">
        <h3><span class="hint-inline">${esc(g.programme)} ·</span> ${g.outcome.code ? `<span class="code-chip">${esc(g.outcome.code)}</span> ` : ""}${esc(g.outcome.title)}</h3>
        ${compareBars(g.rows.map((i) => ({
          label: i.name, value: i.value, target: i.target?.value ?? null, status: i.achievement.status, unit: i.unit,
          html: `<button type="button" class="intel-link" data-mel-dash-ind="${esc(i.id)}">${i.code ? `${esc(i.code)} ` : ""}${esc(i.name)}</button>`,
        })), "percent", { keepEmpty: true, key: false })}
      </div>`).join("")}
    ${CMP_KEY}
    <p class="field-hint">Values are recorded (or verified) actuals where there is one, otherwise worked out live from the data. Pick an indicator for its trend and its county and school comparison.</p>`;
}

/** One indicator: trend over time, and by county and school. */
export function melIndicatorHtml(ind, trend, breakdown) {
  const unit = ind.unit;
  const row = (r) => ({ label: r.label, value: r.value, target: r.target?.value ?? null, status: r.achievement.status });
  const counties = breakdown ? breakdown.rows.filter((r) => r.scopeType === "county").map(row) : [];
  const schools = breakdown ? breakdown.rows.filter((r) => r.scopeType === "school" && (r.value != null || r.target)).map(row)
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1)) : [];
  return `
    <div class="mel-ind-head">
      <h3 style="margin:.2rem 0">${ind.code ? `<span class="code-chip">${esc(ind.code)}</span> ` : ""}${esc(ind.name)}</h3>
      <span class="hint-inline">${esc(ind.programme?.name || "")}${ind.outcome ? ` · ${esc(ind.outcome.title)}` : ""}</span>
      ${ind.achievement ? `<p style="margin:.4rem 0">${ragPill(ind.achievement)} <span class="hint-inline">${fmtValue(ind.value, unit)} against a target of ${fmtValue(ind.target?.value, unit)}</span></p>` : ""}
    </div>
    <div class="chart-grid">
      ${card("Trend over time", `${esc(trend?.scope?.label || "")} · term by term`, trend ? trendSvg(trend.points, unit) : empty("Loading…"), { wide: true })}
      ${card("County comparison", breakdown ? esc(breakdown.period.label) : "", breakdown ? compareBars(counties, unit, { key: false }) : empty("Loading…"))}
      ${card("School comparison", breakdown ? `${esc(breakdown.period.label)} · schools with a value or target` : "", breakdown ? compareBars(schools.slice(0, 25), unit) : empty("Loading…"))}
    </div>`;
}
