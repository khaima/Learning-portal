/* The console's administration and oversight pages (platform / admin / me /
   education workspaces): Platform overview, Administration overview,
   Permissions, Account activity, Schools (the list and each school's page —
   a field officer's My schools too), Teachers, Classes, School profiles,
   Assignments, Results, Field visits, Subjects — and one account's access
   (role, data scope, grants, history) opened from Staff accounts.

   Each page shows what the API returns for this person — already limited to
   their permissions and data scope on the server. Buttons appear only for
   what they may do, and the API checks every one again. */
import { esc, skeleton, errorState, friendlyError, toast, confirmDialog } from "./util.js";
import { apiGet, apiSend } from "./api.js";
import { openContentPanel, closeViewer } from "./viewer.js";
import { resultsTableHtml } from "./assignments-ui.js";
import { extendTrail } from "./nav.js";
import { ICON } from "./navigation.js";

const fmtDay = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtWhen = (v) => (v ? new Date(v).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const ago = (v) => {
  if (!v) return "Never";
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 30 ? `${days} days ago` : fmtDay(v);
};
const tile = (label, num, sub = "", link = "") => `<${link ? `a href="${esc(link)}" class="stat-tile stat-link"` : 'div class="stat-tile"'}>
  <div class="s-label">${esc(label)}</div><div class="s-num">${esc(String(num ?? "—"))}</div>${sub ? `<div class="s-sub">${esc(sub)}</div>` : ""}</${link ? "a" : "div"}>`;
const table = (head, rows, empty = "Nothing to show.") => rows.length
  ? `<div class="lms-table-wrap"><table class="lms-table intel-table"><thead><tr>${head.map((h, i) => `<th${i === 0 ? ' class="lms-name"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="lms-name"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
  : `<div class="empty-state">${esc(empty)}</div>`;
const STATUS_TEXT = { active: "Active", pending: "Waiting for approval", suspended: "Suspended", deactivated: "Deactivated", rejected: "Not approved" };
const statusPill = (s) => s === "active" ? `<span class="pill ok">Active</span>`
  : `<span class="pill ${s === "pending" ? "warm" : "danger"}">${esc(STATUS_TEXT[s] || s)}</span>`;

async function load(el, path, render, retry) {
  el.innerHTML = skeleton(3, { avatar: false });
  try {
    const d = await apiGet(path);
    el.innerHTML = render(d);
    return d;
  } catch (err) {
    el.innerHTML = errorState(navigator.onLine ? friendlyError(err) : "This page needs a connection.", retry);
    return null;
  }
}

/* ------------------------------------------------------------------ Platform overview (Super Admin)
   Is the platform healthy, in use, and is anything waiting on someone?
   Everything here comes from existing API replies: /platform/overview
   first (the page draws as soon as it arrives), then — filling in their
   own spaces as they come — the data-quality score history, the audit log
   (activity per day, recent changes), sign-in recency, and Kobo's counted
   submissions. Nothing is estimated: a figure that can't be read says so. */
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

function activityChart(series) {
  const max = Math.max(1, ...series.map((s) => s.n));
  const w = 100 / series.length;
  const fmt = (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const bars = series.map((s, i) => {
    const hgt = s.n ? Math.max(4, (s.n / max) * 100) : 0;
    return `<rect x="${(i * w + w * 0.16).toFixed(2)}" y="${(100 - hgt).toFixed(2)}" width="${(w * 0.68).toFixed(2)}" height="${hgt.toFixed(2)}" rx="1.2"
      class="${i >= series.length - 7 ? "pov-bar now" : "pov-bar"}"><title>${esc(fmt(s.day))}: ${plural(s.n, "change")}</title></rect>`;
  }).join("");
  return `<svg class="pov-bars" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
      aria-label="Changes per day, ${esc(fmt(series[0].day))} to today: ${esc(series.map((s) => s.n).join(", "))}">
    <line x1="0" y1="100" x2="100" y2="100" class="pov-axis"/>${bars}</svg>
    <div class="pov-bars-axis"><span>${esc(fmt(series[0].day))}</span><span>Today</span></div>`;
}

/** How recently each active staff member last signed in. */
const RECENCY = [
  ["Last 24 hours", (ms) => ms != null && ms <= DAY, "pov-r1"],
  ["2–7 days ago", (ms) => ms != null && ms > DAY && ms <= 7 * DAY, "pov-r2"],
  ["8–30 days ago", (ms) => ms != null && ms > 7 * DAY && ms <= 30 * DAY, "pov-r3"],
  ["Over 30 days", (ms) => ms != null && ms > 30 * DAY, "pov-r4"],
  ["Never signed in", (ms) => ms == null, "pov-r5"],
];
function recencyBlock(act) {
  const staff = (act.staff || []).filter((s) => s.status === "active");
  const now = Date.now();
  const groups = RECENCY.map(([label, test, cls]) => ({ label, cls,
    n: staff.filter((s) => test(s.lastSignInAt ? now - new Date(s.lastSignInAt).getTime() : null)).length }));
  const L = act.learners || {};
  return `
    <div class="pov-stack" role="img" aria-label="${esc(`Active staff by last sign-in: ${groups.map((g) => `${g.label} ${g.n}`).join(", ")}`)}">
      ${groups.filter((g) => g.n).map((g) => `<span class="${g.cls}" style="flex:${g.n}" title="${esc(`${g.label}: ${g.n}`)}"></span>`).join("") || `<span class="pov-r5" style="flex:1"></span>`}
    </div>
    <ul class="pov-legend">${groups.map((g) => `<li><i class="${g.cls}" aria-hidden="true"></i>${esc(g.label)} <b>${num(g.n)}</b></li>`).join("")}</ul>
    <p class="pov-note">Learners: <b>${num(L.signedIn7d)}</b> of ${plural(L.enrolled, "enrolled learner")} signed in this week${L.lockedNow ? ` · <b>${num(L.lockedNow)}</b> locked out now` : ""}.</p>`;
}

/** A key figure: label and icon, the number, then (each optional) the
    change since last time, a line of context, and a small chart. */
function kpi({ id, name, label, value, unit = "", trend = "", sub = "", viz = "", href = "", warn = false }) {
  const tag = href ? `a href="${esc(href)}"` : "div";
  return `<${tag} class="pov-kpi${warn ? " warn" : ""}"${id ? ` id="${id}"` : ""}>
    <div class="pov-kpi-top"><span class="pov-kpi-label">${esc(label)}</span><span class="pov-kpi-icon">${icon(name)}</span></div>
    <div class="pov-kpi-value"><span data-part="value">${value}${unit ? `<span class="pov-kpi-unit">${esc(unit)}</span>` : ""}</span><span class="pov-kpi-trend" data-part="trend">${trend}</span></div>
    <div class="pov-kpi-sub" data-part="sub">${sub}</div>
    <div class="pov-kpi-viz" data-part="viz">${viz}</div>
  </${href ? "a" : "div"}>`;
}
const pending = (label) => `<span class="skeleton-block pov-skel" aria-hidden="true"></span><span class="sr-only">${esc(label)} loading</span>`;

/** Checks that need someone, then the ones that pass (folded away). */
function attentionPanel(checks) {
  const failing = checks.filter((x) => !x.ok);
  const passing = checks.filter((x) => x.ok);
  return `
    <div class="pov-panel-head"><h3 id="pov-attention-title" tabindex="-1">Needs attention</h3>
      ${failing.length ? `<span class="pov-count warn">${failing.length}</span>` : ""}</div>
    ${failing.length ? `<p class="pov-note pov-lead">Health checks that aren't met yet:</p>` : ""}
    ${failing.length ? `<ul class="pov-alerts">${failing.map((x) => `
      <li class="pov-alert"><span class="pov-alert-icon" aria-hidden="true">${icon("alert")}</span>
        <div class="pov-alert-text"><b>${esc(x.label)}</b><span>${esc(x.detail)}</span></div>
        ${x.link ? `<a class="btn btn-outline pov-alert-go" href="${esc(x.link)}">Open<span class="sr-only">: ${esc(x.label)}</span></a>` : ""}
      </li>`).join("")}</ul>`
      : `<div class="pov-allgood">${icon("check")}<div><b>Nothing needs attention.</b><span>All ${checks.length} checks pass.</span></div></div>`}
    ${passing.length && failing.length ? `<details class="pov-passing"><summary>${icon("check")} ${plural(passing.length, "check")} passing</summary>
      <ul>${passing.map((x) => `<li><b>${esc(x.label)}</b><span>${esc(x.detail)}</span></li>`).join("")}</ul></details>` : ""}`;
}

function recentList(entries, describe, securityIds) {
  if (!entries.length) return `<div class="empty-state">Nothing recorded yet.</div>`;
  const key = entries.some((e) => securityIds.has(e.id))
    ? `<p class="pov-note"><i class="pov-key-security" aria-hidden="true"></i>Orange: a change to who can sign in or what they can reach.</p>` : "";
  return `<ol class="pov-feed">${entries.map((e) => {
    const said = describe ? describe(e) : { what: e.action, detail: "" };
    const who = e.actorName || (e.actorKind === "system" ? "System" : "Someone");
    const target = e.targetName && e.targetId !== e.actorId ? ` — ${e.targetName}` : "";
    return `<li class="pov-feed-item${securityIds.has(e.id) ? " security" : ""}">
      <span class="pov-feed-dot" aria-hidden="true"></span>
      <div class="pov-feed-text"><span><b>${esc(who)}</b> ${esc(said.what)}${esc(target)}</span>
        ${said.detail ? `<span class="pov-feed-detail">${esc(said.detail)}</span>` : ""}</div>
      <time datetime="${esc(e.at)}" title="${esc(fmtWhen(e.at))}">${esc(since(e.at))}</time>
    </li>`;
  }).join("")}</ol>${key}`;
}

export function renderPlatformOverview(el, { describe } = {}) {
  const draw = async () => {
    const gen = (el.povGen = (el.povGen || 0) + 1);
    const current = () => el.povGen === gen;
    el.innerHTML = skeleton(3, { avatar: false });
    let d;
    try {
      d = await apiGet("/platform/overview");
    } catch (err) {
      if (current()) el.innerHTML = errorState(navigator.onLine ? friendlyError(err) : "This page needs a connection.", draw);
      return;
    }
    if (!current()) return;
    const a = d.accounts, k = d.integrations.kobo, n = d.integrations.notifications;
    const failing = d.checks.filter((x) => !x.ok).length;
    const passing = d.checks.length - failing;
    const updated = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const roles = d.accounts.byRole;
    el.innerHTML = `
    <div class="pov">
      <header class="pov-head">
        <div>
          <h2 class="pov-title">Platform overview</h2>
          <p class="pov-status ${failing ? "warn" : "ok"}">
            <span class="pov-status-dot" aria-hidden="true"></span>
            ${failing ? `<button type="button" class="pov-status-link" data-pov-jump><b>${plural(failing, "check needs", "checks need")} attention</b></button>`
              : `<b>All systems normal</b>`}
            <span class="pov-status-more">· ${plural(passing, "check")} passing</span>
          </p>
        </div>
        <div class="pov-head-side">
          <span class="pov-meta">${d.platform ? `API ${esc(String(d.platform.release).slice(0, 7))} · ${esc(d.platform.environment)} · ` : ""}Updated ${esc(updated)}</span>
          <button type="button" class="btn btn-outline pov-refresh" data-pov-refresh>${icon("sync")}<span>Refresh</span></button>
        </div>
      </header>

      <section class="pov-kpis" aria-label="Key figures">
        ${kpi({ name: "users", label: "Staff accounts", value: num(a.active), href: "#users", warn: a.pending > 0,
          sub: a.pending ? `<b class="pov-warn-text">${plural(a.pending, "account")} waiting for approval</b>` : `Active · ${num(a.total)} accounts in all` })}
        ${kpi({ name: "activity", label: "Active this week", value: num(a.signedIn7d), href: "#account-activity",
          sub: `${pct(a.signedIn7d, a.active)}% of active staff${a.neverSignedIn ? ` · ${num(a.neverSignedIn)} never signed in` : ""}`,
          viz: meter(a.signedIn7d, a.active, `${a.signedIn7d} of ${a.active} active staff signed in this week`) })}
        ${kpi({ id: "pov-k-learners", name: "cap", label: "Learners enrolled", value: num(d.learners.enrolled), href: "admin.html#learners", warn: d.learners.lockedNow > 0,
          sub: d.learners.lockedNow ? `<b class="pov-warn-text">${num(d.learners.lockedNow)} locked out right now</b>` : "None locked out" })}
        ${kpi({ name: "school", label: "Schools", value: num(d.organisation.schools), href: "#schools", sub: `In ${plural(d.organisation.counties, "county", "counties")}` })}
        ${kpi({ id: "pov-k-dq", name: "data-quality", label: "Data quality", value: d.dataQuality.score == null ? "—" : num(d.dataQuality.score), unit: d.dataQuality.score == null ? "" : "%", href: "#data-quality",
          warn: d.dataQuality.high > 0,
          sub: d.dataQuality.high ? `<b class="pov-warn-text">${plural(d.dataQuality.high, "high-severity issue")} open</b>` : `${plural(d.dataQuality.open, "open issue")}` })}
        ${kpi({ id: "pov-k-kobo", name: "kobo", label: "Field data counted", value: k.connected ? pending("Field data") : "—", href: "#kobo",
          sub: k.connected ? "" : "KoboToolbox isn't connected" })}
      </section>

      <div class="pov-grid">
        <section class="pov-panel pov-activity" aria-labelledby="pov-activity-title">
          <div class="pov-panel-head"><h3 id="pov-activity-title">Platform activity</h3><a href="#audit">Audit log</a></div>
          <div data-slot="activity">${pending("Activity")}</div>
          <h4 class="pov-subhead">Who's signing in</h4>
          <div data-slot="recency">${pending("Sign-ins")}</div>
        </section>
        <section class="pov-panel pov-attention" aria-labelledby="pov-attention-title">${attentionPanel(d.checks)}</section>
      </div>

      <div class="pov-grid">
        <section class="pov-panel" aria-labelledby="pov-recent-title">
          <div class="pov-panel-head"><h3 id="pov-recent-title">Recent activity</h3>
            <span class="pov-head-links"><a href="#audit?kind=security">Security events</a><a href="#audit">All</a></span></div>
          <div data-slot="recent">${pending("Recent activity")}</div>
        </section>
        <section class="pov-panel pov-quiet" aria-labelledby="pov-systems-title">
          <div class="pov-panel-head"><h3 id="pov-systems-title">Integrations</h3><a href="#kobo">KoboToolbox</a></div>
          <dl class="pov-facts">
            <div><dt>${icon("kobo")}KoboToolbox</dt><dd>${k.connected
              ? `Connected to ${esc(String(k.server || "").replace(/^https?:\/\//, ""))} · ${plural(k.surveys, "survey")} · synced ${esc(since(k.lastSync))}`
              : "Not connected"}${k.failing.length ? `<br><b class="pov-warn-text">${plural(k.failing.length, "survey")} failing to sync</b>` : ""}</dd></div>
            <div><dt>${icon("plug")}Live push from Kobo</dt><dd>${k.pushConfigured ? "Set up" : "Not set up"}</dd></div>
            <div><dt>${icon("bell")}Hourly notifications</dt><dd>${n ? `Ran ${esc(since(n.lastRunAt))} · ${plural(n.created, "notification")} created${n.error ? ` · <b class="pov-warn-text">failed</b>` : ""}` : "Never run"}</dd></div>
            <div><dt>${icon("sync")}Field devices</dt><dd>${plural(d.devices.reporting, "device")} reporting${d.devices.needAttention ? ` · <b class="pov-warn-text">${num(d.devices.needAttention)} need attention</b>` : " · all fine"}</dd></div>
            <div><dt>${icon("shield")}Access exceptions</dt><dd>${plural(d.access.grants, "extra permission")} granted · ${plural(d.access.scopedStaff, "person", "people")} with a narrowed scope · <a href="#permissions">Permissions</a></dd></div>
          </dl>
        </section>
      </div>

      <section class="pov-support" aria-labelledby="pov-roles-title">
        <div class="pov-panel-head"><h3 id="pov-roles-title">Accounts by role</h3><a href="#users">Users &amp; roles</a></div>
        <div class="lms-table-wrap" tabindex="0" role="region" aria-labelledby="pov-roles-title">
          <table class="lms-table pov-roles"><thead><tr><th class="lms-name">Role</th><th>Active</th><th>Waiting</th><th>Suspended</th><th>Deactivated</th><th>Not approved</th></tr></thead>
          <tbody>${roles.map((r) => `<tr><td class="lms-name">${esc(r.label)}</td>${[r.active, r.pending, r.suspended, r.deactivated, r.rejected]
            .map((v) => `<td class="${v ? "" : "pov-zero"}">${num(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>
        </div>
        ${d.access.fieldOfficersWithoutSchools.length ? `
          <h4 class="pov-subhead">Field officers without assigned schools</h4>
          <p class="pov-note">They can't file visits until they're given a county or schools — open them on <a href="#users">Users &amp; roles</a>, then <b>View</b>.</p>
          <ul class="pov-plain">${d.access.fieldOfficersWithoutSchools.map((p) => `<li><b>${esc(p.name)}</b> · profile county: ${esc(p.county || "none")}</li>`).join("")}</ul>` : ""}
      </section>
    </div>`;

    const slot = (name) => el.querySelector(`[data-slot="${name}"]`);
    const fill = (name, html) => { const s = current() && slot(name); if (s) s.innerHTML = html; };
    const part = (card, name) => (current() && el.querySelector(`#${card} [data-part="${name}"]`)) || null;
    const retryLink = `<button type="button" class="intel-link" data-pov-refresh>Try again</button>`;

    // The rest fills in as it arrives; one slow or failed reply doesn't hold up the others.
    apiGet("/data-quality/summary").then((s) => {
      const hist = (s.history || []).filter((h) => h.score != null);
      const viz = part("pov-k-dq", "viz");
      if (viz) viz.innerHTML = scoreSpark(hist);
      const trend = part("pov-k-dq", "trend");
      if (trend && hist.length >= 2) {
        trend.innerHTML = delta(hist.at(-1).score - hist.at(-2).score, { unit: " pts" });
        part("pov-k-dq", "sub")?.insertAdjacentHTML("afterbegin", "vs the last scan · ");
      }
    }).catch(() => {});

    apiGet("/audit?limit=200").then((res) => {
      const entries = (res.entries || []).slice().sort((x, y) => String(y.at).localeCompare(String(x.at)));
      const series = perDay(entries, 14);
      const thisWeek = series.slice(7).reduce((t, s) => t + s.n, 0);
      const lastWeek = series.slice(0, 7).reduce((t, s) => t + s.n, 0);
      // 200 entries may not reach back 14 days on a busy platform: then the oldest days are incomplete.
      const partial = res.nextBefore && entries.length && Date.now() - new Date(entries.at(-1).at).getTime() < 14 * DAY;
      fill("activity", `
        <div class="pov-activity-sum"><span class="pov-big">${num(thisWeek)}</span>
          <span>${thisWeek === 1 ? "change" : "changes"} recorded in the last 7 days ${partial ? "" : delta(thisWeek - lastWeek, { what: "on the week before" })}</span></div>
        ${activityChart(series)}
        <ul class="pov-legend"><li><i class="pov-key-now" aria-hidden="true"></i>Last 7 days</li><li><i class="pov-key-before" aria-hidden="true"></i>The week before</li></ul>
        <p class="pov-note">Accounts, access, exports, Kobo and other changes, from the audit log${partial ? " (only the latest 200 — earlier days are incomplete)" : ""}.</p>`);
      const securityIds = new Set((d.recentSecurity || []).map((e) => e.id));
      fill("recent", recentList(entries.slice(0, 7), describe, securityIds));
    }).catch(() => {
      fill("activity", `<p class="pov-note">The activity history couldn't be read just now. ${retryLink}</p>`);
      fill("recent", recentList(d.recentSecurity || [], describe, new Set((d.recentSecurity || []).map((e) => e.id))));
    });

    apiGet("/security/activity").then((act) => {
      fill("recency", recencyBlock(act));
      const L = act.learners || {};
      const sub = part("pov-k-learners", "sub");
      if (sub && L.enrolled != null) {
        sub.insertAdjacentHTML("afterbegin", `${num(L.signedIn7d)} signed in this week · `);
        part("pov-k-learners", "viz").innerHTML = meter(L.signedIn7d, L.enrolled, `${L.signedIn7d} of ${L.enrolled} enrolled learners signed in this week`);
      }
    }).catch(() => fill("recency", `<p class="pov-note">Sign-ins couldn't be read just now. ${retryLink}</p>`));

    if (k.connected) {
      apiGet("/kobo/forms").then((res) => {
        const live = (res.forms || []).filter((f) => f.active !== false);
        const got = live.reduce((t, f) => t + (f.pipeline?.received ?? 0), 0);
        const counted = live.reduce((t, f) => t + (f.pipeline?.counted ?? 0), 0);
        const review = live.reduce((t, f) => t + (f.pipeline?.needsReview ?? 0), 0);
        const value = part("pov-k-kobo", "value");
        if (!value) return;
        value.innerHTML = `${num(counted)}<span class="pov-kpi-unit">of ${num(got)}</span>`;
        part("pov-k-kobo", "sub").innerHTML = review
          ? `<b class="pov-warn-text">${plural(review, "submission")} ${review === 1 ? "needs" : "need"} review</b>` : "Nothing waiting for review";
        part("pov-k-kobo", "viz").innerHTML = meter(counted, got, `${counted} of ${got} Kobo submissions counted on the dashboards`);
        if (review) el.querySelector("#pov-k-kobo").classList.add("warn");
      }).catch(() => {
        const value = part("pov-k-kobo", "value");
        if (value) { value.textContent = "—"; part("pov-k-kobo", "sub").textContent = "Couldn't be read just now."; }
      });
    }
  };
  // One handler for the element, whichever draw is current.
  el.povDraw = draw;
  if (!el.povBound) {
    el.povBound = true;
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-pov-refresh]")) el.povDraw();
      else if (e.target.closest("[data-pov-jump]")) {
        const h = el.querySelector("#pov-attention-title");
        h?.scrollIntoView({ behavior: "smooth", block: "start" });
        h?.focus({ preventScroll: true });
      }
    });
  }
  return draw();
}

/* ------------------------------------------------------------------ Administration overview */
export function renderAdminOverview(el) {
  return load(el, "/admin/overview", (d) => {
    const o = d.organisation, p = d.people, ops = d.operations;
    const attention = [
      p.pending && [`${p.pending} account(s) waiting for approval`, "#users?status=pending"],
      o.fieldOfficersWithoutSchools && [`${o.fieldOfficersWithoutSchools} field officer(s) without assigned schools`, "#users?role=field_officer"],
      o.schoolsWithoutHead && [`${o.schoolsWithoutHead} school(s) without a school head`, "#school-profiles"],
      o.teachersWithoutClasses && [`${o.teachersWithoutClasses} teacher(s) not teaching any class`, "#teachers"],
      p.learnersWithoutClass && [`${p.learnersWithoutClass} learner(s) not in a class`, "#learners"],
      ops.koboNeedsReview && [`${ops.koboNeedsReview} Kobo submission(s) need review`, "#kobo"],
      ops.dataQualityHigh && [`${ops.dataQualityHigh} high-severity data issue(s)`, "#data-quality"],
    ].filter(Boolean);
    return `
      <div class="panel-head" style="margin-bottom:.6rem"><h2 style="margin:0">Administration overview</h2>
        <span class="chart-meta" style="margin:0">${esc(d.scope.label)}${d.currentTerm ? ` · ${esc(String(d.currentTerm).replace(/^(\d{4})-T(\d)$/, "$1 Term $2"))}` : ""}</span></div>
      <div class="stat-row">
        ${tile("Schools", o.schools, `${o.counties} counties · ${o.classes} classes this year`, "#schools")}
        ${tile("Teachers", p.teachers, `${p.heads} school heads`, "#teachers")}
        ${tile("Learners", p.learners, p.learnersWithoutClass ? `${p.learnersWithoutClass} not in a class` : "All in a class", "#learners")}
        ${tile("Field officers", p.fieldOfficers, `${o.fieldOfficersWithoutSchools} without schools`, "#users?role=field_officer")}
        ${tile("Field visits this term", ops.visitsThisTerm, "", "#field-visits")}
        ${tile("Open forms", ops.openForms, "", "#forms")}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Needs attention</h2></div>
        ${attention.length ? attention.map(([t, link]) => `<div class="task-row"><div style="flex:1"><b>${esc(t)}</b></div>
          <div class="roster-actions"><a class="intel-link" href="${esc(link)}">Open</a></div></div>`).join("")
          : `<div class="empty-state">Nothing needs attention right now.</div>`}
      </div>`;
  }, () => renderAdminOverview(el));
}

/* ------------------------------------------------------------------ Permissions (Super Admin) */
export function renderPermissions(el, { onRevoke } = {}) {
  const draw = () => load(el, "/permissions", (d) => {
    const roles = d.roles;
    return `
      <div class="panel">
        <div class="panel-head"><h2>Permissions by role</h2></div>
        <p class="hint" style="margin-top:0">What each role may do — the same table the API enforces on every request. A Super Admin can grant one person one extra permission from <a href="#users">Users &amp; roles</a> → <b>View</b>; those are listed below.</p>
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
    <div class="panel-head" style="margin-bottom:.6rem"><h2 style="margin:0">Account activity</h2></div>
    <div class="stat-row">
      ${tile("Learners enrolled", d.learners.enrolled)}
      ${tile("Learners signed in this week", d.learners.signedIn7d)}
      ${tile("Learners locked out now", d.learners.lockedNow, `${d.learners.withFailedAttempts} with failed PIN attempts`)}
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
export async function renderTeachers(el, { q = "", role = "" } = {}, { fresh = false } = {}) {
  if (!teachersCache || fresh) {
    el.innerHTML = skeleton(4);
    try { teachersCache = await apiGet("/teachers"); } catch (err) {
      el.innerHTML = errorState(friendlyError(err), () => renderTeachers(el, { q, role }, { fresh: true }));
      return;
    }
  }
  const needle = q.trim().toLowerCase();
  const list = teachersCache.teachers.filter((t) => (!role || t.role === role) &&
    (!needle || [t.name, t.school, t.county, t.code].some((v) => String(v || "").toLowerCase().includes(needle))));
  const meta = document.getElementById("tchMeta");
  if (meta) meta.textContent = `${list.length} · ${teachersCache.scope}`;
  el.innerHTML = table(["Name", "Role", "School", "County", "Type", "Classes taught", "Trainings"], list.map((t) => [
    `<b>${esc(t.name)}</b>${t.code ? `<br><span class="code-chip">${esc(t.code)}</span>` : ""}`, esc(t.roleLabel), esc(t.school), esc(t.county),
    esc(t.teacherType || "—"), esc(t.classes.join(", ") || "—"), t.trainings,
  ]), "No teachers in your area yet.");
}

/* ------------------------------------------------------------------ Classes (read-only structure) */
export function renderClasses(el, schoolId) {
  if (!schoolId) { el.innerHTML = `<div class="empty-state">Choose a school.</div>`; return null; }
  return load(el, `/classes?schoolId=${encodeURIComponent(schoolId)}`, (d) => table(
    ["Class", "Grade", "Teachers", "Learners"],
    d.classes.map((k) => [`<b>${esc(k.name)}</b>`, esc(k.grade), esc(k.teachers.map((t) => t.name).filter(Boolean).join(", ") || "None yet"), k.learnerCount]),
    `No classes for ${d.academicYear || "this year"} in this school yet.`,
  ), () => renderClasses(el, schoolId));
}

/* ------------------------------------------------------------------ School profiles */
export function renderSchoolProfile(el, schoolId) {
  if (!schoolId) { el.innerHTML = `<div class="empty-state">Choose a school.</div>`; return null; }
  return load(el, `/schools/${encodeURIComponent(schoolId)}/profile`, schoolProfileHtml, () => renderSchoolProfile(el, schoolId));
}
export function schoolProfileHtml(d, { heading = true } = {}) {
  return `
    ${heading ? `<div class="panel-head" style="margin-bottom:.4rem"><h2 style="margin:0">${esc(d.school.name)}</h2>
      <span class="chart-meta" style="margin:0"><span class="code-chip">${esc(d.school.code)}</span> · ${esc(d.school.county)} County</span></div>` : ""}
    <div class="stat-row">
      ${tile("School head", d.heads.join(", ") || "None yet")}
      ${tile("Teachers", d.teachers)}
      ${tile("Learners", d.learners, `${d.classes.length} classes this year`)}
      ${tile("Field visits", d.visits.total, d.visits.last ? `Last ${fmtDay(d.visits.last)}` : "None yet")}
      ${tile("Kobo submissions", d.kobo.submissions, `${d.kobo.counted} counted`)}
    </div>
    <div class="body-grid">
      <div>
        <h3 class="mini-head">Classes this year</h3>
        ${table(["Class", "Grade", "Learners"], d.classes.map((k) => [esc(k.name), esc(k.grade), k.learners]), "No classes yet.")}
        <h3 class="mini-head">Learners by grade</h3>
        ${table(["Grade", "Learners"], d.learnersByGrade.map((g) => [esc(g.grade), g.learners]), "No learners yet.")}
      </div>
      <div>
        <h3 class="mini-head">Recent visits</h3>
        ${table(["Date", "Type", "Officer"], d.visits.recent.map((v) => [esc(fmtDay(v.date)), esc(v.type), esc(v.officer || "—")]), "No visits yet.")}
        <p class="hint">${d.supportedBy.length ? `Supported by ${esc(d.supportedBy.join(", "))}.` : "No field officer is assigned to this school yet."}</p>
      </div>
    </div>`;
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

/** The list, or one school. `actions(school)` adds buttons to a school's row and page (e.g. Start visit). */
export async function renderSchoolsModule(el, { params = new URLSearchParams(), perms = new Set(), base = "#school-profiles", actions = () => "", fresh = false } = {}) {
  if (!schoolDirectory || fresh) {
    el.innerHTML = skeleton(4, { avatar: false });
    try { schoolDirectory = await apiGet("/schools"); } catch (err) {
      el.innerHTML = errorState(navigator.onLine ? friendlyError(err) : "This page needs a connection.", () => renderSchoolsModule(el, { params, perms, base, actions, fresh: true }));
      return;
    }
  }
  const schools = schoolDirectory.schools || [];
  const id = params.get("school");
  if (!id) { schoolListHtml(el, schools, { base, actions }); return; }
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
      <a class="back-link" href="${esc(base)}">← All schools</a>
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
      await load(body, `/schools/${sid}/profile`, (d) => schoolProfileHtml(d, { heading: false }), () => renderSchoolsModule(el, { params, perms, base, actions }));
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

function schoolListHtml(el, schools, { base, actions }) {
  const counties = [...new Set(schools.map((s) => s.county))];
  el.innerHTML = `
    <div class="filter-bar-row" style="margin-bottom:.8rem"><div class="field"><label for="schoolFind">Find a school</label>
      <input id="schoolFind" type="search" placeholder="Name, code or county…" autocomplete="off"></div></div>
    <p class="hint" data-count style="margin-top:0"></p>
    <div data-list></div>`;
  const draw = () => {
    const q = el.querySelector("#schoolFind").value.trim().toLowerCase();
    const shown = schools.filter((s) => !q || [s.name, s.code, s.county].some((v) => String(v || "").toLowerCase().includes(q)));
    el.querySelector("[data-count]").textContent = `${shown.length} of ${schools.length} school${schools.length === 1 ? "" : "s"}`;
    el.querySelector("[data-list]").innerHTML = shown.length ? counties.map((c) => {
      const list = shown.filter((s) => s.county === c);
      return list.length ? `<div class="list-group"><div class="list-group-title">${esc(c)}<span class="count">${list.length}</span></div>
        ${list.map((s) => `<div class="task-row"><div style="flex:1;min-width:0"><a class="school-link" href="${esc(`${base}?school=${encodeURIComponent(s.id)}`)}"><b>${esc(s.name)}</b></a>
          <span><span class="code-chip">${esc(s.code)}</span></span></div>
          <div class="roster-actions">${actions(s)}<a class="btn btn-ghost q-small" href="${esc(`${base}?school=${encodeURIComponent(s.id)}`)}">Open</a></div></div>`).join("")}</div>` : "";
    }).join("") : `<div class="empty-state">${schools.length ? "No school matches that." : "No schools in your area yet."}</div>`;
  };
  el.querySelector("#schoolFind").addEventListener("input", draw);
  draw();
}

/* ------------------------------------------------------------------ Assignments (read-only, across schools) */
export function renderAssignments(el, { schoolId = "", status = "" } = {}, schoolName = new Map()) {
  const qs = new URLSearchParams(Object.entries({ schoolId, status }).filter(([, v]) => v)).toString();
  return load(el, `/assignments${qs ? `?${qs}` : ""}`, (d) => {
    const list = d.assignments.filter((a) => a.status !== "draft");
    const meta = document.getElementById("asgMeta");
    if (meta) meta.textContent = `${list.length} assignment${list.length === 1 ? "" : "s"}`;
    return table(["Assignment", "School / class", "Subject", "Set by", "Due", "Status", "Handed in", "Marked"], list.map((a) => [
      `<b>${esc(a.title)}</b>${a.term ? `<br><span class="hint-inline">${esc(a.term)}</span>` : ""}`,
      `${esc(schoolName.get(a.schoolId) || "")}${a.className ? `<br><span class="hint-inline">${esc(a.className)}</span>` : ""}`,
      esc(a.subject), esc(a.teacherName || "—"), esc(fmtDay(a.dueAt)),
      a.status === "closed" ? `<span class="pill">Closed</span>` : `<span class="pill ok">Open</span>`,
      a.counts ? `${a.counts.submitted} of ${a.counts.expected}` : "—", a.counts ? a.counts.marked : "—",
    ]), "No assignments in your area yet.");
  }, () => renderAssignments(el, { schoolId, status }, schoolName));
}

/* ------------------------------------------------------------------ Results */
export function renderResults(el, { by = "school", schoolId = "" } = {}) {
  const qs = new URLSearchParams(Object.entries({ by, schoolId }).filter(([, v]) => v)).toString();
  return load(el, `/results?${qs}`, (d) => (d.rows?.length ? resultsTableHtml(d) : `<div class="empty-state">No results yet — they appear once work is handed in and marked.</div>`),
    () => renderResults(el, { by, schoolId }));
}

/* ------------------------------------------------------------------ Field visits (everyone's, in scope) */
let visitsCache = null;
export async function renderFieldVisits(el, q = "", { fresh = false } = {}) {
  if (!visitsCache || fresh) {
    el.innerHTML = skeleton(4);
    try { visitsCache = (await apiGet("/field-reports")).reports; } catch (err) {
      el.innerHTML = errorState(friendlyError(err), () => renderFieldVisits(el, q, { fresh: true }));
      return;
    }
  }
  const needle = q.trim().toLowerCase();
  const list = visitsCache.filter((v) => !needle || [v.school, v.county, v.visitType, v.officer].some((x) => String(x || "").toLowerCase().includes(needle)));
  const meta = document.getElementById("fvMeta");
  if (meta) meta.textContent = `${list.length} visit${list.length === 1 ? "" : "s"}`;
  el.innerHTML = table(["Date", "School", "County", "Visit type", "Field officer"], list.map((v) => [
    esc(fmtDay(v.createdAt)), `<b>${esc(v.school)}</b>`, esc(v.county), esc(v.visitType), esc(v.officer || "—"),
  ]), "No field visits in your area yet.");
}

/* ------------------------------------------------------------------ Subjects */
export function renderSubjects(el) {
  return load(el, "/subjects", (d) => `<div class="tag-list">${d.subjects.map((x) => `<span class="pill">${esc(x.name)}</span>`).join(" ")}</div>`,
    () => renderSubjects(el));
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
