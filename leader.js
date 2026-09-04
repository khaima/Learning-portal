import { $, esc, initials } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { LEADER_CONTENT } from "./data.js";

const ICON = {
  learners: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  teachers: '<path d="M4 19V6a2 2 0 0 1 2-2h13v14H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h13"/><path d="M9 8h7M9 11h7"/>',
  classes: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  attendance: '<path d="M12 20V10M18 20V4M6 20v-6"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;
const RETURN_PILL = { ok: "pill ok", due: "pill warm", upcoming: "pill" };
const RETURN_LABEL = { ok: "Filed", due: "Due soon", upcoming: "Upcoming" };

const user = requireRole("school_leader");
if (user) {
  const content = LEADER_CONTENT[user.id] || {
    stats: { learners: 0, teachers: 0, classes: 0, attendance: 0 },
    classes: [], returns: [], visits: [],
  };

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `School Leader · ${user.county || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  $("#topSub").textContent = `${user.school || "No school set"} · Term 2, 2026`;

  const { stats } = content;
  $("#statRow").innerHTML = `
    <div class="stat-tile"><div class="s-label">${svg(ICON.learners)}Learners</div><div class="s-num">${stats.learners}</div><div class="s-sub">enrolled</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.teachers)}Teachers</div><div class="s-num">${stats.teachers}</div><div class="s-sub">on staff</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.classes)}Classes</div><div class="s-num">${stats.classes}</div><div class="s-sub">running this term</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.attendance)}Attendance</div><div class="s-num">${stats.attendance}%</div><div class="s-sub">avg. this week</div></div>
  `;

  $("#classList").innerHTML = content.classes.length
    ? content.classes.map((c) => `
      <div class="class-row">
        <div class="class-swatch" style="background:${c.swatch}">${esc(c.code)}</div>
        <div class="class-info"><b>${esc(c.name)}</b><span>${c.learners} learners</span>
          <div class="class-bar"><i style="width:${c.coverage}%"></i></div></div>
        <div class="class-meta"><b>${c.coverage}%</b>coverage</div>
      </div>`).join("")
    : `<div class="empty-state">No classes recorded yet.</div>`;

  $("#returnList").innerHTML = content.returns.length
    ? content.returns.map((r) => `
      <div class="task-row"><div style="flex:1"><b>${esc(r.term)}</b><span>${esc(r.detail)}</span></div>
        <span class="${RETURN_PILL[r.state] || "pill"}">${RETURN_LABEL[r.state] || r.state}</span></div>`).join("")
    : `<div class="empty-state">No returns on record yet.</div>`;

  $("#visitList").innerHTML = content.visits.length
    ? content.visits.map((v) => `
      <div class="task-row"><div><b>${esc(v.label)}</b><span>${esc(v.detail)}</span></div></div>`).join("")
    : `<div class="empty-state">No field visits recorded yet.</div>`;
}

function doSignOut() {
  signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
