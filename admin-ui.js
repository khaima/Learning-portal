/* The console's administration and oversight pages (platform / admin / me /
   education workspaces): Platform overview, Administration overview,
   Permissions, Account activity, Schools (the list and each school's page —
   a field officer's My schools too), Teachers, Classes, School profiles,
   Assignments, Results, Field visits, Subjects — and one account's access
   (role, data scope, grants, history) opened from Staff accounts.

   Each page shows what the API returns for this person — already limited to
   their permissions and data scope on the server. Buttons appear only for
   what they may do, and the API checks every one again. */
import { esc, skeleton, skeletonTable, skeletonCards, skeletonCharts, errorState, emptyState, friendlyError, toast, confirmDialog } from "./util.js";
import { apiGet, apiSend } from "./api.js";
import { openContentPanel, closeViewer } from "./viewer.js";
import { resultsTableHtml } from "./assignments-ui.js";
import { extendTrail, withVia } from "./nav.js";
import { ICON } from "./navigation.js";
import { agoTag, liveStatus, swap } from "./live.js";
import { barList, heatmap, histogram, lineChart, monthPoints, stackBar } from "./charts.js";
import { kpiCard } from "./kpi.js";

const fmtDay = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtWhen = (v) => (v ? new Date(v).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const ago = (v) => {
  if (!v) return "Never";
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 30 ? `${days} days ago` : fmtDay(v);
};
const count = (n) => (n == null ? "—" : Number(n).toLocaleString());
const warnText = (t) => `<b class="warn-text">${esc(t)}</b>`;
const table = (head, rows, empty = "Nothing to show.") => rows.length
  ? `<div class="lms-table-wrap"><table class="lms-table intel-table"${rows.length > 3 ? " data-sortable" : ""}><thead><tr>${head.map((h, i) => `<th${i === 0 ? ' class="lms-name"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="lms-name"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
  : `<div class="empty-state">${esc(empty)}</div>`;
/** Fill a page's own filter list from the data (`want`: a choice asked for in the address, used once). */
function fillChoices(sel, values, allLabel) {
  if (!sel) return "";
  const want = sel.dataset.want;
  delete sel.dataset.want;
  const keep = want ?? sel.value;
  const list = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>${list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("")}`;
  sel.value = list.includes(keep) ? keep : "";
  sel.classList.toggle("is-set", !!sel.value);
  return sel.value;
}
/** "N of M", when something narrows the list. */
const ofAll = (n, all, noun) => `${n === all ? "" : `${n} of `}${all} ${noun}${all === 1 ? "" : "s"}`;
const STATUS_TEXT = { active: "Active", pending: "Waiting for approval", suspended: "Suspended", deactivated: "Deactivated", rejected: "Not approved" };
const statusPill = (s) => s === "active" ? `<span class="pill ok">Active</span>`
  : `<span class="pill ${s === "pending" ? "warm" : "danger"}">${esc(STATUS_TEXT[s] || s)}</span>`;

/** `placeholder`: the skeleton while it loads — a table unless said. */
async function load(el, path, render, retry, placeholder = skeletonTable(4, 4)) {
  el.innerHTML = placeholder;
  try {
    const d = await apiGet(path);
    el.innerHTML = render(d);
    return d;
  } catch (err) {
    el.innerHTML = errorState(navigator.onLine ? friendlyError(err) : "This page needs a connection.", retry);
    return null;
  }
}

/** A dashboard that stays current: drawn from `path` by `render`, with a
    freshness line where the render leaves `<span data-live-host></span>`.
    Every `every` ms while it's open it's read again and changed in place
    (live.js); opening the page again keeps what's there and reads again
    only if it has aged. */
function liveLoad(el, path, render, { every = 0 } = {}) {
  if (el.liveFor === path && el.querySelector("[data-live-host] .live")) { el.live.refreshIfStale(); return Promise.resolve(); }
  const refresh = async () => { swap(el, render(await apiGet(path))); };
  const first = async () => {
    el.innerHTML = skeletonCards(6) + skeleton(2, { avatar: false });
    let d;
    try {
      d = await apiGet(path);
    } catch (err) {
      el.innerHTML = errorState(navigator.onLine ? friendlyError(err) : "This page needs a connection.", first);
      return;
    }
    swap(el, render(d), { replace: true });
    el.liveFor = path;
    el.live = liveStatus(el.querySelector("[data-live-host]"), { refresh, every });
    el.live.ok();
  };
  return first();
}

/* ------------------------------------------------------------------ Platform overview (Super Admin)
   The command centre: is the platform healthy, is it in use, is the data
   coming in, is the system working — and is anything waiting on someone?
   A summary of each with a link to where the detail lives, never the full
   lists (those have their own pages).
   Everything here comes from existing API replies: /platform/overview
   first (the page draws as soon as it arrives), then — filling in as they
   come — the data-quality score history, the audit log (activity per day,
   recent changes), sign-in recency, and Kobo's counted submissions.
   Nothing is estimated: a figure that can't be read says so. The page
   reads everything again every five minutes while it's open (live.js),
   and changes only what's different. */
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICON[name] ?? ICON.dashboard}</svg>`;
const num = (n) => (n == null || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString());
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const DAY = 864e5;
const dayKey = (t) => new Date(t).toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
const since = (v) => {
  if (!v) return "never";
  const mins = Math.round((Date.now() - new Date(v).getTime()) / 60e3);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  if (mins < 48 * 60) return "yesterday";
  return fmtDay(v);
};

/** A change since last time: ▲ / ▼ / no change, with words for screen readers. */
function delta(diff, { unit = "", better = "up", what = "" } = {}) {
  if (diff == null || Number.isNaN(diff)) return "";
  const r = Math.round(diff * 10) / 10;
  if (!r) return `<span class="pov-delta flat">No change${what ? ` ${what}` : ""}</span>`;
  const good = better === "up" ? r > 0 : r < 0;
  const text = `${r > 0 ? "+" : "−"}${Math.abs(r)}${unit}`;
  return `<span class="pov-delta ${good ? "good" : "bad"}"><span aria-hidden="true">${r > 0 ? "▲" : "▼"}</span>
    <span class="sr-only">${r > 0 ? "Up" : "Down"} </span>${esc(text)}${what ? ` <span class="pov-delta-what">${esc(what)}</span>` : ""}</span>`;
}

/** A thin bar showing part of a whole. */
const meter = (part, whole, label) =>
  `<div class="pov-meter" role="img" aria-label="${esc(label)}"><span style="width:${Math.min(100, pct(part, whole))}%"></span></div>`;

/** The data-quality score over its last scans. */
function scoreSpark(history) {
  const pts = history.filter((h) => h.score != null);
  if (pts.length < 2) return "";
  const w = 120, h = 34, pad = 3;
  const lo = Math.min(...pts.map((p) => p.score)), hi = Math.max(...pts.map((p) => p.score));
  const span = hi - lo || 1;
  const xy = pts.map((p, i) => [pad + (i * (w - 2 * pad)) / (pts.length - 1), h - pad - ((p.score - lo) / span) * (h - 2 * pad)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return `<svg class="pov-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
      aria-label="Score over the last ${pts.length} scans: ${esc(pts.map((p) => `${p.score}%`).join(", "))}">
    <polyline points="${pad},${h - pad} ${line} ${w - pad},${h - pad}" class="pov-spark-fill"/>
    <polyline points="${line}" class="pov-spark-line"/></svg>`;
}

/** Changes per day for the last `days` days, oldest first, from audit entries. */
function perDay(entries, days) {
  const counts = new Map();
  for (const e of entries) counts.set(dayKey(e.at), (counts.get(dayKey(e.at)) ?? 0) + 1);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY);
    out.push({ day: d, n: counts.get(dayKey(d)) ?? 0 });
  }
  return out;
}

/** Changes per day over the fortnight: a line (charts.js), with the last
    seven days — the ones the headline counts — marked off from the week before. */
function activityChart(series) {
  const last = series.length - 1, week = series.length - 7;
  const short = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const full = (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  return lineChart(series.map((s, i) => ({ label: i === last ? "Today" : short(s.day), full: i === last ? `Today, ${full(s.day)}` : full(s.day), value: s.n })), {
    noun: "changes", height: 100, title: "Changes recorded per day",
    band: { from: week, label: "Last 7 days" }, ticks: [0, week, last],
  });
}

/** How recently each active staff member last signed in. */
/* One hue, strongest for the most recent — it's a scale, not five different
   things. "Never signed in" is the one that asks for something, so it alone
   takes the attention colour. */
const RECENCY = [
  ["Last 24 hours", (ms) => ms != null && ms <= DAY, "var(--seq-1)"],
  ["2–7 days ago", (ms) => ms != null && ms > DAY && ms <= 7 * DAY, "var(--seq-2)"],
  ["8–30 days ago", (ms) => ms != null && ms > 7 * DAY && ms <= 30 * DAY, "var(--seq-3)"],
  ["Over 30 days ago", (ms) => ms != null && ms > 30 * DAY, "var(--seq-4)"],
  ["Never signed in", (ms) => ms == null, "var(--accent)"],
];
function recencyBlock(act) {
  const staff = (act.staff || []).filter((s) => s.status === "active");
  const now = Date.now();
  const groups = RECENCY.map(([label, test, colour]) => ({ label, colour,
    value: staff.filter((s) => test(s.lastSignInAt ? now - new Date(s.lastSignInAt).getTime() : null)).length }));
  return stackBar(groups, { noun: "staff", title: `The ${plural(staff.length, "active staff account")} by when each last signed in`, empty: "No active staff accounts.", compact: true });
}

const pending = (label) => `<span class="skeleton-block pov-skel" aria-hidden="true"></span><span class="sr-only">${esc(label)} loading</span>`;

/** One figure on the command centre: the number, what it is, a line of
    context (and a small chart), and where to see all of it. */
function stat({ value, unit = "", label, sub = "", viz = "", href = "", go = "", warn = false }) {
  return `<div class="cc-stat${warn ? " warn" : ""}">
    <div class="cc-num">${value}${unit ? `<small>${esc(unit)}</small>` : ""}</div>
    <div class="cc-text"><b>${esc(label)}</b>${sub ? `<span class="cc-sub">${sub}</span>` : ""}${viz}
      ${href ? `<a class="cc-go" href="${esc(withVia(href, "platform-overview"))}">${esc(go)}<span aria-hidden="true"> →</span></a>` : ""}</div>
  </div>`;
}
/** One part of the system: a light for its state, what it's doing, and its page. */
function sysRow({ name, state, tone = "ok", href = "", go = "" }) {
  const said = { ok: "Working", warn: "Needs attention", off: "Not in use" }[tone];
  return `<div class="cc-sys ${tone}">
    <span class="cc-light" role="img" aria-label="${said}"></span>
    <div class="cc-text"><b>${esc(name)}</b><span class="cc-sub">${state}</span></div>
    ${href ? `<a class="cc-go" href="${esc(withVia(href, "platform-overview"))}">${esc(go)}<span aria-hidden="true"> →</span><span class="sr-only">: ${esc(name)}</span></a>` : ""}
  </div>`;
}

/** Things waiting on someone: the health checks that aren't met, then the
    queues that have something in them; the passing checks folded away. */
function actionsPanel(checks, queue) {
  const failing = checks.filter((c) => !c.ok);
  const passing = checks.filter((c) => c.ok);
  const items = [...failing, ...queue];
  return `
    <div class="pov-panel-head"><h3 id="pov-attention-title" tabindex="-1">${icon("alert")}Important actions</h3>
      ${items.length ? `<span class="pov-count warn">${items.length}</span>` : ""}</div>
    ${items.length ? `<ul class="pov-alerts">${items.map((x) => `
      <li class="pov-alert" data-key="${esc(x.label)}"><span class="pov-alert-icon" aria-hidden="true">${icon("alert")}</span>
        <div class="pov-alert-text"><b>${esc(x.label)}</b><span>${esc(x.detail)}</span></div>
        ${x.link ? `<a class="btn btn-outline pov-alert-go" href="${esc(withVia(x.link, "platform-overview"))}">Open<span class="sr-only">: ${esc(x.label)}</span></a>` : ""}
      </li>`).join("")}</ul>`
      : `<div class="pov-allgood">${icon("check")}<div><b>Nothing is waiting.</b><span>All ${checks.length} health checks pass and no queue has anything in it.</span></div></div>`}
    ${passing.length && items.length ? `<details class="pov-passing"><summary>${icon("check")} ${plural(passing.length, "health check")} passing</summary>
      <ul>${passing.map((x) => `<li data-key="${esc(x.label)}"><b>${esc(x.label)}</b><span>${esc(x.detail)}</span></li>`).join("")}</ul></details>` : ""}`;
}

function recentList(entries, describe, securityIds) {
  if (!entries.length) return `<div class="empty-state"><b>No changes recorded yet.</b><div>Each change made in the portal — accounts, schools, settings — appears here.</div></div>`;
  const key = entries.some((e) => securityIds.has(e.id))
    ? `<p class="pov-note"><i class="pov-key-security" aria-hidden="true"></i>Orange: a change to who can sign in or what they can reach.</p>` : "";
  return `<ol class="pov-feed">${entries.map((e) => {
    const said = describe ? describe(e) : { what: e.action, detail: "" };
    const who = e.actorName || (e.actorKind === "system" ? "System" : "Someone");
    const target = e.targetName && e.targetId !== e.actorId ? ` — ${e.targetName}` : "";
    return `<li class="pov-feed-item${securityIds.has(e.id) ? " security" : ""}" data-key="${esc(String(e.id))}">
      <span class="pov-feed-dot" aria-hidden="true"></span>
      <div class="pov-feed-text"><span><b>${esc(who)}</b> ${esc(said.what)}${esc(target)}</span>
        ${said.detail ? `<span class="pov-feed-detail">${esc(said.detail)}</span>` : ""}</div>
      <time datetime="${esc(e.at)}" title="${esc(fmtWhen(e.at))}">${esc(since(e.at))}</time>
    </li>`;
  }).join("")}</ol>${key}`;
}

/** The whole page from what has arrived so far. `x` holds the four later
    replies — each `undefined` while it's on its way and `null` if it
    couldn't be read — so the page can be drawn at any moment, and drawn
    again (in place: live.js swap) as each one lands or changes.

    A command centre, not another management page: the platform's state,
    then a summary of each part — people, data, the system — with a link
    to where the detail lives, then what is waiting on someone and what
    changed last. Nothing here is the full list; every list has a page. */
function overviewHtml(d, x, describe) {
  const a = d.accounts, k = d.integrations.kobo, n = d.integrations.notifications;
  const failing = d.checks.filter((c) => !c.ok).length;
  const passing = d.checks.length - failing;
  const retryLink = `<button type="button" class="intel-link" data-pov-refresh>Try again</button>`;
  const securityIds = new Set((d.recentSecurity || []).map((e) => e.id));
  const warnText = (t) => `<b class="pov-warn-text">${t}</b>`;

  // Data quality: the score's history, once it's in.
  const hist = (x.dq?.history || []).filter((h) => h.score != null);
  const dqTrend = hist.length >= 2 ? delta(hist.at(-1).score - hist.at(-2).score, { unit: " pts", what: "since the last scan" }) : "";
  const dqSub = d.dataQuality.score == null ? "Not scanned yet"
    : `${d.dataQuality.high ? warnText(plural(d.dataQuality.high, "high-severity issue") + " open") : plural(d.dataQuality.open, "open issue")}${dqTrend ? `<br>${dqTrend}` : ""}`;

  // Learners: who signed in this week, once it's in.
  const L = x.act?.learners;
  const learnersSub = `${L?.enrolled != null ? `${num(L.signedIn7d)} signed in this week · ` : ""}${d.learners.lockedNow ? warnText(`${num(d.learners.lockedNow)} locked out right now`) : "none locked out"}`;

  // Kobo: counted against received, and what's waiting for review.
  let kobo = { value: "—", unit: "", sub: "KoboToolbox isn't connected", viz: "", go: "Connect KoboToolbox", warn: false, review: 0 };
  if (k.connected && x.kobo === undefined) kobo = { ...kobo, value: pending("Field data"), sub: "", go: "View Kobo data" };
  else if (k.connected && x.kobo === null) kobo = { ...kobo, sub: "Couldn't be read just now.", go: "View Kobo data" };
  else if (k.connected) {
    const live = (x.kobo.forms || []).filter((f) => f.active !== false);
    const got = live.reduce((t, f) => t + (f.pipeline?.received ?? 0), 0);
    const counted = live.reduce((t, f) => t + (f.pipeline?.counted ?? 0), 0);
    const review = live.reduce((t, f) => t + (f.pipeline?.needsReview ?? 0), 0);
    kobo = {
      value: num(counted), unit: `of ${num(got)}`, warn: review > 0, review, go: "View Kobo data",
      sub: !got ? "No submissions yet" : review ? warnText(`${plural(review, "submission")} ${review === 1 ? "needs" : "need"} review`) : "Nothing waiting for review",
      viz: got ? meter(counted, got, `${counted} of ${got} Kobo submissions counted on the dashboards`) : "",
    };
  }

  // What changed: activity per day and the latest changes, from the audit log.
  let changes = pending("Changes"), recent = "";
  if (x.audit === null) {
    changes = `<p class="pov-note">The change history couldn't be read just now. ${retryLink}</p>`;
    recent = recentList((d.recentSecurity || []).slice(0, 5), describe, securityIds);
  } else if (x.audit) {
    const entries = (x.audit.entries || []).slice().sort((p, q) => String(q.at).localeCompare(String(p.at)));
    const series = perDay(entries, 14);
    const thisWeek = series.slice(7).reduce((t, s) => t + s.n, 0);
    const lastWeek = series.slice(0, 7).reduce((t, s) => t + s.n, 0);
    // 200 entries may not reach back 14 days on a busy platform: then the oldest days are incomplete.
    const partial = x.audit.nextBefore && entries.length && Date.now() - new Date(entries.at(-1).at).getTime() < 14 * DAY;
    changes = thisWeek + lastWeek === 0
      ? `<div class="empty-state"><b>No recent changes</b><div>Nothing has been recorded in the audit log in the last 14 days.</div></div>`
      : `<div class="pov-activity-sum"><span class="pov-big">${num(thisWeek)}</span>
          <span>${thisWeek === 1 ? "change" : "changes"} in the last 7 days ${partial ? "" : delta(thisWeek - lastWeek, { what: "on the week before" })}</span></div>
        ${activityChart(series)}`;
    recent = recentList(entries.slice(0, 5), describe, securityIds);
  }
  const recency = x.act === undefined ? pending("Sign-ins")
    : x.act === null ? `<p class="pov-note">Sign-ins couldn't be read just now. ${retryLink}</p>` : recencyBlock(x.act);

  // Queues with something in them — waiting on a person, not on a setting.
  const queue = [
    kobo.review && { label: `${plural(kobo.review, "Kobo submission")} ${kobo.review === 1 ? "needs" : "need"} review`, detail: "Submissions that failed a check wait for someone to accept, correct or reject them.", link: "#kobo" },
    d.dataQuality.high && { label: `${plural(d.dataQuality.high, "high-severity data issue")} open`, detail: "Found by the Data Quality Center's last scan.", link: "#data-quality?severity=HIGH" },
    d.learners.lockedNow && { label: `${plural(d.learners.lockedNow, "learner")} locked out`, detail: "Too many wrong PINs — a teacher or an administrator can unlock them.", link: "admin.html#learners" },
  ].filter(Boolean);
  const waiting = failing + queue.length;

  const roles = a.byRole.filter((r) => r.active).map((r) => `${esc(r.label)} <b>${num(r.active)}</b>`).join(" · ");

  return `
    <div class="pov">
      <header class="pov-head">
        <h2 class="pov-title">Platform overview</h2>
        <span data-live-host></span>
      </header>

      <section class="pov-state ${failing ? "warn" : "ok"}" aria-labelledby="pov-state-title">
        <span class="pov-state-icon" aria-hidden="true">${icon(failing ? "alert" : "check")}</span>
        <div class="pov-state-text">
          <h3 id="pov-state-title">${failing ? `${plural(failing, "health check needs", "health checks need")} attention` : "All systems normal"}</h3>
          <p>${num(passing)} of ${plural(d.checks.length, "health check")} pass${queue.length ? ` · ${plural(queue.length, "queue")} waiting for someone` : ""}${d.platform
            ? ` · API ${esc(String(d.platform.release).slice(0, 7))}, ${esc(d.platform.environment)}` : ""}</p>
        </div>
        ${waiting ? `<button type="button" class="btn btn-outline pov-state-go" data-pov-jump>Review ${plural(waiting, "action")}</button>` : ""}
      </section>

      <div class="cc-grid">
        <section class="pov-panel cc-users" aria-labelledby="cc-users-title">
          <div class="pov-panel-head"><h3 id="cc-users-title">${icon("users")}User activity</h3></div>
          ${stat({ value: num(a.active), label: "Staff accounts", warn: a.pending > 0,
            sub: a.pending ? warnText(`${plural(a.pending, "account")} waiting for approval`) : `active · ${num(a.total)} in all`,
            href: a.pending ? "#users?status=pending" : "#users", go: a.pending ? "Review approvals" : "View users" })}
          ${stat({ value: num(a.signedIn7d), label: "Signed in this week",
            sub: `${pct(a.signedIn7d, a.active)}% of active staff${a.neverSignedIn ? ` · ${num(a.neverSignedIn)} never` : ""}`,
            viz: meter(a.signedIn7d, a.active, `${a.signedIn7d} of ${a.active} active staff signed in this week`), href: "#account-activity", go: "View account activity" })}
          ${stat({ value: num(d.learners.enrolled), label: "Learners enrolled", warn: d.learners.lockedNow > 0, sub: learnersSub,
            viz: L?.enrolled ? meter(L.signedIn7d, L.enrolled, `${L.signedIn7d} of ${L.enrolled} enrolled learners signed in this week`) : "",
            href: "admin.html#learners", go: "View learners" })}
          <div class="cc-more"><h4 class="pov-subhead">When staff last signed in</h4>${recency}</div>
          ${roles ? `<p class="pov-note cc-roles">By role: ${roles}</p>` : ""}
        </section>

        <section class="pov-panel cc-data" aria-labelledby="cc-data-title">
          <div class="pov-panel-head"><h3 id="cc-data-title">${icon("survey")}Data activity</h3></div>
          ${stat({ value: kobo.value, unit: kobo.unit, label: "Field submissions counted", sub: kobo.sub, viz: kobo.viz, warn: kobo.warn, href: "#kobo", go: kobo.go })}
          ${stat({ value: d.dataQuality.score == null ? "—" : `${num(d.dataQuality.score)}%`, label: "Data quality score",
            warn: d.dataQuality.high > 0, sub: dqSub, viz: scoreSpark(hist), href: "#data-quality", go: "View data quality" })}
          ${stat({ value: num(d.organisation.schools), label: "Schools", sub: `in ${plural(d.organisation.counties, "county", "counties")}`, href: "#schools", go: "View schools" })}
        </section>

        <section class="pov-panel cc-system" aria-labelledby="cc-system-title">
          <div class="pov-panel-head"><h3 id="cc-system-title">${icon("plug")}System activity</h3></div>
          ${sysRow({ name: "KoboToolbox sync", href: "#kobo", go: "KoboToolbox",
            tone: !k.connected ? "off" : k.failing.length ? "warn" : "ok",
            state: k.connected ? `Synced ${agoTag(k.lastSync, since(k.lastSync))} · ${plural(k.surveys, "survey")}${k.failing.length ? ` · ${warnText(`${plural(k.failing.length, "survey")} failing`)}` : ""}` : "Not connected" })}
          ${sysRow({ name: "Live push from Kobo", tone: k.pushConfigured ? "ok" : "off",
            state: k.pushConfigured ? "Set up — submissions arrive as they're sent" : "Not set up — submissions arrive with the hourly sync" })}
          ${sysRow({ name: "Hourly notifications", href: "#notifications", go: "Notifications sent",
            tone: !n ? "off" : n.error ? "warn" : "ok",
            state: n ? `Ran ${agoTag(n.lastRunAt, since(n.lastRunAt))} · ${plural(n.created, "notification")} created${n.error ? ` · ${warnText("failed")}` : ""}` : "Never run" })}
          ${sysRow({ name: "Field devices", href: "#sync-problems", go: "Device sync",
            tone: d.devices.needAttention ? "warn" : d.devices.reporting ? "ok" : "off",
            state: d.devices.reporting ? `${plural(d.devices.reporting, "device")} reporting${d.devices.needAttention ? ` · ${warnText(`${num(d.devices.needAttention)} need attention`)}` : " · all fine"}` : "No device has reported yet" })}
          ${sysRow({ name: "Access exceptions", href: "#permissions", go: "Permissions", tone: d.access.grants || d.access.scopedStaff ? "ok" : "off",
            state: `${plural(d.access.grants, "extra permission")} · ${plural(d.access.scopedStaff, "person", "people")} with a narrowed scope` })}
        </section>

        ${x.pics === null ? "" : `<section class="pov-panel cc-pics" aria-labelledby="cc-pics-title">
          <div class="pov-panel-head"><h3 id="cc-pics-title">${icon("chart")}Programme at a glance</h3>
            <a class="cc-go" href="#overview?via=platform-overview">Executive overview<span aria-hidden="true"> →</span></a></div>
          <div class="chart-grid">${x.pics ?? skeletonCharts(2)}</div>
        </section>`}

        <section class="pov-panel pov-attention cc-actions" aria-labelledby="pov-attention-title">${actionsPanel(d.checks, queue)}</section>

        <section class="pov-panel cc-changes" aria-labelledby="cc-changes-title">
          <div class="pov-panel-head"><h3 id="cc-changes-title">${icon("log")}Recent changes</h3></div>
          <div>${changes}</div>
          ${recent ? `<h4 class="pov-subhead">Latest</h4>${recent}` : ""}
          <p class="cc-links"><a class="cc-go" href="#audit">View audit log<span aria-hidden="true"> →</span></a>
            <a class="cc-go" href="#audit?kind=security">Security events<span aria-hidden="true"> →</span></a></p>
        </section>
      </div>
    </div>`;
}

/** The page's shape while the first read is on its way. */
const overviewSkeleton = () => `
  <div class="pov" aria-hidden="true">
    <div class="pov-state"><span class="skeleton-block pov-skel-line" style="width:45%"></span></div>
    <div class="cc-grid">${`<div class="pov-panel cc-users">${skeleton(3, { avatar: false })}</div>`.repeat(3)}</div>
  </div><span class="sr-only" role="status">Loading the platform overview</span>`;

const OVERVIEW_EVERY_MS = 5 * 60_000; // as often as the menu's badges and the notifications

export function renderPlatformOverview(el, { describe } = {}) {
  // Already on screen (coming back to this page): keep it, and read again if it has aged.
  if (el.povLive && el.querySelector(".pov-head")) { el.povLive.refreshIfStale(); return Promise.resolve(); }
  const gen = (el.povGen = (el.povGen || 0) + 1);
  const state = { d: null, x: {} };
  const paint = (opts) => (el.povGen === gen ? swap(el, overviewHtml(state.d, state.x, describe), opts) : 0);
  // The four later reads; a failed one is `null`.
  const extras = (d) => ({
    dq: apiGet("/data-quality/summary").catch(() => null),
    audit: apiGet("/audit?limit=200").catch(() => null),
    act: apiGet("/security/activity").catch(() => null),
    kobo: d.integrations.kobo.connected ? apiGet("/kobo/forms").catch(() => null) : Promise.resolve(null),
    // The programme in pictures (impact-ui.js, loaded only here): the Executive overview's heatmaps and histogram.
    pics: Promise.all([apiGet("/impact"), import("./impact-ui.js")]).then(([imp, m]) => m.overviewPictures(imp) || null).catch(() => null),
  });

  /* Refresh (the button, or by itself): everything is read first, with the
     page left as it is; then it's redrawn once, in place, and what changed
     is marked. A part that can't be read this time keeps what it showed. */
  const refresh = async () => {
    const d = await apiGet("/platform/overview");
    const reads = extras(d);
    const x = {};
    for (const key of Object.keys(reads)) x[key] = (await reads[key]) ?? state.x[key] ?? null;
    Object.assign(state, { d, x });
    paint();
  };

  const first = async () => {
    el.innerHTML = overviewSkeleton();
    delete el.dataset.liveDrawn;
    let d;
    try {
      d = await apiGet("/platform/overview");
    } catch (err) {
      if (el.povGen === gen) el.innerHTML = errorState(navigator.onLine ? friendlyError(err) : "This page needs a connection.", first);
      return;
    }
    if (el.povGen !== gen) return;
    Object.assign(state, { d, x: { kobo: d.integrations.kobo.connected ? undefined : null } });
    paint({ highlight: false });
    el.povLive = liveStatus(el.querySelector("[data-live-host]"), { refresh, every: OVERVIEW_EVERY_MS });
    el.povLive.ok();
    // The rest fills in as it arrives; one slow or failed reply doesn't hold up the others.
    const reads = extras(d);
    await Promise.all(Object.keys(reads).map(async (key) => {
      const value = await reads[key];
      if (state.d !== d) return; // refreshed meanwhile
      state.x[key] = value;
      paint({ highlight: false });
    }));
  };

  if (!el.povBound) {
    el.povBound = true;
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-pov-refresh]")) el.povLive?.refresh({ asked: true });
      else if (e.target.closest("[data-pov-jump]")) {
        const h = el.querySelector("#pov-attention-title");
        h?.scrollIntoView({ behavior: "smooth", block: "start" });
        h?.focus({ preventScroll: true });
      }
    });
  }
  return first();
}

/* ------------------------------------------------------------------ Administration overview */
const chartCard = (title, meta, body, { wide = false } = {}) => `<div class="chart-card${wide ? " intel-wide" : ""}">
  <div class="chart-card-head"><b>${esc(title)}</b>${meta ? `<span>${meta}</span>` : ""}</div>${body}</div>`;

/** The dashboard's pictures (GET /admin/overview → charts): where and when field visits happen,
    how big the classes are, learners per teacher and enrolment by school and grade. */
function adminCharts(d) {
  const C = d.charts;
  if (!C) return ""; // an API from before them
  const V = C.visits;
  const byCounty = V.rowsAre === "county";
  const months = monthPoints(V.months.map((m) => ({ label: m, value: 0 }))).map(({ drill: _, ...m }) => ({ ...m, short: m.label.slice(0, 1) }));
  // A place's row opens its field visits.
  const visits = chartCard("Field visits by place and month", `${byCounty ? "Counties" : "Schools"} · last 12 months`,
    heatmap(V.rows.map((r) => ({ ...r, href: withVia(`#field-visits?${byCounty ? "county" : "school"}=${encodeURIComponent(r.label)}`, "admin-overview") })), months,
      { corner: byCounty ? "County" : "School", caption: "Field visits each month", noun: "visits", empty: "No field visits recorded yet." }), { wide: true });
  const classes = C.classSizes.reduce((t, b) => t + b.value, 0);
  const sizes = chartCard("Class sizes", classes ? `${plural(classes, "class", "classes")} this year` : "",
    histogram(C.classSizes, { noun: "classes", title: "Classes by number of learners", empty: "No classes this year yet." }));
  const ratio = chartCard("Learners per teacher", "Active teachers, school by school",
    barList(C.perTeacher.map((r) => ({ label: r.label, value: r.value ?? 0, note: r.teachers ? `${plural(r.learners, "learner")} · ${plural(r.teachers, "teacher")}` : "no active teacher" })),
      { noun: "learners per teacher", empty: "No schools yet." }));
  const E = C.enrolment;
  const enrol = chartCard("Learners by school and grade", "Active learners",
    heatmap(E.rows, E.grades.map((g) => ({ label: g, short: g.replace(/^Grade\s*/i, ""), full: g })),
      { corner: "School", caption: "Active learners by school and grade", noun: "learners", empty: "No learners enrolled yet." }), { wide: true });
  return `<div class="chart-grid admin-charts">${visits}${sizes}${ratio}${enrol}</div>`;
}

export function renderAdminOverview(el) {
  return liveLoad(el, "/admin/overview", (d) => {
    const o = d.organisation, p = d.people, ops = d.operations;
    const attention = [
      p.pending && [`${plural(p.pending, "account")} waiting for approval`, "#users?status=pending"],
      o.fieldOfficersWithoutSchools && [`${plural(o.fieldOfficersWithoutSchools, "field officer")} without assigned schools`, "#users?role=field_officer"],
      o.schoolsWithoutHead && [`${plural(o.schoolsWithoutHead, "school")} without a school head`, "#school-profiles"],
      o.teachersWithoutClasses && [`${plural(o.teachersWithoutClasses, "teacher")} not teaching any class`, "#teachers"],
      p.learnersWithoutClass && [`${plural(p.learnersWithoutClass, "learner")} not in a class`, "#learners"],
      ops.koboNeedsReview && [`${plural(ops.koboNeedsReview, "Kobo submission")} ${ops.koboNeedsReview === 1 ? "needs" : "need"} review`, "#kobo"],
      ops.dataQualityHigh && [`${plural(ops.dataQualityHigh, "high-severity data issue")}`, "#data-quality?severity=HIGH"],
    ].filter(Boolean);
    return `
      <div class="panel-head" style="margin-bottom:.6rem"><h2 style="margin:0">Administration overview</h2>
        <span class="live-head"><span class="chart-meta" style="margin:0">${esc(d.scope.label)}${d.currentTerm ? ` · ${esc(String(d.currentTerm).replace(/^(\d{4})-T(\d)$/, "$1 Term $2"))}` : ""}</span><span data-live-host></span></span></div>
      <div class="stat-row exec-row">
        ${kpiCard({ label: "Schools", icon: "school", value: count(o.schools), href: withVia("#schools", "admin-overview"),
          sub: `${o.counties} counties · ${o.classes} classes this year` })}
        ${kpiCard({ label: "Teachers", icon: "teacher", value: count(p.teachers), href: withVia("#teachers", "admin-overview"),
          sub: `${p.heads} school heads` })}
        ${kpiCard({ label: "Learners", icon: "cap", value: count(p.learners), href: withVia("#learners", "admin-overview"),
          sub: p.learnersWithoutClass ? warnText(`${p.learnersWithoutClass} not in a class`) : "All in a class" })}
        ${kpiCard({ label: "Field officers", icon: "users", value: count(p.fieldOfficers), href: withVia("#users?role=field_officer", "admin-overview"),
          sub: o.fieldOfficersWithoutSchools ? warnText(`${o.fieldOfficersWithoutSchools} without schools`) : "All have schools" })}
        ${kpiCard({ label: "Field visits this term", icon: "pin", value: count(ops.visitsThisTerm),
          href: withVia(d.currentTerm ? `#field-visits?term=${encodeURIComponent(d.currentTerm)}` : "#field-visits", "admin-overview"),
          sub: d.currentTerm ? `since ${esc(String(d.currentTerm).replace(/^(\d{4})-T(\d)$/, "Term $2"))} began` : "" })}
        ${kpiCard({ label: "Open forms", icon: "form", value: count(ops.openForms), href: withVia("#forms", "admin-overview"), sub: "open for responses" })}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Needs attention</h2>${attention.length ? `<span class="count-badge">${attention.length}</span>` : ""}</div>
        ${attention.length ? `<div>${attention.map(([t, link]) => `<div class="task-row" data-key="${esc(link)}"><div style="flex:1"><b>${esc(t)}</b></div>
          <div class="roster-actions"><a class="intel-link" href="${esc(withVia(link, "admin-overview"))}">Open</a></div></div>`).join("")}</div>`
          : `<div class="empty-state">Nothing needs attention right now.</div>`}
      </div>
      ${adminCharts(d)}`;
  }, { every: OVERVIEW_EVERY_MS });
}

/* ------------------------------------------------------------------ Permissions (Super Admin) */
export function renderPermissions(el, { onRevoke } = {}) {
  const draw = () => load(el, "/permissions", (d) => {
    const roles = d.roles;
    return `
      <div class="panel">
        <div class="panel-head"><h2>Permissions by role</h2></div>
        <p class="hint" style="margin-top:0">To give one person more: <a href="#users">Users &amp; roles</a> → <b>View</b>.</p>
        <div class="lms-table-wrap"><table class="lms-table intel-table perm-matrix">
          <thead><tr><th class="lms-name">Permission</th>${roles.map((r) => `<th title="${esc(r.workspace?.title || "")}">${esc(r.label)}</th>`).join("")}</tr></thead>
          <tbody>${d.groups.map((g) => `<tr><td class="lms-name lms-group" colspan="${roles.length + 1}"><b>${esc(g.group)}</b></td></tr>${
            g.items.map((it) => `<tr><td class="lms-name">${esc(it.label)}<br><span class="hint-inline">${esc(it.permission)}</span></td>${
              roles.map((r) => `<td>${r.permissions.includes(it.permission) ? '<span class="perm-yes" aria-label="yes">✓</span>' : ""}</td>`).join("")}</tr>`).join("")}`).join("")}</tbody>
        </table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Granted individually</h2><span class="chart-meta" style="margin:0">${d.grants.length} open</span></div>
        ${table(["Person", "Permission", "Reason", "Granted", ""], d.grants.map((g) => [
          `<b>${esc(g.person)}</b><br><span class="hint-inline">${esc(g.role || "")}</span>`, esc(g.label), esc(g.reason),
          `${esc(fmtDay(g.grantedAt))}${g.grantedBy ? `<br><span class="hint-inline">by ${esc(g.grantedBy)}</span>` : ""}`,
          d.canGrant ? `<button type="button" class="btn btn-ghost q-small" data-revoke="${esc(g.id)}" data-profile="${esc(g.profileId)}">Revoke</button>` : "",
        ]), "No one has been granted anything beyond their role.")}
      </div>`;
  }, draw);
  el.onclick = async (e) => {
    const b = e.target.closest("[data-revoke]");
    if (!b) return;
    const reason = await askReason("Revoke this permission?", "They lose it straight away. Say why, for the record.");
    if (!reason) return;
    try {
      await apiSend("POST", `/users/${b.dataset.profile}/grants/${b.dataset.revoke}/revoke`, { reason });
      toast("Permission revoked", "", "success");
      onRevoke?.();
      draw();
    } catch (err) { toast("Couldn't revoke it", friendlyError(err), "error"); }
  };
  return draw();
}

/** A small "why" prompt (required, kept in the audit log). Resolves to the text, or null. */
function askReason(title, body) {
  return new Promise((resolve) => {
    let done = false;
    const panel = openContentPanel({ title, html: `<form class="fill-form"><p class="hint" style="margin-top:0">${esc(body)}</p>
      <div class="field"><label for="why">Reason</label><input id="why" maxlength="500" required minlength="3"></div>
      <div class="lms-actions"><button class="btn btn-primary" type="submit">Confirm</button></div></form>` }, () => { if (!done) resolve(null); });
    panel.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = panel.querySelector("#why").value.trim();
      if (v.length < 3) return;
      done = true;
      resolve(v);
      closeViewer();
    });
    setTimeout(() => panel.querySelector("#why")?.focus(), 50);
  });
}

/* ------------------------------------------------------------------ Account activity (Super Admin) */
export function renderAccountActivity(el) {
  return load(el, "/security/activity", (d) => `
    <div class="panel-head" style="margin-bottom:.6rem"><h2 data-page-title style="margin:0">Account activity</h2></div>
    <div class="stat-row">
      ${kpiCard({ label: "Learners enrolled", icon: "cap", value: count(d.learners.enrolled), sub: "active learner accounts" })}
      ${kpiCard({ label: "Learners signed in this week", icon: "activity", value: count(d.learners.signedIn7d),
        sub: d.learners.enrolled ? `${Math.round((d.learners.signedIn7d / d.learners.enrolled) * 100)}% of enrolled learners · last 7 days` : "last 7 days" })}
      ${kpiCard({ label: "Learners locked out now", icon: "shield", value: count(d.learners.lockedNow), tone: d.learners.lockedNow ? "warn" : "",
        sub: `${d.learners.withFailedAttempts} with failed PIN attempts` })}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Staff sign-ins</h2></div>
      ${table(["Name", "Role", "Status", "Where", "Last sign-in", "Account created"], d.staff.map((p) => [
        `<b>${esc(p.name)}</b><br><span class="hint-inline">${esc(p.email || "")}</span>`, esc(p.roleLabel), statusPill(p.status),
        esc(p.place || "—"), `${esc(ago(p.lastSignInAt))}${p.lastSignInAt ? `<br><span class="hint-inline">${esc(fmtWhen(p.lastSignInAt))}</span>` : ""}`,
        esc(fmtDay(p.createdAt)),
      ]))}
    </div>`, () => renderAccountActivity(el));
}

/* ------------------------------------------------------------------ Teachers (directory, no account actions) */
let teachersCache = null;
export async function renderTeachers(el, { q = "", role = "", county = "", school = "" } = {}, { fresh = false } = {}) {
  if (!teachersCache || fresh) {
    el.innerHTML = skeletonTable(5, 7);
    try { teachersCache = await apiGet("/teachers"); } catch (err) {
      el.innerHTML = errorState(friendlyError(err), () => renderTeachers(el, { q, role, county, school }, { fresh: true }));
      return;
    }
  }
  const needle = q.trim().toLowerCase();
  const list = teachersCache.teachers.filter((t) => (!role || t.role === role) && (!county || t.county === county) && (!school || t.school === school) &&
    (!needle || [t.name, t.school, t.county, t.code].some((v) => String(v || "").toLowerCase().includes(needle))));
  const meta = document.getElementById("tchMeta");
  if (meta) meta.textContent = `${ofAll(list.length, teachersCache.teachers.length, "person")} · ${teachersCache.scope}`;
  if (!list.length && teachersCache.teachers.length) {
    el.innerHTML = `<div class="empty-state">No one matches${needle ? ` “${esc(q.trim())}”` : ""}${school ? ` at ${esc(school)}` : county ? ` in ${esc(county)} County` : ""}. Clear the search or a filter above to see more.</div>`;
    return;
  }
  el.innerHTML = table(["Name", "Role", "School", "County", "Type", "Classes taught", "Trainings"], list.map((t) => [
    `<b>${esc(t.name)}</b>${t.code ? `<br><span class="code-chip">${esc(t.code)}</span>` : ""}`, esc(t.roleLabel), esc(t.school), esc(t.county),
    esc(t.teacherType || "—"), esc(t.classes.join(", ") || "—"), t.trainings,
  ]), "No teachers in your area yet.");
}

/* ------------------------------------------------------------------ Classes (read-only structure) */
export function renderClasses(el, schoolId) {
  if (!schoolId) { el.innerHTML = `<div class="empty-state"><b>Choose a school</b><div>Its classes for this year appear here.</div></div>`; return null; }
  return load(el, `/classes?schoolId=${encodeURIComponent(schoolId)}`, (d) => table(
    ["Class", "Grade", "Teachers", "Learners"],
    d.classes.map((k) => [`<b>${esc(k.name)}</b>`, esc(k.grade), esc(k.teachers.map((t) => t.name).filter(Boolean).join(", ") || "None yet"), k.learnerCount]),
    `No classes for ${d.academicYear || "this year"} in this school yet.`,
  ), () => renderClasses(el, schoolId));
}

/* ------------------------------------------------------------------ School profiles */
export function renderSchoolProfile(el, schoolId) {
  if (!schoolId) { el.innerHTML = `<div class="empty-state"><b>Choose a school</b><div>Its profile appears here.</div></div>`; return null; }
  return load(el, `/schools/${encodeURIComponent(schoolId)}/profile`, schoolProfileHtml, () => renderSchoolProfile(el, schoolId), skeletonCards(4) + skeletonTable(3, 3));
}
/** `link(tab)`: the address of one of the school's tabs, when the page has them and this person may open it. */
export function schoolProfileHtml(d, { heading = true, link = () => "" } = {}) {
  return `
    ${heading ? `<div class="panel-head" style="margin-bottom:.4rem"><h2 style="margin:0">${esc(d.school.name)}</h2>
      <span class="chart-meta" style="margin:0"><span class="code-chip">${esc(d.school.code)}</span> · ${esc(d.school.county)} County</span></div>` : ""}
    <div class="stat-row">
      ${kpiCard({ label: "Teachers", icon: "teacher", value: count(d.teachers), href: link("teachers"),
        sub: d.heads.length ? `School head: ${esc(d.heads.join(", "))}` : warnText("No school head yet") })}
      ${kpiCard({ label: "Learners", icon: "cap", value: count(d.learners), href: link("learners"), sub: `${d.classes.length} classes this year` })}
      ${visitCards(d, link)}
    </div>
    <div class="body-grid">
      <div>
        <h3 class="mini-head">Classes this year</h3>
        ${table(["Class", "Grade", "Learners"], d.classes.map((k) => [esc(k.name), esc(k.grade), k.learners]), "No classes this year yet — the school head adds them.")}
        <h3 class="mini-head">Learners by grade</h3>
        ${table(["Grade", "Learners"], d.learnersByGrade.map((g) => [esc(g.grade), g.learners]), "No learners enrolled yet — teachers add them to their classes.")}
      </div>
      <div>
        ${recentVisits(d)}
      </div>
    </div>`;
}
const visitCards = (d, link = () => "") => `
      ${kpiCard({ label: "Field visits", icon: "pin", value: count(d.visits.total), href: link("visits"),
        sub: d.visits.last ? `Last visit ${esc(ago(d.visits.last).toLowerCase())}` : "None yet" })}
      ${kpiCard({ label: "Kobo submissions", icon: "survey", value: count(d.kobo.submissions), sub: `${d.kobo.counted} counted` })}`;
const recentVisits = (d) => `
        <h3 class="mini-head">Recent visits${d.visits.total > d.visits.recent.length ? ` <span class="hint-inline">· latest ${d.visits.recent.length} of ${count(d.visits.total)}</span>` : ""}</h3>
        ${table(["Date", "Type", "Officer"], d.visits.recent.map((v) => [esc(fmtDay(v.date)), esc(v.type), esc(v.officer || "—")]), "No visits recorded yet.")}
        <p class="hint">${d.supportedBy.length ? `Supported by ${esc(d.supportedBy.join(", "))}.` : "No field officer is assigned to this school yet."}</p>`;
/** A school head's Visits page: how many, the latest and who made them, who supports the school —
    the visit part of the school page. False (and `el` left as it is) when it can't be read. */
export async function renderSchoolVisits(el, schoolId) {
  if (!schoolId) return false;
  try {
    const d = await apiGet(`/schools/${encodeURIComponent(schoolId)}/profile`);
    el.innerHTML = `<div class="stat-row">${visitCards(d)}</div>${recentVisits(d)}`;
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ Schools: one module, everywhere
   docs/NAVIGATION.md, "one function, one home": the list of the schools
   this person may see, then one page per school with its tabs — Overview,
   Teachers, Learners & classes, Visits, Assessments, Devices. The console's
   Schools and a field officer's My schools are this same module (the API
   sends each person only their schools). A tab shows only with the
   permission its data needs, and the API checks every request again.
   Addresses: <base>?school=<id>&tab=<tab>. */
const SCHOOL_TABS = [
  ["overview", "Overview", ["schools.profile.view"]],
  ["teachers", "Teachers", ["teachers.view"]],
  ["learners", "Learners & classes", ["learners.view.all", "learners.view.school"]],
  ["visits", "Visits", ["field_reports.view.all", "field_reports.view.own"]],
  ["assessments", "Assessments", ["assignments.view.all", "assignments.view.school"]],
  ["devices", "Devices", ["sync.problems.view"]],
];
let schoolDirectory = null;

/** The list, or one school. `actions(school, { inList })` adds buttons to a school's row and page (e.g.
    Start visit): the main button on a school's page, an ordinary one repeated down the list. */
export async function renderSchoolsModule(el, { params = new URLSearchParams(), perms = new Set(), base = "#school-profiles", actions = () => "", fresh = false, filter = {} } = {}) {
  if (!schoolDirectory || fresh) {
    el.innerHTML = skeleton(4, { avatar: false });
    try { schoolDirectory = await apiGet("/schools"); } catch (err) {
      el.innerHTML = errorState(navigator.onLine ? friendlyError(err) : "This page needs a connection.", () => renderSchoolsModule(el, { params, perms, base, actions, fresh: true }));
      return;
    }
  }
  const schools = schoolDirectory.schools || [];
  const id = params.get("school");
  if (!id) { schoolListHtml(el, schools, { base, actions, filter }); return; }
  const school = schools.find((s) => s.id === id);
  if (!school) {
    el.innerHTML = `<div class="empty-state"><b>That school isn't in your area.</b><div><a href="${esc(base)}">All schools</a></div></div>`;
    return;
  }
  const tabs = SCHOOL_TABS.filter(([, , needs]) => needs.some((p) => perms.has(p)));
  const tab = tabs.find(([t]) => t === params.get("tab"))?.[0] ?? tabs[0]?.[0] ?? "overview";
  const at = (t) => `${base}?school=${encodeURIComponent(id)}${t === "overview" ? "" : `&tab=${t}`}`;
  el.innerHTML = `
    <div class="school-head">
      <div class="school-title"><h2>${esc(school.name)}</h2>
        <span class="chart-meta" style="margin:0"><span class="code-chip">${esc(school.code)}</span> · ${esc(school.county)} County</span></div>
      <div class="school-actions">${actions(school)}</div>
    </div>
    <nav class="school-tabs" aria-label="${esc(school.name)} — sections">${tabs.map(([t, label]) =>
      `<a class="module-tab${t === tab ? " active" : ""}" href="${esc(at(t))}"${t === tab ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("")}</nav>
    <div class="school-tab-body"></div>`;
  extendTrail([{ label: school.name, href: at("overview") }, ...(tab === "overview" ? [] : [{ label: tabs.find(([t]) => t === tab)[1] }])]);
  const body = el.querySelector(".school-tab-body");
  const sid = encodeURIComponent(id);
  switch (tab) {
    case "overview":
      await load(body, `/schools/${sid}/profile`, (d) => schoolProfileHtml(d, { heading: false, link: (t) => (tabs.some(([x]) => x === t) ? at(t) : "") }),
        () => renderSchoolsModule(el, { params, perms, base, actions }));
      break;
    case "teachers":
      await load(body, "/teachers", (d) => table(["Name", "Role", "Type", "Classes taught", "Trainings"],
        d.teachers.filter((t) => t.schoolId === id).map((t) => [
          `<b>${esc(t.name)}</b>${t.code ? `<br><span class="code-chip">${esc(t.code)}</span>` : ""}`, esc(t.roleLabel), esc(t.teacherType || "—"),
          esc(t.classes.join(", ") || "—"), t.trainings,
        ]), "No teachers at this school yet."), () => renderSchoolsModule(el, { params, perms, base, actions }));
      break;
    case "learners": {
      body.innerHTML = `<h3 class="mini-head">Classes this year</h3><div data-classes></div><h3 class="mini-head">Learners</h3><div data-learners></div>`;
      await Promise.all([
        renderClasses(body.querySelector("[data-classes]"), id),
        load(body.querySelector("[data-learners]"), `/learners?schoolId=${sid}`, (d) => table(["Learner", "Grade", "Class", "Code"],
          d.learners.map((l) => [`<b>${esc(l.fullName || l.name || "")}</b>`, esc(l.grade || "—"), esc(l.className || "—"), l.learnerCode ? `<span class="code-chip">${esc(l.learnerCode)}</span>` : "—"]),
          "No learners enrolled yet."), () => renderSchoolsModule(el, { params, perms, base, actions })),
      ]);
      break;
    }
    case "visits":
      await load(body, "/field-reports", (d) => table(["Date", "Visit type", "Field officer"],
        d.reports.filter((v) => v.schoolId === id).map((v) => [esc(fmtDay(v.createdAt)), esc(v.visitType), esc(v.officer || "You")]),
        "No visits to this school yet."), () => renderSchoolsModule(el, { params, perms, base, actions }));
      break;
    case "assessments":
      body.innerHTML = `<h3 class="mini-head">Assignments & assessments</h3><div data-asg></div><h3 class="mini-head">Results by class</h3><div data-res></div>`;
      await Promise.all([
        renderAssignments(body.querySelector("[data-asg]"), { schoolId: id }, new Map([[id, school.name]])),
        renderResults(body.querySelector("[data-res]"), { by: "class", schoolId: id }),
      ]);
      break;
    case "devices":
      await load(body, "/sync/problems", (d) => {
        const here = d.stuck.filter((x) => x.schoolId === id);
        return `<p class="hint" style="margin-top:0">Devices of people at this school with work unsent for ${esc(String(d.hours))} hours or more. <a href="#sync-problems">All stuck devices</a></p>`
          + table(["Who", "Device", "Unsent", "Waiting for"], here.map((x) => [
            `<b>${esc(x.name)}</b><br><span class="hint-inline">${esc(x.roleLabel)}</span>`, esc(x.deviceLabel || "A device"),
            esc(String(x.pending + x.failed + x.conflicts)), esc(x.waitingHours >= 48 ? `${Math.floor(x.waitingHours / 24)} days` : `${x.waitingHours} h`),
          ]), "No device at this school has work stuck.");
      }, () => renderSchoolsModule(el, { params, perms, base, actions }));
      break;
    default: break;
  }
}

function schoolListHtml(el, schools, { base, actions, filter = {} }) {
  const inArea = schools.length;
  schools = schools.filter((s) => (!filter.county || s.county === filter.county) && (!filter.school || s.name === filter.school));
  const counties = [...new Set(schools.map((s) => s.county))];
  el.innerHTML = `
    <div class="filter-bar-row" style="margin-bottom:.8rem"><div class="field"><label for="schoolFind">Find a school</label>
      <input id="schoolFind" type="search" placeholder="Name, code or county…" autocomplete="off"></div></div>
    <p class="hint" data-count style="margin-top:0"></p>
    <div data-list></div>`;
  const draw = () => {
    const q = el.querySelector("#schoolFind").value.trim().toLowerCase();
    const shown = schools.filter((s) => !q || [s.name, s.code, s.county].some((v) => String(v || "").toLowerCase().includes(q)));
    el.querySelector("[data-count]").textContent = `${shown.length} of ${inArea} school${inArea === 1 ? "" : "s"}${filter.school ? "" : filter.county ? ` · ${filter.county} County` : ""}`;
    el.querySelector("[data-list]").innerHTML = shown.length ? counties.map((c) => {
      const list = shown.filter((s) => s.county === c);
      return list.length ? `<div class="list-group"><div class="list-group-title">${esc(c)}<span class="count">${list.length}</span></div>
        ${list.map((s) => `<div class="task-row"><div style="flex:1;min-width:0"><a class="school-link" href="${esc(`${base}?school=${encodeURIComponent(s.id)}`)}"><b>${esc(s.name)}</b></a>
          <span><span class="code-chip">${esc(s.code)}</span></span></div>
          <div class="roster-actions">${actions(s, { inList: true })}<a class="btn btn-ghost q-small" href="${esc(`${base}?school=${encodeURIComponent(s.id)}`)}">Open</a></div></div>`).join("")}</div>` : "";
    }).join("") : `<div class="empty-state">${schools.length ? `No school matches “${esc(q)}”. Try its code, or the county.`
      : inArea ? "No school here matches the filters above. Take one off to see more." : "No schools in your area yet."}</div>`;
  };
  el.querySelector("#schoolFind").addEventListener("input", draw);
  draw();
}

/* ------------------------------------------------------------------ Assignments (read-only, across schools) */
/** `county`, `from`, `to`: the dashboard's filters — a school's county comes from `countyOf` (school id → county),
    the dates are the due date (or the day it was set, without one). */
export function renderAssignments(el, { schoolId = "", status = "", subject = "", county = "", from = "", to = "" } = {}, schoolName = new Map(), countyOf = new Map()) {
  const qs = new URLSearchParams(Object.entries({ schoolId, status }).filter(([, v]) => v)).toString();
  return load(el, `/assignments${qs ? `?${qs}` : ""}`, (d) => {
    const day = (a) => String(a.dueAt || a.publishedAt || "").slice(0, 10);
    const all = d.assignments.filter((a) => a.status !== "draft" && (!county || countyOf.get(a.schoolId) === county)
      && (!from || !day(a) || day(a) >= from) && (!to || !day(a) || day(a) <= to));
    // The subject list comes from the assignments themselves.
    const subj = fillChoices(document.getElementById("asgSubject"), all.map((a) => a.subject), "All subjects") || subject;
    const list = all.filter((a) => !subj || a.subject === subj);
    const meta = document.getElementById("asgMeta");
    if (meta) meta.textContent = ofAll(list.length, all.length, "assignment");
    return table(["Assignment", "School / class", "Subject", "Set by", "Due", "Status", "Handed in", "Marked"], list.map((a) => [
      `<b>${esc(a.title)}</b>${a.term ? `<br><span class="hint-inline">${esc(a.term)}</span>` : ""}`,
      `${esc(schoolName.get(a.schoolId) || "")}${a.className ? `<br><span class="hint-inline">${esc(a.className)}</span>` : ""}`,
      esc(a.subject), esc(a.teacherName || "—"), esc(fmtDay(a.dueAt)),
      a.status === "closed" ? `<span class="pill">Closed</span>` : `<span class="pill ok">Open</span>`,
      a.counts ? `${a.counts.submitted} of ${a.counts.expected}` : "—", a.counts ? a.counts.marked : "—",
    ]), all.length ? "No assignments match these filters." : "No assignments in your area yet.");
  }, () => renderAssignments(el, { schoolId, status, subject, county, from, to }, schoolName, countyOf));
}

/* ------------------------------------------------------------------ Results */
export function renderResults(el, { by = "school", schoolId = "", termId = "" } = {}) {
  const qs = new URLSearchParams(Object.entries({ by, schoolId, termId }).filter(([, v]) => v)).toString();
  return load(el, `/results?${qs}`, (d) => (d.rows?.length ? resultsTableHtml(d) : `<div class="empty-state">No results yet — they appear once work is handed in and marked.</div>`),
    () => renderResults(el, { by, schoolId, termId }));
}

/** Which subject does best (compare-ui.js): across the schools in view, or — one school chosen — its grades and classes. */
let compareFor = { schoolId: "", termId: "" };
let compareMounted = null;
export async function renderCompare(el, { schoolId = "", termId = "" } = {}) {
  const one = !!schoolId;
  const remount = !compareMounted || compareMounted.el !== el || compareMounted.one !== one;
  compareFor = { schoolId, termId };
  if (!remount) { compareMounted.c.refresh(); return; }
  try {
    const m = await import("./compare-ui.js");
    const load = (rows) => apiGet(`/results/compare?${new URLSearchParams(Object.entries({ rows, ...compareFor }).filter(([, v]) => v))}`);
    compareMounted = { el, one, c: m.mountCompare(el, { load, choices: one ? [["grade", "Grade"], ["class", "Class"]] : [["school", "School"], ["grade", "Grade"]] }) };
  } catch (err) {
    el.innerHTML = errorState(friendlyError(err));
  }
}

/* ------------------------------------------------------------------ Field visits (everyone's, in scope) */
let visitsCache = null;
export async function renderFieldVisits(el, f = {}, { fresh = false } = {}) {
  const { q = "", type = "", county = "", school = "", from = "", to = "" } = typeof f === "string" ? { q: f } : f;
  if (!visitsCache || fresh) {
    el.innerHTML = skeletonTable(5, 5);
    try { visitsCache = (await apiGet("/field-reports")).reports; } catch (err) {
      el.innerHTML = errorState(friendlyError(err), () => renderFieldVisits(el, f, { fresh: true }));
      return;
    }
  }
  const kind = fillChoices(document.getElementById("fvType"), visitsCache.map((v) => v.visitType), "All visit types") || type;
  const needle = q.trim().toLowerCase();
  const day = (v) => String(v.createdAt || "").slice(0, 10);
  const list = visitsCache.filter((v) => (!kind || v.visitType === kind) && (!county || v.county === county) && (!school || v.school === school)
    && (!from || day(v) >= from) && (!to || day(v) <= to)
    && (!needle || [v.school, v.county, v.visitType, v.officer].some((x) => String(x || "").toLowerCase().includes(needle))));
  const meta = document.getElementById("fvMeta");
  if (meta) meta.textContent = ofAll(list.length, visitsCache.length, "visit");
  el.innerHTML = table(["Date", "School", "County", "Visit type", "Field officer"], list.map((v) => [
    esc(fmtDay(v.createdAt)), `<b>${esc(v.school)}</b>`, esc(v.county), esc(v.visitType), esc(v.officer || "—"),
  ]), visitsCache.length ? "No visits match these filters. Take one off to see more." : "No field visits in your area yet.");
}

/* ------------------------------------------------------------------ Subjects */
export function renderSubjects(el) {
  return load(el, "/subjects", (d) => (d.subjects.length ? `<div class="tag-list">${d.subjects.map((x) => `<span class="pill">${esc(x.name)}</span>`).join(" ")}</div>`
    : emptyState("No subjects yet.", "Add the first one above.")), () => renderSubjects(el), skeleton(2, { avatar: false }));
}
export async function addSubject(name) {
  return apiSend("POST", "/subjects", { name });
}

/* ------------------------------------------------------------------ one account's access */
/** The View panel from Staff accounts: role and workspace, data scope (and
    its history), explicit grants, and the account's change history. */
export async function openUserAccess(u, { counties = [], schools = [], onChanged = () => {} } = {}) {
  const panel = openContentPanel({ title: u.fullName || u.email || "Account", html: skeleton(4, { avatar: false }) });
  async function draw() {
    let a, h;
    try {
      [a, h] = await Promise.all([apiGet(`/users/${u.id}/access`), apiGet(`/users/${u.id}/history`).catch(() => ({ entries: [] }))]);
    } catch (err) {
      panel.innerHTML = errorState(friendlyError(err), draw);
      return;
    }
    const openRows = a.scope.rows.filter((r) => !r.endedAt);
    const openCounties = new Set(openRows.filter((r) => r.type === "county").map((r) => r.county));
    const openSchools = new Set(openRows.filter((r) => r.type === "school").map((r) => r.schoolId));
    panel.innerHTML = `
      <dl class="profile-facts">
        <div><dt>Email</dt><dd>${esc(u.email || "—")}</dd></div>
        <div><dt>Role</dt><dd>${esc(a.roleLabel)}${a.workspace ? ` · ${esc(a.workspace.title)}` : ""}</dd></div>
        <div><dt>Status</dt><dd>${statusPill(u.status || "active")}</dd></div>
        <div><dt>Where</dt><dd>${esc([u.school, u.county].filter(Boolean).join(" · ") || "—")}</dd></div>
        <div><dt>Last sign-in</dt><dd>${esc(ago(u.lastSignInAt))}</dd></div>
        <div><dt>Account created</dt><dd>${esc(fmtDay(u.createdAt))}</dd></div>
      </dl>
      <h3 class="mini-head">Data scope</h3>
      <p class="hint" style="margin-top:0"><b>${esc(a.scope.label)}</b> — ${esc(a.scope.rule)}</p>
      ${a.canEditScope ? `<form class="scope-form fill-form">
        <div class="field"><label>Counties (every school in them)</label>
          <div class="check-grid">${counties.map((c) => `<label class="q-choice"><input type="checkbox" name="county" value="${esc(c)}"${openCounties.has(c) ? " checked" : ""}> ${esc(c)}</label>`).join("")}</div></div>
        <div class="field"><label for="scopeSchools">Single schools</label>
          <select id="scopeSchools" multiple size="6">${schools.map((s) => `<option value="${esc(s.id)}"${openSchools.has(s.id) ? " selected" : ""}>${esc(s.name)} — ${esc(s.county)}</option>`).join("")}</select>
          <p class="field-hint">Hold Ctrl (or ⌘) to pick several. ${a.role === "field_officer" ? "A field officer sees nothing until given a county or school." : "With nothing picked, they see every county and school."}</p></div>
        <div class="lms-actions"><button class="btn btn-primary q-small" type="submit">Save scope</button></div>
      </form>` : ""}
      ${a.scope.rows.length ? `<details class="scope-history"><summary>Scope history (${a.scope.rows.length})</summary>
        ${a.scope.rows.map((r) => `<div class="result-row"><span>${esc(r.type === "county" ? `${r.county} County` : r.school || r.schoolId)}${r.note ? ` <span class="hint-inline">${esc(r.note)}</span>` : ""}</span>
          <span class="hint-inline">from ${esc(fmtDay(r.createdAt))}${r.createdBy ? ` (${esc(r.createdBy)})` : ""}${r.endedAt ? ` · ended ${esc(fmtDay(r.endedAt))}${r.endedBy ? ` (${esc(r.endedBy)})` : ""}` : " · current"}</span></div>`).join("")}
      </details>` : ""}
      <h3 class="mini-head">Permissions</h3>
      <p class="hint" style="margin-top:0">${a.permissions.length} from the ${esc(a.roleLabel)} role${a.grants.some((g) => !g.revokedAt) ? " plus what's granted below" : ""}. <a href="#permissions">See every role</a></p>
      ${a.grants.length ? a.grants.map((g) => `<div class="task-row"><div style="flex:1;min-width:0"><b>${esc(g.label)}</b>
          <span>${esc(g.reason)} · ${esc(fmtDay(g.grantedAt))}${g.grantedBy ? ` by ${esc(g.grantedBy)}` : ""}${g.revokedAt ? ` · revoked ${esc(fmtDay(g.revokedAt))}: ${esc(g.revokeReason || "")}` : ""}</span></div>
          ${a.canGrant && !g.revokedAt ? `<div class="roster-actions"><button type="button" data-revoke="${esc(g.id)}">Revoke</button></div>` : ""}</div>`).join("")
        : `<p class="hint">Nothing granted beyond their role.</p>`}
      ${a.canGrant && a.grantable.length ? `<form class="grant-form fill-form">
        <div class="field"><label for="grantPerm">Grant one more permission</label>
          <select id="grantPerm"><option value="">Choose…</option>${a.grantable.map((p) => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join("")}</select></div>
        <div class="field"><label for="grantWhy">Reason (kept in the audit log)</label><input id="grantWhy" maxlength="500" placeholder="e.g. Covering M&E while Jane is on leave"></div>
        <div class="lms-actions"><button class="btn btn-outline q-small" type="submit">Grant</button></div>
      </form>` : ""}
      <h3 class="mini-head">History</h3>
      ${(h.entries || []).length ? h.entries.map((e) => `<div class="result-row" style="align-items:flex-start">
          <span><b>${esc(e.actorName || "System")}</b> ${esc(e.action)}${e.details?.reason ? `<br><span class="hint-inline">${esc(e.details.reason)}</span>` : ""}</span>
          <span class="hint-inline" style="white-space:nowrap">${esc(fmtWhen(e.at))}</span></div>`).join("") : `<p class="hint">No recorded changes yet.</p>`}`;

    panel.querySelector(".scope-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      const body = {
        counties: [...f.querySelectorAll('input[name="county"]:checked')].map((x) => x.value),
        schoolIds: [...f.querySelector("#scopeSchools").selectedOptions].map((o) => o.value),
      };
      if (!body.counties.length && !body.schoolIds.length && a.role !== "field_officer") {
        const ok = await confirmDialog({ title: "Every county and school?", body: `With nothing assigned, ${u.fullName || "they"} will see every county and school.`, confirmLabel: "Yes, everywhere" });
        if (!ok) return;
      }
      try {
        const res = await apiSend("PUT", `/users/${u.id}/scope`, body);
        toast("Scope saved", res.scope.label, "success");
        onChanged();
        draw();
      } catch (err) { toast("Couldn't save the scope", friendlyError(err), "error"); }
    });
    panel.querySelector(".grant-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const permission = panel.querySelector("#grantPerm").value;
      const reason = panel.querySelector("#grantWhy").value.trim();
      if (!permission) { toast("Choose a permission", "", "error"); return; }
      if (reason.length < 3) { toast("Say why", "A reason is kept with the grant.", "error"); return; }
      try {
        await apiSend("POST", `/users/${u.id}/grants`, { permission, reason });
        toast("Permission granted", "They have it from their next page load.", "success");
        onChanged();
        draw();
      } catch (err) { toast("Couldn't grant it", friendlyError(err), "error"); }
    });
    // Revoke: say why, right there (kept in the audit log).
    panel.onclick = (e) => {
      const b = e.target.closest("[data-revoke]");
      if (!b || b.closest(".task-row").nextElementSibling?.matches(".revoke-form")) return;
      b.closest(".task-row").insertAdjacentHTML("afterend", `<form class="revoke-form fill-form" data-grant="${esc(b.dataset.revoke)}">
        <div class="field"><label>Why revoke it?</label><input maxlength="500" required minlength="3" placeholder="Kept in the audit log"></div>
        <div class="lms-actions"><button class="btn btn-outline q-small" type="submit">Revoke</button></div></form>`);
      b.closest(".task-row").nextElementSibling.querySelector("input").focus();
    };
    panel.addEventListener("submit", async (e) => {
      const f = e.target.closest(".revoke-form");
      if (!f) return;
      e.preventDefault();
      const reason = f.querySelector("input").value.trim();
      if (reason.length < 3) return;
      try {
        await apiSend("POST", `/users/${u.id}/grants/${f.dataset.grant}/revoke`, { reason });
        toast("Permission revoked", "", "success");
        onChanged();
        draw();
      } catch (err) { toast("Couldn't revoke it", friendlyError(err), "error"); }
    });
  }
  draw();
}
