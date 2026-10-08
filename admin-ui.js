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

/* ------------------------------------------------------------------ Platform overview (Super Admin) */
export function renderPlatformOverview(el) {
  return load(el, "/platform/overview", (d) => {
    const k = d.integrations.kobo;
    const n = d.integrations.notifications;
    return `
      <div class="panel-head" style="margin-bottom:.6rem"><h2 style="margin:0">Platform overview</h2>
        <span class="chart-meta" style="margin:0">Is the platform secure, healthy and correctly configured?</span></div>
      <div class="stat-row">
        ${tile("Staff accounts", d.accounts.active, `${d.accounts.pending} waiting for approval`, "#users")}
        ${tile("Signed in this week", d.accounts.signedIn7d, `${d.accounts.neverSignedIn} active accounts have never signed in`, "#account-activity")}
        ${tile("Learners enrolled", d.learners.enrolled, d.learners.lockedNow ? `${d.learners.lockedNow} locked out right now` : "None locked out", "admin.html#learners")}
        ${tile("Schools", d.organisation.schools, `${d.organisation.counties} counties`, "#schools")}
        ${tile("Data quality", d.dataQuality.score == null ? "—" : `${d.dataQuality.score}%`, `${d.dataQuality.high} high-severity issues open`, "#data-quality")}
        ${tile("Access exceptions", d.access.grants, `explicit grants · ${d.access.scopedStaff} staff with a narrowed scope`, "#permissions")}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Health checks</h2>${d.platform ? `<span class="chart-meta" style="margin:0">API release ${esc(d.platform.release)} · ${esc(d.platform.environment)}</span>` : ""}</div>
        <div class="checks">${d.checks.map((x) => `
          <div class="check-row ${x.ok ? "ok" : "warn"}"><span class="check-mark" aria-hidden="true">${x.ok ? "✓" : "!"}</span>
            <div><b>${esc(x.label)}</b><span>${esc(x.detail)}</span></div>
            ${!x.ok && x.link ? `<a class="intel-link" href="${esc(x.link)}">Open</a>` : ""}</div>`).join("")}</div>
      </div>
      <div class="body-grid">
        <div class="panel">
          <div class="panel-head"><h2>Integrations</h2><a href="#kobo">KoboToolbox</a></div>
          <dl class="profile-facts">
            <div><dt>KoboToolbox</dt><dd>${k.connected ? `Connected to ${esc(String(k.server || "").replace(/^https?:\/\//, ""))} · ${k.surveys} survey(s) · last sync ${esc(fmtWhen(k.lastSync))}` : "Not connected"}</dd></div>
            <div><dt>Live push from Kobo</dt><dd>${k.pushConfigured ? "Set up" : "Not set up"}</dd></div>
            ${k.failing.map((f) => `<div><dt>Failing</dt><dd>${esc(f.title)} — ${esc(f.error || "")}</dd></div>`).join("")}
            <div><dt>Hourly notifications</dt><dd>${n ? `Last run ${esc(fmtWhen(n.lastRunAt))} (${esc(n.trigger)}) · ${n.created} created${n.error ? " · failed" : ""}` : "Never run"}</dd></div>
            <div><dt>Field devices</dt><dd>${d.devices.reporting} reporting · ${d.devices.needAttention} need attention</dd></div>
          </dl>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Recent security events</h2><a href="#audit?kind=security">All</a></div>
          ${d.recentSecurity.length ? d.recentSecurity.map((e) => `<div class="result-row" style="align-items:flex-start">
            <span><b>${esc(e.actorName || "System")}</b> ${esc(e.action)}${e.targetName ? ` — ${esc(e.targetName)}` : ""}</span>
            <span class="hint-inline" style="white-space:nowrap">${esc(fmtWhen(e.at))}</span></div>`).join("") : `<div class="empty-state">Nothing yet.</div>`}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Accounts by role</h2></div>
        ${table(["Role", "Active", "Waiting", "Suspended", "Deactivated", "Not approved"],
          d.accounts.byRole.map((r) => [esc(r.label), r.active, r.pending, r.suspended, r.deactivated, r.rejected]))}
      </div>
      ${d.access.fieldOfficersWithoutSchools.length ? `<div class="panel">
        <div class="panel-head"><h2>Field officers without assigned schools</h2></div>
        <p class="hint" style="margin-top:0">They can't file visits until they're given a county or schools — open them on Users &amp; roles, then <b>View</b>.</p>
        ${d.access.fieldOfficersWithoutSchools.map((p) => `<div class="task-row"><div style="flex:1"><b>${esc(p.name)}</b><span>Profile county: ${esc(p.county || "none")}</span></div></div>`).join("")}
      </div>` : ""}`;
  }, () => renderPlatformOverview(el));
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
