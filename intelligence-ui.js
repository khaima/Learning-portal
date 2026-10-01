/* ============================================================
   HPF Digital Learning Portal — Programme Intelligence screens.

   Draws the Education Team's four areas (and the overview across them)
   from one GET /intelligence read: Learning, Programme implementation,
   Data collection and Impact. Every number is computed server-side
   (supabase/functions/api/intelligence.ts); this file only lays it out.

   Two measures are never merged: COMPLETION (work handed in) and
   ACHIEVEMENT (the marks on marked work).
   ============================================================ */

import { esc, formatDuration } from "./util.js";

const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const mins = (m) => (m ? formatDuration(m * 60) : "0m");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
function bars(rows, { suffix = "", max = null, note = null } = {}) {
  const list = (rows || []).filter((r) => r.value != null);
  if (!list.length) return empty();
  const top = max ?? Math.max(1, ...list.map((r) => r.value));
  return `<div class="bar-chart">${list.map((r) => `
    <div class="bar-row">
      <span class="bar-label" title="${esc(r.label)}">${esc(r.label)}${note && note(r) ? ` <small class="hint-inline">${esc(note(r))}</small>` : ""}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, (r.value / top) * 100)}%"></span></span>
      <span class="bar-num">${Math.round(r.value * 10) / 10}${suffix}</span>
    </div>`).join("")}</div>`;
}

function table(head, rows, { wrap = true } = {}) {
  if (!rows.length) return empty();
  const t = `<table class="lms-table intel-table"><thead><tr>${head.map((h, i) => `<th${i === 0 ? ' class="lms-name"' : ""}>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="lms-name"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return wrap ? `<div class="lms-table-wrap">${t}</div>` : t;
}

function bandStrip(bands, counts) {
  const total = Object.values(counts || {}).reduce((a, b) => a + b, 0);
  if (!total) return "";
  return `<div class="intel-bands">${(bands || []).map((b) => {
    const n = counts[b.code] || 0;
    return n ? `<span class="pill band-pill band-${esc(b.code)}" title="${esc(b.label)}">${esc(b.code)} · ${n} (${Math.round((n / total) * 100)}%)</span>` : "";
  }).join(" ")}</div>`;
}

/* ------------------------------------------------------------ overview */

export function overviewHtml(d) {
  const L = d.learning, I = d.implementation, D = d.dataCollection, M = d.impact;
  const area = (page, title, lines) => `
    <a class="intel-area" href="#${page}">
      <b>${esc(title)}</b>
      ${lines.map(([v, l]) => `<span><strong>${v}</strong> ${esc(l)}</span>`).join("")}
      <em>Open ${esc(title.toLowerCase())} →</em>
    </a>`;
  return {
    tiles: [
      tile("Learners", L.totals.learners, `${plural(L.totals.schools, "school")} · ${plural(L.totals.teachers, "teacher")}`),
      tile("Work handed in", pct(L.completion.rate), `${L.completion.submitted}/${L.completion.assigned} · completion`),
      tile("Average mark", pct(L.achievement.averagePercent), L.achievement.marked ? `${plural(L.achievement.marked, "piece")} marked${L.achievement.band ? ` · ${esc(L.achievement.band)}` : ""}` : "nothing marked yet"),
      tile("Schools visited", `${I.schools.visited}/${I.schools.total}`, `${pct(I.schools.coverage)} coverage · ${plural(I.visits, "visit")}`),
      tile("Response rate", pct(D.responseRateOverall), "forms and visit forms"),
      tile("Library time", mins(L.library.minutes), `${plural(L.library.sessions, "session")} · ${pct(L.library.learnerReach)} of learners`),
    ].join(""),
    areas: [
      area("learning", "Learning", [
        [L.totals.classes, "classes this year"],
        [L.totals.assignments.published + L.totals.assignments.closed, "assignments set"],
        [L.totals.awaitingMarking, "waiting to be marked"],
      ]),
      area("implementation", "Programme implementation", [
        [I.visits, "field visits"],
        [I.schools.visitedThisTerm, `${I.schools.visitedThisTerm === 1 ? "school" : "schools"} visited ${I.schools.currentTerm ? "in " + I.schools.currentTerm : "this term"}`],
        [`${I.officersReporting}/${I.officers}`, "field officers reporting"],
      ]),
      area("data-collection", "Data collection", [
        [D.kobo.totalSubmissions, "Kobo submissions"],
        [D.feedback.responses, "form responses"],
        [D.quality.filter((q) => q.value > 0).length, "data-quality checks to look at"],
      ]),
      area("impact", "Impact", [
        [`${M.reach.schoolsReached}/${M.reach.schoolsTotal}`, "schools reached"],
        [pct(M.teacherParticipation.active.rate), "of teachers active"],
        [pct(M.resourceUsage.learnerReach), "of learners using the library"],
      ]),
    ].join(""),
  };
}

/** Data-quality checks that need a look, for "Needs attention". */
export function qualityAlerts(d) {
  return d.dataCollection.quality.filter((q) => q.value > 0)
    .map((q) => ({ tone: "warn", title: q.label, detail: `${q.value} of ${q.total}${q.rate != null ? ` (${pct(q.rate)})` : ""}. ${q.note}` }));
}

/* ------------------------------------------------------------ 1. learning */

export function learningHtml(d) {
  const L = d.learning;
  const t = L.totals;
  const c = L.completion, a = L.achievement;
  return `
    <div class="stat-row">
      ${tile("Learners", t.learners, `active · ${t.learnersNotInClass} not in a class`)}
      ${tile("Teachers", t.teachers, `${plural(t.schoolHeads, "school head")}`)}
      ${tile("Schools", t.schools, "in view")}
      ${tile("Classes", t.classes, t.classesWithoutTeacher ? `${t.classesWithoutTeacher} without a class teacher` : "all have a class teacher")}
      ${tile("Assignments", t.assignments.published + t.assignments.closed, `${t.assignments.published} open · ${t.assignments.closed} closed · ${t.assignments.draft} drafts`)}
      ${tile("To be marked", t.awaitingMarking, "handed in, not yet marked")}
    </div>
    <div class="chart-grid">
      ${card("Completion", "work handed in, of what each learner was set", `
        <div class="chart-stats" style="grid-template-columns:repeat(4,1fr)">
          <div><b>${pct(c.rate)}</b><span>Rate</span></div>
          <div><b>${c.submitted}/${c.assigned}</b><span>Handed in</span></div>
          <div><b>${c.late}</b><span>Late</span></div>
          <div><b>${c.missing}</b><span>Missing</span></div>
        </div>`)}
      ${card("Results", "average mark on marked work — achievement", `
        <div class="chart-stats" style="grid-template-columns:repeat(3,1fr)">
          <div><b>${pct(a.averagePercent)}</b><span>Average mark</span></div>
          <div><b>${esc(a.band || "—")}</b><span>Band</span></div>
          <div><b>${a.marked}</b><span>Marked</span></div>
        </div>
        ${bandStrip(L.bands, a.bands)}`)}
      ${card("Completion by grade", "% of the work set that was handed in — not marks",
        bars(L.byGrade.map((g) => ({ label: g.label, value: g.completionRate, n: g.assigned })), { suffix: "%", max: 100, note: (r) => `${r.n} set` }))}
      ${card("Results by grade", "average mark on marked work",
        bars(L.byGrade.filter((g) => g.marked).map((g) => ({ label: g.label, value: g.averagePercent, n: g.marked, band: g.band })), { suffix: "%", max: 100, note: (r) => `${r.n} marked${r.band ? " · " + r.band : ""}` }))}
      ${card("Results by subject", "average mark on marked work",
        bars(L.bySubject.filter((s) => s.marked).map((s) => ({ label: s.label, value: s.averagePercent, n: s.marked })), { suffix: "%", max: 100, note: (r) => `${r.n} marked` }))}
      ${card("Completion by subject", "% handed in",
        bars(L.bySubject.map((s) => ({ label: s.label, value: s.completionRate })), { suffix: "%", max: 100 }))}
      ${card("Learners by grade", `${t.learners} active learners`, bars(L.learnersByGrade))}
      ${card("Library usage", `${plural(L.library.readers, "reader")} · ${pct(L.library.learnerReach)} of learners`, `
        <div class="chart-stats" style="grid-template-columns:repeat(3,1fr)">
          <div><b>${L.library.sessions}</b><span>Sessions</span></div>
          <div><b>${mins(L.library.minutes)}</b><span>Time</span></div>
          <div><b>${L.library.completed}</b><span>Finished</span></div>
        </div>
        <p class="field-hint">${L.library.learnerSessions} by learners · ${L.library.staffSessions} by staff</p>
        ${L.library.topResources.length ? table(["Most opened", "Sessions", "Time"], L.library.topResources.map((r) => [esc(r.title), r.sessions, mins(r.minutes)]), { wrap: false }) : ""}`)}
    </div>`;
}

/* ------------------------------------------------------------ 2. programme implementation */

export function implementationHtml(d) {
  const I = d.implementation;
  const typeTiles = I.byType.map((t) => tile(`${t.label} visits`, t.visits, `${plural(t.schools, "school")}`)).join("");
  return `
    <div class="stat-row">
      ${tile("Field visits", I.visits, `by ${plural(I.officersReporting, "officer")} (${I.officers} active)`)}
      ${tile("School visits", `${I.schools.visited}/${I.schools.total}`, `${pct(I.schools.coverage)} of schools visited`)}
      ${tile("Visited this term", I.schools.visitedThisTerm, esc(I.schools.currentTerm || ""))}
    </div>
    <div class="stat-row">${typeTiles}</div>
    <div class="chart-grid">
      ${card("Visits by type", "Learning · Infrastructure · ICT · MEP · Teacher support",
        bars(I.byType.map((t) => ({ label: t.label, value: t.visits, s: t.schools })), { note: (r) => `${r.s} school${r.s === 1 ? "" : "s"}` }))}
      ${card("Visits by county", "", bars(I.byCounty))}
      ${card("Visits by term", "", bars(I.byTerm))}
      ${card("Schools not visited yet", `${I.schools.total - I.schools.visited} of ${I.schools.total}`,
        I.schools.notVisited.length
          ? `<div class="intel-chips">${I.schools.notVisited.map((n) => `<button type="button" class="pill" data-pick-school="${esc(n)}">${esc(n)}</button>`).join(" ")}</div>`
          : empty("Every school in view has had a visit."))}
    </div>`;
}

/* ------------------------------------------------------------ 3. data collection */

export function dataCollectionHtml(d) {
  const D = d.dataCollection;
  const k = D.kobo;
  return `
    ${D.notSchoolScoped ? `<p class="hint">Forms and Kobo surveys aren't tied to one school, so the school filter doesn't narrow them.</p>` : ""}
    <div class="stat-row">
      ${tile("Kobo submissions", k.totalSubmissions, k.lastSynced ? `last synced ${new Date(k.lastSynced).toLocaleDateString()}` : "not synced yet")}
      ${tile("Officer surveys done", pct(k.officerCompletion.rate), `${k.officerCompletion.done}/${k.officerCompletion.expected} officer × survey`)}
      ${tile("Forms", D.forms.active, `${D.forms.archived} archived`)}
      ${tile("Feedback received", D.feedback.responses, `${D.feedback.thisTerm} this term`)}
      ${tile("Response rate", pct(D.responseRateOverall), "everyone each form reaches")}
    </div>
    <div class="chart-grid">
      ${card("Response rates", "who each form reaches vs. who answered", table(["Form", "For", "Expected", "Received", "Rate"],
        D.responseRates.map((r) => [esc(r.label), esc(r.kind === "visit" ? "visit form" : r.audience), r.expected, r.received, pct(r.rate)])), { wide: true })}
      ${card("Kobo surveys", "from the last sync", table(["Survey", "Submissions", "Rejected", "Not linked", "Officers done"],
        k.forms.map((f) => [esc(f.title), f.submissions, f.rejected, f.unattributed, f.officersDone])), { wide: true })}
      ${card("Feedback by role", "", bars(D.feedback.byRole))}
      ${card("Forms by audience", "", bars(D.forms.byAudience))}
      ${card("Data quality", "checks on the records behind every number", `
        <div class="intel-quality">${D.quality.map((q) => `
          <div class="intel-q ${q.value ? "warn" : "ok"}">
            <b>${q.value ? `${q.value}${q.total ? ` of ${q.total}` : ""}` : "✓"}</b>
            <div><strong>${esc(q.label)}</strong><span>${esc(q.note)}</span></div>
          </div>`).join("")}</div>`, { wide: true })}
    </div>`;
}

/* ------------------------------------------------------------ 4. impact */

export function impactHtml(d) {
  const M = d.impact;
  const R = M.reach;
  const P = M.teacherParticipation;
  return `
    <div class="stat-row">
      ${tile("Counties reached", `${R.counties}/${R.countiesTotal}`, "with active learners or teachers")}
      ${tile("Schools reached", `${R.schoolsReached}/${R.schoolsTotal}`, `${R.schoolsVisited} visited`)}
      ${tile("Learners", R.learners, `${R.learnersEverEnrolled} enrolled since the start`)}
      ${tile("Teachers", R.teachers, `${R.fieldOfficers} field officer${R.fieldOfficers === 1 ? "" : "s"}`)}
    </div>
    <div class="chart-grid">
      ${card("Learner growth", "learners on roll each term · +N joined that term",
        bars(M.learnerGrowth.map((t) => ({ label: t.label, value: t.learners, j: t.joined })), { note: (r) => `+${r.j}` }))}
      ${card("Teacher participation", `of ${P.teachers} active teachers`, bars([
        { label: "Active in any way", value: P.active.rate ?? 0 },
        { label: "Set work", value: P.settingWork.rate ?? 0 },
        { label: "Marked work", value: P.marking.rate ?? 0 },
        { label: "Used the library", value: P.usingLibrary.rate ?? 0 },
        { label: "Answered forms", value: P.answeringForms.rate ?? 0 },
      ], { suffix: "%", max: 100 }))}
      ${card("Digital resource usage", `${pct(M.resourceUsage.learnerReach)} of learners${M.resourceUsage.minutesPerLearner != null ? ` · ${mins(M.resourceUsage.minutesPerLearner)} per reading learner` : ""}`,
        M.resourceUsage.byTerm.length
          ? `<div class="chart-subhead">Sessions by term</div>${bars(M.resourceUsage.byTerm.map((t) => ({ label: t.label, value: t.sessions })))}
             <div class="chart-subhead">Minutes by term</div>${bars(M.resourceUsage.byTerm.map((t) => ({ label: t.label, value: t.minutes })))}`
          : empty())}
      ${card("Assessment outcomes", "average mark on marked work, by term — achievement",
        bars(M.assessment.byTerm.filter((t) => t.marked).map((t) => ({ label: t.label, value: t.averagePercent, n: t.marked, b: t.band })), { suffix: "%", max: 100, note: (r) => `${r.n} marked${r.b ? " · " + r.b : ""}` })
        + bandStrip(d.learning.bands, M.assessment.overall.bands))}
      ${card("School performance", "completion and results side by side — never combined", table(
        ["School", "County", "Learners", "Teachers", "Handed in", "Average mark", "Visits", "Library"],
        M.schoolPerformance.map((s) => [
          `<button type="button" class="intel-link" data-pick-school="${esc(s.school)}">${esc(s.school)}</button>`,
          esc(s.county), s.learners, s.teachers,
          s.assigned ? pct(s.completionRate) : "—",
          s.marked ? `${pct(s.averagePercent)}${s.band ? ` · ${esc(s.band)}` : ""}` : "—",
          s.visits, mins(s.libraryMinutes),
        ])), { wide: true })}
    </div>`;
}
