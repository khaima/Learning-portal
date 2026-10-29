/* ============================================================
   HPF Digital Learning Portal — Programme impact (the M&E hub).

   The M&E landing page: every other dashboard's figures in one place, from
   one read (GET /me/hub — the same records and rules as Reach, Learning,
   Teacher development, Field operations, Digital resources and the
   indicators), each card opening its full dashboard.

     key figures   the programme's seven results this term so far, each
                   against the same point of last term and its approved
                   target, with its own picture
     row 1         field work month by month · the results that can move,
                   this term against last · learners by county
     highlights    the best school, county, resource, visit type — a strip
     row 2         average mark by subject · teachers trained by county
     row 3         the most-opened resources · visits by type · what
                   happened to the work set
     row 4         schools by work handed in and average mark · the schools
                   in a table, with bars
     findings      what the figures say (insights.ts)

   Nothing is made up: a figure with no data says so, a trend is drawn only
   where the same measure exists for each period, and the average mark is
   never compared term with term (different work each term).
   ============================================================ */

import { esc } from "./util.js";
import { barList, bulletList, comboChart, donut, monthPoints, periodChip, proportion, scatter } from "./charts.js";
import { kpiCard, termName, trendTag } from "./kpi.js";
import { RESULT_ICON, resultPicture } from "./admin-ui.js";
import { insightsPanel } from "./insights-ui.js";

const num = (v) => (v == null ? "—" : Number(v).toLocaleString());
const pct = (v) => (v == null ? "No data" : `${Math.round(v)}%`);
const LAST_12 = "Last 12 months";
/* The results that can move from one term to the next, as shares (admin-ui.js MOVES). */
const MOVES = ["participation", "teachers_digital", "schools_supported", "teacher_resources"];
const SHORT = {
  learners: "Learners", participation: "Taking part", teachers_trained: "Trained", teachers_digital: "Teaching digitally",
  schools_supported: "Schools supported", assessment: "Average mark", teacher_resources: "Using resources",
};

/** Parts of one whole: a ring when there are at most three with something in them (the
    portal's three category colours, each part told apart), else bars with each share. */
function ringOrBars(parts, { noun, title, centre = "" }) {
  const some = parts.filter((p) => p.value > 0);
  return some.length <= 3 ? donut(some, { noun, title, centre }) : proportion(parts, { noun, sort: true, zeros: "None yet" });
}

/** One card: its title, a line on what it shows, its period, and the full dashboard it comes from. */
function card(title, meta, body, { span = 4, period = "", page = "", label = "", opts }) {
  const open = page && opts.canOpen?.(page)
    ? `<a class="hub-open" href="#${page}?via=${opts.via}">${esc(label || "Open")} <i aria-hidden="true">→</i></a>` : "";
  return `<section class="chart-card hub-card s${span}">
    <div class="chart-card-head hub-head"><div class="hub-head-top"><b>${esc(title)}</b>${open}</div>${meta ? `<span>${meta}</span>` : ""}${periodChip(period)}</div>
    ${body}
  </section>`;
}

/** A key figure: the result, against the same point of last term and its target, with its own picture. */
function kpiTile(k, r, opts) {
  const before = k.previous;
  const trend = k.value != null && before?.value != null
    // The line above the figures says what is compared; each tile names only the term.
    ? trendTag(k.value - before.value, { unit: k.unit === "percent" ? " pts" : "", what: `on ${termName(String(before.period).match(/\d{4} Term \d/)?.[0] || before.period)}` }) : "";
  const value = k.value == null ? "No data" : k.unit === "percent" ? `${Math.round(k.value * 10) / 10}%` : num(k.value);
  const sub = [
    k.target ? `Target ${k.unit === "percent" ? `${k.target.value}%` : num(k.target.value)}${k.target.percent != null ? ` · ${num(k.target.percent)}% achieved` : ""}` : "",
    k.note ? `<b>${esc(k.note)}</b>` : "",
  ].filter(Boolean).join("<br>");
  // One compact picture each, the same height: the roll term by term, the marks' bands, or a share as a slim bar.
  const viz = k.key === "learners" || k.key === "assessment" ? resultPicture(k, r) : shareBar(k);
  return kpiCard({ label: k.label, value, icon: RESULT_ICON[k.key] || "", trend, sub, viz });
}

/** A share as a slim bar on 0–100, the approved target marked on it (the figure itself is printed above). */
function shareBar(k) {
  if (k.unit !== "percent" || k.value == null) return "";
  const t = k.target?.value;
  return `<div class="hub-meter${t != null && k.value >= t ? " is-met" : ""}" aria-hidden="true"><span style="width:${Math.max(1, Math.min(100, k.value)).toFixed(1)}%"></span>${
    t != null ? `<i style="left:${Math.min(100, t).toFixed(1)}%"></i>` : ""}</div>`;
}

/* ---- the highlights: one figure each, like a small card ---- */
function highlight(icon, label, value, detail = "") {
  return `<li class="hub-hl"><span class="hub-hl-ico" aria-hidden="true">${icon}</span><span><span class="hub-hl-label">${esc(label)}</span>
    <b>${esc(value)}</b>${detail ? `<span class="hub-hl-detail">${esc(detail)}</span>` : ""}</span></li>`;
}
const ICONS = {
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
  school: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 10 9-6 9 6M5 10v9h14v-9M9 19v-5h6v5"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2Z"/><path d="M4 19V5"/></svg>',
  visit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/></svg>',
  survey: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
};

/** Work handed in, county by county, from the schools' own figures (weighted by the work set). */
function countiesByWork(schools) {
  const by = new Map();
  for (const s of schools || []) {
    if (!s.county || !s.assigned || s.completionRate == null) continue;
    const c = by.get(s.county) || { set: 0, in: 0 };
    c.set += s.assigned;
    c.in += (s.completionRate / 100) * s.assigned;
    by.set(s.county, c);
  }
  return [...by.entries()].map(([county, c]) => ({ county, rate: (c.in / c.set) * 100, set: c.set })).sort((a, b) => b.rate - a.rate);
}

function highlightsHtml(imp, r) {
  const items = [];
  const t = r?.targets;
  items.push(t && t.indicators
    ? highlight(ICONS.target, "Approved targets met", `${num(t.summary?.met ?? 0)} of ${num(t.indicators)}`,
      [t.summary?.close ? `${num(t.summary.close)} close` : "", t.summary?.not_met ? `${num(t.summary.not_met)} below` : ""].filter(Boolean).join(" · "))
    : highlight(ICONS.target, "Approved targets", "None for this term", "Set them in the results framework"));
  const marked = (r?.schools || []).filter((s) => s.marked >= 10 && s.averagePercent != null).sort((a, b) => b.averagePercent - a.averagePercent);
  if (marked[0]) items.push(highlight(ICONS.school, "Highest average mark", marked[0].school, `${pct(marked[0].averagePercent)} on ${num(marked[0].marked)} pieces of marked work`));
  const counties = countiesByWork(r?.schools || imp.learning?.schools);
  if (counties.length > 1) items.push(highlight(ICONS.pin, "Most work handed in", `${counties[0].county} County`, `${pct(counties[0].rate)} of ${num(counties[0].set)} pieces set`));
  const res = imp.resources?.top?.[0];
  if (res?.opens) items.push(highlight(ICONS.book, "Most-opened resource", res.title, `${num(res.opens)} opens by ${num(res.readers)} people`));
  const type = [...(imp.fieldOps?.visits?.byType || [])].sort((a, b) => b.visits - a.visits)[0];
  if (type?.visits) items.push(highlight(ICONS.visit, "Most common visit", type.label, `${num(type.visits)} visits to ${num(type.schools)} schools`));
  const au = imp.executive?.activeUsers;
  if (au) items.push(highlight(ICONS.people, "Using the portal", num(au.total), `${num(au.learners)} learners and ${num(au.staff)} staff, ${au.window || "recently"}`));
  const kobo = imp.fieldOps?.kobo;
  if (kobo?.totalSubmissions) items.push(highlight(ICONS.survey, "Kobo submissions counted", num(kobo.counted), kobo.needsReview ? `${num(kobo.needsReview)} waiting for review` : "none waiting for review"));
  return `<ul class="hub-hls">${items.join("")}</ul>`;
}

/** The schools as a table with bars: the highest average mark first (10 or more pieces marked). */
function schoolsTable(rows, opts) {
  const list = (rows || []).filter((s) => s.learners).sort((a, b) => (b.averagePercent ?? -1) - (a.averagePercent ?? -1) || b.learners - a.learners);
  if (!list.length) return `<div class="chart-empty">No schools with learners yet.</div>`;
  const bar = (v) => (v == null ? `<span class="hub-nil">No data</span>`
    : `<span class="hub-bar"><i style="width:${Math.max(2, Math.min(100, v)).toFixed(0)}%"></i></span><span class="hub-pct">${Math.round(v)}%</span>`);
  const name = (s) => (s.id && opts.canOpen?.("school-profiles")
    ? `<a href="#school-profiles?school=${encodeURIComponent(s.id)}&amp;via=${opts.via}">${esc(s.school)}</a>` : esc(s.school));
  const top = list.slice(0, 10);
  return `<div class="hub-table-wrap"><table class="hub-table">
    <thead><tr><th scope="col">School</th><th scope="col" class="num">Learners</th><th scope="col">Work handed in</th><th scope="col">Average mark</th><th scope="col" class="num">Visits</th></tr></thead>
    <tbody>${top.map((s) => `<tr><th scope="row">${name(s)}<small>${esc(s.county || "")}</small></th><td class="num">${num(s.learners)}</td>
      <td><span class="hub-cell">${bar(s.completionRate)}</span></td><td><span class="hub-cell">${bar(s.averagePercent)}</span></td><td class="num">${num(s.visits)}</td></tr>`).join("")}</tbody>
  </table></div>${list.length > top.length ? `<p class="chart-note">The 10 with the highest average mark, of ${num(list.length)} schools with learners.</p>` : ""}`;
}

/** The whole page, from GET /me/hub. opts: { canOpen, via } */
export function hubHtml(d, opts) {
  const imp = d.impact || {};
  const r = d.results && !d.results.error ? d.results : null;
  const L = imp.learning || {}, T = imp.teachers || {}, F = imp.fieldOps || {}, R = imp.resources || {};
  const term = r ? `${r.period.label}${r.period.underway ? " so far" : ""}` : imp.currentTerm || "";

  // The period line: what the figures cover.
  const head = `<p class="hub-period">${r
    ? `<b>${esc(r.period.label)}${r.period.underway ? ` so far (day ${num(r.period.day)} of ${num(r.period.days)})` : ""}</b>${r.previous ? ` against the same point of ${esc(r.previous.label)}` : ""}`
    : "This term"} · monthly pictures: last 12 months · ${esc(d.scope?.label || "")}</p>`;

  const kpis = r ? `<div class="stat-row hub-kpis">${r.kpis.map((k) => kpiTile(k, r, opts)).join("")}</div>`
    : `<div class="alert alert-warn"><div><b>The term's results couldn't be worked out.</b>${esc(d.results?.error || "There's no current term in the calendar yet.")}</div></div>`;

  // Row 1: field work month by month · results this term and last · learners by county.
  const months = monthPoints(F.visitsByMonth || []);
  const kobo = new Map((F.kobo?.byMonth || []).map((m) => [m.label, m.value]));
  const fieldWork = comboChart(months.map((p, i) => ({ ...p, values: { visits: (F.visitsByMonth || [])[i]?.value ?? 0 }, line: kobo.get((F.visitsByMonth || [])[i]?.label) ?? 0 })),
    { bars: [{ key: "visits", label: "Field visits" }], line: { label: "Kobo submissions" }, title: "Field work, month by month", empty: "No field visits or Kobo submissions in the last 12 months." });
  const moving = (r?.kpis || []).filter((k) => MOVES.includes(k.key));
  const targets = moving.filter((k) => k.target?.percent != null);
  const results = comboChart(moving.map((k) => ({ label: SHORT[k.key], full: k.label, values: { before: k.previous?.value ?? null, now: k.value }, line: k.target?.percent ?? null })), {
    unit: "%", bars: [...(r?.previous ? [{ key: "before", label: r.previous.label }] : []), { key: "now", label: r?.period.label || "This term" }],
    line: targets.length ? { label: "% of target achieved", unit: "%" } : null, title: "Results this term and last", empty: "No results to compare yet.",
  });
  const counties = ringOrBars((imp.reach?.learnersByCounty || []).map((c) => ({ label: c.label, value: c.value })), { noun: "learners", title: "Learners by county" });

  // Row 2: average mark by subject · teachers trained by county · highlights.
  const subjects = bulletList((L.subjects || []).filter((s) => s.marked).map((s) => ({ label: s.label, value: s.averagePercent, base: s.marked, note: `${num(s.marked)} pieces marked` })),
    { unit: "%", noun: "average mark", line: L.results?.averagePercent != null ? { value: L.results.averagePercent, label: "All subjects" } : null, empty: "No marked work yet." });
  const trained = bulletList((T.training?.byCounty || []).filter((c) => c.teachers).map((c) => ({ label: c.label, value: c.share, base: c.teachers, note: `${num(c.trained)} of ${num(c.teachers)} teachers` })),
    { unit: "%", noun: "trained", line: T.training?.share != null ? { value: T.training.share, label: "All counties" } : null, empty: "No teachers on the portal yet." });

  // Row 3: the most-opened resources · visits by type · what happened to the work set.
  const resources = barList((R.top || []).filter((x) => x.opens).map((x) => ({ label: x.title, value: x.opens, note: `${num(x.readers)} people · ${num(Math.round((x.minutes || 0) / 60))} hrs` })),
    { noun: "opens", sort: true, top: 10, empty: "No resources opened yet." });
  const visitTypes = ringOrBars((F.visits?.byType || []).map((t) => ({ label: t.label, value: t.visits })), { noun: "visits", title: "Field visits by type" });
  const c = L.completion || {};
  // Every piece set, so the ring adds up to the work set: what isn't due yet is neither in nor missing.
  const open = Math.max(0, (c.assigned ?? 0) - (c.onTime ?? 0) - (c.late ?? 0) - (c.missing ?? 0));
  const work = donut([{ label: "Handed in on time", value: c.onTime ?? 0, colour: "var(--cat-1)" }, { label: "Handed in late", value: c.late ?? 0, colour: "var(--cat-2)" },
    { label: "Not handed in", value: c.missing ?? 0, colour: "var(--cat-3)" }, ...(open ? [{ label: "Not due yet", value: open, colour: "var(--neutral)" }] : [])],
    { noun: "pieces set", title: "Work set" });

  // Row 4: schools by work handed in and average mark · the schools in a table.
  const pts = (r?.schools || []).filter((s) => s.completionRate != null && s.averagePercent != null).map((s) => ({
    label: s.school, x: s.completionRate, y: s.averagePercent, base: Math.min(s.assigned, s.marked),
    note: `${s.county || ""} · ${num(s.learners)} learners`, href: s.id && opts.canOpen?.("school-profiles") ? `#school-profiles?school=${encodeURIComponent(s.id)}&via=${opts.via}` : "",
  }));
  const spread = scatter(pts, { xAxis: { label: "Work handed in", unit: "%" }, yAxis: { label: "Average mark", unit: "%" }, noun: "schools", insight: true,
    avg: c.rate != null && L.results?.averagePercent != null ? { x: c.rate, y: L.results.averagePercent } : null, title: "Schools by work handed in and average mark",
    empty: "No school has both work handed in and marked yet." });

  const findings = insightsPanel(d.insights, { title: "What the figures say", max: 5, canOpen: opts.canOpen, via: opts.via, quiet: false });

  return `<div class="hub">${head}${kpis}
  <div class="hub-grid">
    ${card("Field work, month by month", "Visits to schools, and the Kobo submissions sent", fieldWork, { span: 5, period: LAST_12, page: "field-operations", label: "Field operations", opts })}
    ${card("Results this term and last", targets.length ? "Same point of each term · line: share of the approved target" : "Same point of each term", results, { span: 4, period: term, page: "me-dashboard", label: "Indicators", opts })}
    ${card("Learners by county", `${num(imp.reach?.summary?.schoolsReached)} schools reached`, counties, { span: 3, period: "On roll now", page: "reach", label: "Reach", opts })}
    ${card("Highlights", "The best of each, from the same figures", highlightsHtml(imp, r), { span: 12, period: term, opts })}
    ${card("Average mark by subject", "Marked classwork; the line is all subjects", subjects, { span: 6, period: "", page: "learning", label: "Learning", opts })}
    ${card("Teachers trained by county", "Share of active teachers at a training session", trained, { span: 6, page: "teacher-development", label: "Teacher development", opts })}
    ${card("Most-opened resources", "Library resources by how often they were opened", resources, { span: 4, page: "digital-resources", label: "Digital resources", opts })}
    ${card("Field visits by type", `${num(F.visits?.visits)} visits by ${num(F.visits?.officersReporting)} field officers`, visitTypes, { span: 4, page: "field-operations", label: "Field operations", opts })}
    ${card("Work set", `${num(c.assigned)} pieces of work set to learners`, work, { span: 4, page: "learning", label: "Learning", opts })}
    ${card("Schools by work handed in and average mark", "Each dot a school; dashed: all schools", spread, { span: 5, period: term, page: "school-profiles", label: "Schools", opts })}
    ${card("Schools", "Highest average mark first", schoolsTable(r?.schools || L.schools, opts), { span: 7, period: term, page: "school-profiles", label: "Every school", opts })}
  </div>
  ${findings}</div>`;
}
