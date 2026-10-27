/* ============================================================
   HPF Digital Learning Portal — Content usage.

   Who opens the library's resources, how often, when and for how long —
   from one GET /library/usage read (library_usage.ts works it out), under
   the county, school and dates chosen above. It reads like every other
   dashboard (docs/DASHBOARD-HIERARCHY.md):

     key figures      people reached, opens, time spent, resources used —
                      with the last 30 days beside the 30 before
     needs attention  what someone could act on: resources nobody opened,
                      resources usually closed within seconds, schools that
                      never or no longer use the library
     pictures         opens week by week · who opens them · when · the most
                      used · schools side by side · topics
     More detail      every resource, school and topic in full, sortable

   Time is how long a resource stayed open: an estimate, never reading
   attention. Nothing is filled in — a resource with few timed opens isn't
   judged, and there's no comparison without two real periods.
   ============================================================ */

import { esc, formatDuration } from "./util.js";
import { barList as bars0, heatmap as heat0, lineChart, monthPoints, periodChip, periodLabel, proportion as parts0, trendOrBars } from "./charts.js";
import { kpiCard } from "./kpi.js";

const num = (v) => (v == null ? "—" : Number(v).toLocaleString());
const plural = (n, word, many = `${word}s`) => `${num(n)} ${n === 1 ? word : many}`;
const dur = (s) => (s == null ? "—" : formatDuration(s));
const some = (names, max = 3) => names.slice(0, max).join(", ") + (names.length > max ? ` and ${num(names.length - max)} more` : "");
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—");
const dayMonth = (ymd, opts = { day: "numeric", month: "short" }) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const NOT_SET = "(not set)";

/* What an empty chart says: where, and for when. */
let where = " yet";
let period = "All time"; // the dates the page covers, on every chart
function forScope(u) {
  const place = u.school ? ` at ${u.school}` : u.county ? ` in ${u.county} County` : "";
  where = `${place}${u.from || u.to ? " in this period" : ""}` || " yet";
  period = periodLabel(u);
}
const none = (what = "Nothing") => `${what} opened${where}.`;
const barList = (rows, o = {}) => bars0(rows, { empty: none(), period, insight: true, ...o });
const heatmap = (rows, cols, o = {}) => heat0(rows, cols, { empty: none(), period, insight: true, ...o });
const proportion = (parts, o = {}) => parts0(parts, { empty: none(), period, insight: true, ...o });

function card(title, meta, body, { wide = false, period: when = period } = {}) {
  return `<div class="chart-card${wide ? " intel-wide" : ""}">
    <div class="chart-card-head"><b>${esc(title)}</b>${meta ? `<span>${meta}</span>` : ""}${periodChip(when)}</div>
    ${body}
  </div>`;
}
function table(head, rows, { num: numCols = [] } = {}) {
  if (!rows.length) return `<div class="chart-empty">${esc(none())}</div>`;
  const cls = (i) => (i === 0 ? ' class="lms-name"' : numCols.includes(i) ? ' class="num"' : "");
  return `<div class="lms-table-wrap" tabindex="0"><table class="lms-table intel-table"${rows.length > 3 ? " data-sortable" : ""}>
    <thead><tr>${head.map((h, i) => `<th${cls(i)}>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function more(key, what, cards) {
  return `<details class="more-detail" data-more="${key}">
    <summary><b>More detail</b><span>${esc(what)}</span></summary>
    <div class="chart-grid">${cards}</div>
  </details>`;
}

/* ------------------------------------------------------------ the parts */

/** "Last 30 days: 12 · 30 days before: 8" — two whole, equal stretches, so
    the words compare them; counts get no arrow (docs/CHARTS.md). */
function recentLine(u, pick) {
  if (!u.recent) return "";
  const { days, last, before } = u.recent;
  return `Last ${days} days: <b>${num(pick(last))}</b> · ${days} before: ${num(pick(before))}`;
}

function keyFigures(u, opts) {
  const T = u.totals, L = u.library;
  const notOpened = u.attention.notOpened.count;
  const libraryHref = opts.canOpen?.("content") ? "#content?via=content-usage" : "";
  return `<div class="stat-row">
    ${kpiCard({ label: "People reached", icon: "users", value: num(T.users),
      sub: [`${plural(T.learners, "learner")} · ${num(T.staff)} staff`, recentLine(u, (p) => p.users)].filter(Boolean).join("<br>") })}
    ${kpiCard({ label: "Opens", icon: "activity", value: num(T.sessions),
      sub: [T.users ? `${(T.sessions / T.users).toFixed(1).replace(/\.0$/, "")} per person` : "", recentLine(u, (p) => p.sessions)].filter(Boolean).join("<br>") })}
    ${kpiCard({ label: "Time spent", icon: "clock", value: esc(dur(T.totalSeconds)),
      sub: T.completedSessions ? `A typical open: <b>${esc(dur(T.typicalSeconds))}</b><br>${num(T.completedSessions)} of ${plural(T.sessions, "open")} timed` : "No timed opens yet" })}
    ${kpiCard({ label: "Resources used", icon: "book", value: num(L.opened), unit: `of ${num(L.published)}`, href: libraryHref,
      sub: L.published ? `${Math.round((L.opened / L.published) * 100)}% of published resources${notOpened ? `<br>${plural(notOpened, "resource")} not opened${where === " yet" ? "" : esc(where.replace(/\.$/, ""))}` : ""}` : "Nothing published yet" })}
  </div>`;
}

/** One line per kind of thing to act on — how many, which, and where to deal with it. */
function attention(u, opts) {
  const A = u.attention, items = [];
  const lib = (q) => (opts.canOpen?.("content") ? `#content?${new URLSearchParams({ ...(q ? { q } : {}), via: "content-usage" })}` : "");
  if (A.quickExits.count) {
    items.push({ tone: "warn", go: "Check them", href: lib(A.quickExits.items.length === 1 ? A.quickExits.items[0].title : ""),
      title: `${plural(A.quickExits.count, "resource is", "resources are")} usually closed within ${A.quickExits.seconds} seconds`,
      detail: `${some(A.quickExits.items.map((i) => `“${i.title}” (typically ${dur(i.typicalSeconds)}, ${i.timedViews} timed opens)`))}. Check the link works and the content suits who it's for.` });
  }
  if (A.notOpened.count) {
    const scope = u.school ? ` at ${u.school}` : u.county ? ` in ${u.county} County` : "";
    items.push({ tone: u.from || u.to || scope ? "info" : "warn", go: "Open the library", href: lib(""),
      title: `${plural(A.notOpened.count, "published resource")} not opened${scope}${u.from || u.to ? " in this period" : " yet"}`,
      detail: `${some(A.notOpened.items.map((i) => `“${i.title}” (${i.shelf})`))}.` });
  }
  if (A.quiet?.count) {
    items.push({ tone: "warn", go: "", href: "",
      title: `${plural(A.quiet.count, "school has", "schools have")} gone quiet — nothing opened in ${A.quiet.days} days`,
      detail: `${some(A.quiet.schools.map((s) => `${s.school} (last ${shortDate(s.lastOpened)})`))}.` });
  }
  if (A.noUse?.count) {
    items.push({ tone: "info", go: "", href: "",
      title: `${num(A.noUse.count)} of ${plural(A.noUse.schools, "school")} haven't opened a resource${u.from || u.to ? " in this period" : " yet"}`,
      detail: `${some(A.noUse.names, 5)}.` });
  }
  items.sort((a, b) => (a.tone === "warn" ? 0 : 1) - (b.tone === "warn" ? 0 : 1));
  return `<section class="attn-section" aria-labelledby="usageAttnHead">
    <div class="attn-head"><h3 id="usageAttnHead">Needs attention</h3>${items.length ? `<span class="count-badge">${items.length}</span>` : ""}</div>
    ${items.length
      ? items.map((it) => `<div class="alert alert-${it.tone} alert-act"><div><b>${esc(it.title)}</b>${esc(it.detail)}</div>${it.href
        ? `<a class="btn btn-outline q-small" href="${esc(it.href)}">${esc(it.go)}<span class="sr-only">: ${esc(it.title)}</span></a>` : ""}</div>`).join("")
      : `<div class="alert alert-ok"><div><b>Nothing needs attention right now.</b>Every published resource has been opened${esc(where === " yet" ? "" : where.replace(/\.$/, ""))}, and no school has gone quiet.</div></div>`}
  </section>`;
}

/** Week by week (or month by month over a long range): opens, then people, one under the other. */
function overTime(u) {
  if (!u.byPeriod?.points?.length) return "";
  const byMonth = u.byPeriod.unit === "month";
  // The week (or month) under way has had less time: drawn as the line's
  // last point it looks like a fall. With enough whole periods to show a
  // shape it's left off the line and said in words instead.
  const all = u.byPeriod.points, running = all.at(-1)?.partial ? all.at(-1) : null;
  const P = { ...u.byPeriod, points: running && all.length > 3 ? all.slice(0, -1) : all };
  const soFar = running && P.points.length < all.length
    ? ` · this ${byMonth ? "month" : "week"} so far: ${plural(running.opens, "open")}, ${plural(running.users, "person", "people")}` : "";
  const today = iso(Date.now());
  const pts = (pick) => (byMonth
    ? monthPoints(P.points, pick).map((p, i) => (P.points[i].partial ? { ...p, note: "So far" } : p))
    : P.points.map((p, i) => {
      const end = iso(Date.parse(`${p.label}T00:00:00Z`) + 6 * 864e5);
      const year = p.label.slice(0, 4);
      return {
        label: dayMonth(p.label), sub: i === 0 || P.points[i - 1].label.slice(0, 4) !== year ? year : "",
        full: `Week of ${dayMonth(p.label, { day: "numeric", month: "long", year: "numeric" })}`,
        value: pick(p), note: p.partial ? "This week so far" : "",
        drill: { from: p.label, to: end < today ? end : today },
      };
    }));
  const n = P.points.length;
  // A dozen weekly labels crowd a phone: every other one, always the latest.
  const ticks = !byMonth && n > 6 ? P.points.map((_, i) => i).filter((i) => (n - 1 - i) % 2 === 0) : null;
  const span = byMonth ? `${plural(n, "month")}` : u.from || u.to ? `${plural(n, "week")}` : `Last ${plural(n, "whole week")}`;
  return card(`Opens and people, ${byMonth ? "month by month" : "week by week"}`, `${span}${soFar}${P.points.at(-1)?.partial ? ` · the last ${byMonth ? "month" : "week"} so far` : ""} · pick a ${byMonth ? "month" : "week"} to see only it`,
    `<div class="chart-subhead">Opens</div>${trendOrBars(pts((p) => p.opens), { noun: "opens", title: "Resource opens over time", drill: true, ticks, empty: none(), insight: true })}
     <div class="chart-subhead">People</div>${trendOrBars(pts((p) => p.users), { noun: "people", title: "People who opened a resource", drill: true, ticks, height: 84, empty: none("No one"), insight: true })}`,
    { wide: true, period: u.from || u.to ? period : span });
}

function whoCard(u, roleLabel) {
  const rows = u.byRole.map((r) => ({ label: roleLabel(r.role), value: r.sessions }));
  const learnerShare = u.totals.sessions ? Math.round(((u.byRole.find((r) => r.role === "learner")?.sessions || 0) / u.totals.sessions) * 100) : 0;
  return card("Who opens resources", u.totals.sessions ? `Opens by role · ${learnerShare}% by learners` : "", proportion(rows, { noun: "opens" }));
}

function whenCard(u) {
  const W = u.when;
  if (!W) return "";
  return card("When resources are opened", "Opens by day of the week and time of day · Kenyan time",
    heatmap(W.days.map((day, i) => ({ label: day, values: W.cells[i] })), W.blocks.map((b) => ({ label: b, short: b.split("–")[0], full: `${b} h` })),
      { caption: "Resources opened by day of the week and time of day", noun: "opens" }), { wide: true });
}

function topCard(u, opts) {
  const href = (t) => (opts.canOpen?.("content") ? `#content?${new URLSearchParams({ q: t, via: "content-usage" })}` : "");
  // Every resource opened, most first: the top 8 shown, the rest one click away.
  return card("Which resources are opened most", u.byResource.length ? `Opens, most first · ${plural(u.byResource.length, "resource")} opened` : "",
    barList(u.byResource.map((r) => ({ label: r.title, value: r.views, href: href(r.title) || undefined,
      note: `${plural(r.users, "person", "people")} · ${dur(r.totalSeconds)}${r.typicalSeconds != null ? ` · typically ${dur(r.typicalSeconds)}` : ""}` })),
    { noun: "opens", act: "find it in the library", sort: true, top: 8 }));
}

function schoolsCard(u) {
  const list = u.bySchool.filter((s) => s.sessions);
  if (!list.length) return card("Which schools use the library most", "", `<div class="chart-empty">${esc(none())}</div>`);
  const here = u.school ? list.findIndex((s) => s.school === u.school) : -1;
  const meta = u.school
    ? here >= 0 ? `${esc(u.school)} is ${here + 1} of ${plural(list.length, "school")} by opens · pick another to switch` : `Nothing opened at ${esc(u.school)} · pick a school to switch`
    : `Opens at each of ${plural(list.length, "school")} · pick one to see only it`;
  return card("Which schools use the library most", meta,
    barList(list.map((s) => ({
      label: s.school === NOT_SET ? "No school (staff)" : `${s.school}${s.school === u.school ? " (shown)" : ""}`, value: s.sessions,
      note: `${plural(s.users, "person", "people")} · ${dur(s.totalSeconds)} · last ${shortDate(s.lastOpened)}`,
      ...(s.school !== NOT_SET && s.school !== u.school ? { drill: { school: s.school } } : {}),
    })), { noun: "opens", act: "show only this school", sort: true }));
}

function topicsCard(u) {
  const tagged = u.byTopic.filter((t) => t.topic !== "(no topic)");
  if (!u.byTopic.length) return "";
  const untagged = u.byTopic.find((t) => t.topic === "(no topic)");
  return card("Where time goes, by topic", tagged.length
    ? `${plural(tagged.length, "topic")} · time while open${untagged ? ` · ${dur(untagged.totalSeconds)} on untagged resources` : ""}`
    : "Give resources a topic (upload or Edit) to see time by topic",
    tagged.length ? barList(tagged.map((t) => ({ label: t.topic, value: t.totalSeconds, note: `${plural(t.sessions, "open")} · ${plural(t.users, "person", "people")}` })),
      { sort: true, noun: "time", text: (r) => dur(r.value) }) : "");
}

function detail(u, opts) {
  const href = (t) => (opts.canOpen?.("content") ? `#content?${new URLSearchParams({ q: t, via: "content-usage" })}` : "");
  const link = (t) => (href(t) ? `<a href="${esc(href(t))}">${esc(t)}</a>` : esc(t));
  const resources = table(["Resource", "Shelf", "Opens", "People", "Time", "Typical open", "Under 30s", "Last opened"],
    u.byResource.map((r) => [link(r.title), esc(r.shelf || "—"), num(r.views), num(r.users), esc(dur(r.totalSeconds)),
      esc(r.typicalSeconds == null ? "—" : dur(r.typicalSeconds)), r.timedViews ? `${num(r.quickExits)} of ${num(r.timedViews)}` : "—", esc(shortDate(r.lastOpened))]),
    { num: [2, 3, 4, 5, 6] });
  const notOpened = u.attention.notOpened.items;
  const schools = table(["School", "Opens", "People", "Time", "Last opened"],
    u.bySchool.map((s) => [esc(s.school === NOT_SET ? "No school (staff)" : s.school), num(s.sessions), num(s.users), esc(dur(s.totalSeconds)), esc(shortDate(s.lastOpened))]),
    { num: [1, 2, 3] });
  const topicRows = u.byTopic.flatMap((t) => t.subtopics.map((s) => [esc(t.topic), esc(s.subtopic), esc(dur(s.totalSeconds)), num(s.sessions), num(s.users)]));
  return more("content-usage", "Every resource, school and topic", `
    ${card("Every resource opened", plural(u.byResource.length, "resource"), resources, { wide: true })}
    ${notOpened.length ? card("Not opened", `${plural(u.attention.notOpened.count, "published resource")}, newest first`,
      table(["Resource", "Shelf", "Uploaded"], notOpened.map((i) => [link(i.title), esc(i.shelf), esc(shortDate(i.uploadedAt))])), { wide: true }) : ""}
    ${u.school ? "" : card("Every school", plural(u.bySchool.length, "school"), schools)}
    ${topicRows.length ? card("Topics and sub-topics", "Time, opens and people", table(["Topic", "Sub-topic", "Time", "Opens", "People"], topicRows, { num: [2, 3, 4] })) : ""}`);
}

/* ------------------------------------------------------------ the page */

/** The whole page from one /library/usage read.
      opts.canOpen(page)   which pages this person may open (links only to those)
      opts.roleLabel(role) a role's name */
export function usageHtml(u, opts = {}) {
  forScope(u);
  const roleLabel = opts.roleLabel || ((r) => r);
  const nothing = !u.totals.sessions;
  return `
    ${keyFigures(u, opts)}
    ${attention(u, opts)}
    ${nothing
      ? `<div class="empty-state"><b>${esc(none("No resources"))}</b><br>Opens will show here as people use the library.</div>`
      : `<div class="chart-grid chart-pairs">
          ${overTime(u)}
          ${topCard(u, opts)}
          ${whoCard(u, roleLabel)}
          ${whenCard(u)}
          ${schoolsCard(u)}
          ${topicsCard(u)}
        </div>
        ${detail(u, opts)}`}
    <p class="field-hint dash-source">Time is how long a resource stayed open — an estimate, not reading time.${u.hpfStaff?.sessions
      ? ` ${plural(u.hpfStaff.sessions, "open")} by HPF staff checking content ${u.hpfStaff.sessions === 1 ? "is" : "are"} left out of every figure.` : ""}</p>`;
}
