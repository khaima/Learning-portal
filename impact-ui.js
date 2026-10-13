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

import { esc, formatDuration } from "./util.js";
import { fmtValue, ragPill } from "./mel-format.js";
import { ICON } from "./navigation.js";
import { barList, lineChart, monthPoints, proportion, stackBar, TARGET_KEY, targetList, termPoints, trendOrBars } from "./charts.js";

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
function tile(label, value, sub = "", tone = "", iconName = "") {
  return `<div class="stat-tile${tone ? ` intel-${tone}` : ""}"><div class="s-label">${icon(iconName)}${esc(label)}</div><div class="s-num">${value}</div><div class="s-sub">${sub}</div></div>`;
}
function card(title, meta, body, { wide = false } = {}) {
  return `<div class="chart-card${wide ? " intel-wide" : ""}">
    <div class="chart-card-head"><b>${esc(title)}</b>${meta ? `<span>${meta}</span>` : ""}</div>
    ${body}
  </div>`;
}
const empty = (msg = "Nothing recorded yet.") => `<div class="chart-empty">${esc(msg)}</div>`;

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
  const t = `<table class="lms-table intel-table"><thead><tr>${head.map((h, i) => `<th${i === 0 ? ' class="lms-name"' : ""}>${h}</th>`).join("")}</tr></thead>
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
  return card(`M&E indicators — ${THEMES[theme]}`, `Progress to this term's targets · ${dash.period ? esc(dash.period.label) : ""}${where} · <a href="#me-dashboard">all indicators</a>`,
    targetList(rows.map(indicatorRow), { fmt: fmtValue }) + TARGET_KEY, { wide: true });
}

/* ------------------------------------------------------------ 1. executive overview */

export function executiveHtml(d) {
  const E = d.executive, R = d.reach, L = d.learning, T = d.teachers, F = d.fieldOps, S = d.resources;
  const AREA_ICON = { reach: "globe", learning: "results", "teacher-development": "teacher", "field-operations": "pin", "digital-resources": "book" };
  const area = (page, title, lines) => `
    <a class="intel-area" href="#${page}">
      <b>${icon(AREA_ICON[page])}${esc(title)}</b>
      ${lines.map(([v, l]) => `<span><strong>${v}</strong> ${esc(l)}</span>`).join("")}
      <em>Open ${esc(title.toLowerCase())} →</em>
    </a>`;
  const c = E.completion;
  // The headline is who the programme reaches and how learning is going
  // (console.js adds data quality beside them). Every other figure sits
  // with its own area below, once — not as a tile and again in a card.
  return {
    headline: [
      tile("Schools", num(E.schools), `${E.schoolsVisited.visited} visited · ${pct(E.schoolsVisited.coverage)} coverage`, "", "school"),
      tile("Learners", num(E.learners), `active · ${pct(E.activeUsers.learnerShare)} used the portal ${esc(E.activeUsers.window)}`, "", "cap"),
      tile("Teachers", num(E.teachers), `${pct(T.training.share)} trained · ${pct(T.activity.participation.active.rate)} active`, "", "teacher"),
      tile("Completion", pct(c.rate), c.assigned ? `${num(c.submitted)}/${num(c.assigned)} pieces of work handed in` : "no work set yet", "", "assignment"),
      tile("Average mark", pct(E.averageMark), L.results.marked ? `${plural(L.results.marked, "piece")} marked${L.results.band ? ` · ${esc(L.results.band)}` : ""} — achievement` : "nothing marked yet", "", "results"),
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
        <b>${icon("target")}M&amp;E</b><span>Indicator targets and actuals</span><em>Open M&amp;E →</em>
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
      ${melFirst("reach")}
      ${card("Schools by county", "Schools in each county, and how many of them have active learners or teachers",
        barList(R.schoolsByCounty.map((c) => ({ label: c.label, value: c.schools, note: `${c.reached} reached` })), { sort: true, noun: "schools" }))}
      ${card("Learners by county", `Where the ${num(S.learners)} active learners are`, barList(R.learnersByCounty, { share: true, sort: true, noun: "learners" }))}
      ${card("Teachers by county", `Where the ${num(S.teachers)} active teachers are`, barList(R.teachersByCounty, { share: true, sort: true, noun: "teachers" }))}
      ${card("Learner growth", "Learners on roll in each term",
        trendOrBars(termPoints(R.growth, (t) => t.learners, (t) => ({ note: `${num(t.joined)} joined this term` })), { noun: "learners on roll", title: "Learners on roll by term" }))}
      ${card("Grade distribution", "Active learners in each grade", barList(R.grades, { share: true, noun: "learners" }))}
    </div>
    ${more("reach", "Gender where recorded, accounts by role, teachers by employment type", `
      ${card("Learners by gender", "Where it has been recorded — totals only", genderHtml(R.gender.learners, "learners"), { wide: true })}
      ${card("Teachers by gender", "Where it has been recorded — totals only", genderHtml(R.gender.teachers, "teachers"), { wide: true })}
      ${card("Accounts by role", "Active accounts in view, by what they do", barList(R.accountsByRole, { share: true, sort: true, noun: "accounts" }))}
      ${card("Teachers by employment type", "BOM or TSC, as each teacher declared", proportion(R.teachersByType, { noun: "teachers" }))}`)}
    ${melLast("reach")}`;
}

/* ------------------------------------------------------------ 3. learning */

export function learningHtml(d) {
  const L = d.learning, A = L.assignments, c = L.completion, a = L.results, P = L.progress.learners;
  const band = bandNames(L.bands);
  const byBand = bandChart(L.bands, a.bands);
  const terms = L.progress.byTerm.filter((t) => t.marked);
  return `
    <div class="stat-row">
      ${tile("Assignments set", num(A.published + A.closed), `${A.published} open · ${A.closed} closed · ${A.draft} drafts`)}
      ${tile("Completion", pct(c.rate), `${num(c.submitted)}/${num(c.assigned)} handed in · ${c.late} late · ${c.missing} missing`)}
      ${tile("Average mark", pct(a.averagePercent), a.marked ? `${plural(a.marked, "piece")} marked${a.band ? ` · ${band.tag(a.band)}` : ""}` : "nothing marked yet")}
      ${tile("To be marked", num(A.awaitingMarking), "handed in, not yet marked")}
      ${tile("Learners improving", pct(P.improvedShare), P.compared ? `${P.improved} of ${P.compared} with marks in 2+ terms` : "needs marks in two terms")}
    </div>
    <div class="chart-grid">
      ${melFirst("learning")}
      ${card("Completion by grade", "Share of the work set that was handed in — not marks",
        barList(L.completionByGrade.map((r) => ({ ...r, note: `of ${num(r.n)} set` })), { unit: "%", noun: "handed in" }))}
      ${card("Results by grade", "Average mark on marked work — achievement",
        barList(L.resultsByGrade.map((r) => ({ ...r, note: `${num(r.n)} marked` })), { unit: "%", noun: "average mark" })
        + (byBand ? `<div class="chart-subhead">All marked work, by band</div>${byBand}` : ""))}
      ${card("Learner progress", "Average mark on marked work, term by term",
        trendOrBars(termPoints(terms, (t) => t.averagePercent, (t) => ({ note: `${num(t.marked)} marked${t.band ? ` · ${t.band}` : ""}` })), { unit: "%", noun: "average mark", title: "Average mark by term" }))}
      ${card("Subject performance", "Completion and results side by side — never combined", table(
        ["Subject", "Handed in", "Average mark", "Marked"],
        L.subjects.map((s) => [esc(s.label), s.assigned ? rate(s.completionRate) : "—", s.marked ? band.mark(s.averagePercent, s.band) : "—", num(s.marked)])), { wide: true })}
    </div>
    ${more("learning", "School by school, assignments by subject, learners' own progress", `
      ${card("School performance", "Completion and results side by side. Pick a school to see only its figures", table(
        ["School", "County", "Learners", "Handed in", "Average mark", "Library"],
        L.schools.map((s) => [schoolLink(s.school), esc(s.county), num(s.learners),
          s.assigned ? rate(s.completionRate) : "—",
          s.marked ? band.mark(s.averagePercent, s.band) : "—", mins(s.libraryMinutes)])), { wide: true })}
      ${card("Assignments by subject", "Assignments set in each subject (drafts left out)", barList(A.bySubject, { share: true, sort: true, noun: "assignments" }))}
      ${card("Learners' own progress", "Each learner's latest term against their first",
        P.compared ? stackBar([
          { label: "Improved", value: P.improved, colour: "var(--band-1)" },
          { label: "Steady", value: P.steady, colour: "var(--neutral)" },
          { label: "Declined", value: P.declined, colour: "var(--band-4)" },
        ], { noun: "learners", title: "Learners' own progress" }) + `<p class="chart-note">Of ${plural(P.compared, "learner")} with marked work in two or more terms.</p>` : empty("Shows once learners have marked work in two terms."))}`)}
    ${melLast("learning")}`;
}

/* ------------------------------------------------------------ 4. teacher development */

export function teachersHtml(d) {
  const T = d.teachers, Tr = T.training, D = T.digital, P = T.activity.participation;
  return `
    <div class="stat-row">
      ${tile("Teachers", num(T.total), T.byType.map((t) => `${t.value} ${esc(t.label)}`).join(" · ") || "active")}
      ${tile("Trained", num(Tr.teachersTrained), `${pct(Tr.share)} of teachers · ${plural(Tr.sessions, "session")}`)}
      ${tile("Using digital resources", num(D.teachersUsingLibrary), `${pct(D.share)} of teachers · ${hrs(D.hours)} · ${plural(D.teacherResourceOpens, "Teacher Resource")} opened`)}
      ${tile("Active teachers", num(T.activity.activeInWindow), esc(T.activity.window))}
      ${tile("Setting work", num(P.settingWork.count), `${pct(P.settingWork.rate)} of teachers`)}
      ${tile("Teacher support visits", num(T.activity.supportVisits.visits), plural(T.activity.supportVisits.schools, "school"))}
    </div>
    <div class="chart-grid chart-pairs">
      ${melFirst("teacher_development")}
      ${card("Training by county", "Share of each county's teachers who have attended a session",
        barList(Tr.byCounty.map((c) => ({ label: c.label, value: c.share ?? 0, note: `${num(c.trained)} of ${num(c.teachers)}` })), { unit: "%", noun: "trained" }))}
      ${card("Sessions by kind", `The ${plural(Tr.sessions, "session")} on the register, by kind`,
        barList(Tr.byKind.map((k) => ({ label: KIND_LABEL[k.label] || k.label, value: k.value })), { share: true, sort: true, noun: "sessions" }))}
      ${card("Teacher activity", `What the ${num(P.teachers)} active teachers do in the portal — share doing each`, barList([
        { label: "Active in any way", value: P.active.rate ?? 0, note: `${num(P.active.count)} teachers` },
        { label: "Set work", value: P.settingWork.rate ?? 0, note: `${num(P.settingWork.count)} teachers` },
        { label: "Marked work", value: P.marking.rate ?? 0, note: `${num(P.marking.count)} teachers` },
        { label: "Used digital resources", value: P.usingLibrary.rate ?? 0, note: `${num(P.usingLibrary.count)} teachers` },
        { label: "Answered forms", value: P.answeringForms.rate ?? 0, note: `${num(P.answeringForms.count)} teachers` },
      ], { unit: "%", noun: "of teachers" }))}
      ${card("Active by county", `Share of each county's teachers active ${esc(T.activity.window)}`,
        barList(T.activity.byCounty.map((c) => ({ label: c.label, value: c.share ?? 0, note: `${num(c.active)} of ${num(c.teachers)}` })), { unit: "%", noun: "active" }))}
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
      ${melFirst("field_operations")}
      ${card("Visits by month", "Field visits recorded in each of the last 12 months", lineChart(monthPoints(F.visitsByMonth), { noun: "visits", title: "Field visits by month" }))}
      ${card("Schools not visited yet", `${V.schools.total - V.schools.visited} of ${V.schools.total} schools have no visit on record. Pick one to see it`,
        V.schools.notVisited.length
          ? `<div class="intel-chips">${V.schools.notVisited.map((n) => `<button type="button" class="pill" data-pick-school="${esc(n)}">${esc(n)}</button>`).join(" ")}</div>`
          : empty("Every school in view has had a visit."))}
      ${card("Visit types", "What the visits were for, and how many schools each reached",
        barList(V.byType.map((t) => ({ label: t.label, value: t.visits, note: plural(t.schools, "school") })), { sort: true, noun: "visits" }))}
      ${card("Visits by county", "Where the visits took place", barList(V.byCounty, { share: true, sort: true, noun: "visits" }))}
      ${card("Kobo submissions by month", "Survey submissions received in each of the last 12 months", lineChart(monthPoints(K.byMonth), { noun: "submissions", title: "Kobo submissions by month" }))}
    </div>
    ${more("field-operations", "Completed forms, Kobo surveys and their checks, visits by term, forms by audience", `
      ${card("Completed forms", "How many of the people each form reaches have answered it", table(["Form", "For", "Expected", "Received", "Rate"],
        Fm.responseRates.map((r) => [esc(r.label), esc(r.kind === "visit" ? "Visit form" : audience(r.audience)), num(r.expected), num(r.received), rate(r.rate)])), { wide: true })}
      ${card("Kobo surveys", "Checked in the portal — only “counted” submissions reach the dashboards", table(["Survey", "Received", "Counted", "Failing checks", "Duplicates", "Rejected in Kobo", "Officers done"],
        K.forms.map((f) => [esc(f.title), num(f.submissions), num(f.counted), num(f.invalid), num(f.duplicate), num(f.rejected), num(f.officersDone)])), { wide: true })}
      ${card("Kobo checks", `Submissions failing each check · ${plural(K.schoolsCovered, "school")} covered`,
        barList(K.issuesByRule.map((r) => ({ label: KOBO_RULE_LABEL[r.rule] || r.rule, value: r.errors, note: r.warnings ? `+${plural(r.warnings, "warning")}` : "" })), { sort: true, noun: "failing", empty: "No submissions are failing a check." })
        + `<p class="chart-note">Review them on Kobo Surveys → Data pipeline, or in the <a href="#data-quality">Data Quality Center</a>.</p>`)}
      ${card("Kobo submissions by county", "Where the submissions came from", barList(K.byCounty, { share: true, sort: true, noun: "submissions" }))}
      ${card("Visits by term", "Field visits recorded in each term", trendOrBars(termPoints(V.byTerm), { noun: "visits", title: "Field visits by term" }))}
      ${card("Forms by audience", "Who the portal's forms are for", barList(Fm.byAudience.map((a) => ({ ...a, label: audience(a.label) })), { sort: true, noun: "forms" }))}`, { pairs: true })}
    ${melLast("field_operations")}`;
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
    <div class="chart-grid chart-pairs">
      ${melFirst("digital_resources")}
      ${card("Most-used content", "The resources opened most often", table(["Resource", "Shelf", "Opens", "Readers", "Time"],
        S.top.map((r) => [esc(r.title), esc(r.destination), num(r.opens), num(r.readers), mins(r.minutes)])), { wide: true })}
      ${card("Opens by month", "Times a resource was opened in each of the last 12 months",
        lineChart(monthPoints(S.byMonth, (m) => m.opens), { noun: "openings", title: "Resource openings by month" }))}
      ${card("Usage by term", "Reading sessions, and the hours they added up to, in each term",
        S.byTerm.length
          ? `<div class="chart-subhead">Sessions</div>${trendOrBars(termPoints(S.byTerm, (t) => t.sessions, (t) => ({ note: `${plural(t.readers, "reader")}` })), { noun: "sessions", height: 84, title: "Reading sessions by term" })}
             <div class="chart-subhead">Hours</div>${trendOrBars(termPoints(S.byTerm, (t) => Math.round(t.minutes / 6) / 10), { noun: "hours", height: 84, title: "Reading hours by term" })}`
          : empty())}
    </div>
    <p class="field-hint">Time is how long a resource stayed open in the portal — an honest measure of attention, not proof of reading.</p>
    ${more("digital-resources", "What's on the shelves — resources by shelf, subject and type", `
      ${card("Resources by shelf", "Published resources on each shelf", proportion(S.items.byDestination, { noun: "resources" }))}
      ${card("Resources by subject", "Published resources in each subject", barList(S.items.bySubject, { share: true, sort: true, noun: "resources" }))}
      ${card("Resources by type", "Published resources of each type", barList(S.items.byType, { share: true, sort: true, noun: "resources" }))}`)}
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
      <span class="hint-inline">${esc(dash.period?.label || "")} · ${esc(dash.scope.label)}</span>
    </div>
    ${groups.map((g) => `
      <div class="mel-outcome">
        <h3><span class="hint-inline">${esc(g.programme)} ·</span> ${g.outcome.code ? `<span class="code-chip">${esc(g.outcome.code)}</span> ` : ""}${esc(g.outcome.title)}</h3>
        ${targetList(g.rows.map(indicatorRow), { fmt: fmtValue, keepEmpty: true })}
      </div>`).join("")}
    ${TARGET_KEY}
    <p class="chart-note">“Met” is 100% of the target or more, “Close” is 80% or more. Values are recorded (or verified) actuals where there is one, otherwise worked out live from the data. Pick an indicator for its trend and its county and school comparison.</p>`;
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
      ${card("Trend over time", `The actual each term, against that term's target · ${esc(trend?.scope?.label || "")}`,
        trend ? lineChart(points, { unit: unit === "percent" ? "%" : "", target: "Target", name: "Actual", height: 190, title: `${ind.name} by term`, empty: "No values for any term yet." }) : empty("Loading…"), { wide: true })}
      ${card("County comparison", breakdown ? `Each county's progress to its target · ${esc(breakdown.period.label)}` : "", breakdown ? targetList(counties, { fmt: fmtValue }) : empty("Loading…"))}
      ${card("School comparison", breakdown ? `Schools with a value or a target · ${esc(breakdown.period.label)}` : "", breakdown ? targetList(schools.slice(0, 25), { fmt: fmtValue }) + TARGET_KEY : empty("Loading…"))}
    </div>`;
}
