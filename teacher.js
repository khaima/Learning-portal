import { $, esc, initials } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { TEACHER_CONTENT } from "./data.js";

const ICON = {
  classes: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  grade: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  score: '<path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M9 13l2 2 4-4"/>',
  attendance: '<path d="M12 20V10M18 20V4M6 20v-6"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;

const user = requireRole("teacher");
if (user) {
  const content = TEACHER_CONTENT[user.id] || {
    stats: { classes: 0, learners: 0, toGrade: 0, avgScore: 0, attendance: 0 },
    classes: [], tasks: [], results: [], library: [],
  };

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `Teacher · ${user.county || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  $("#topSub").textContent = `${user.school || "No school set"} · Term 2, 2026`;

  const { stats } = content;
  $("#statRow").innerHTML = `
    <div class="stat-tile"><div class="s-label">${svg(ICON.classes)}Classes</div><div class="s-num">${stats.classes}</div><div class="s-sub">${stats.learners} learners total</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.grade)}To grade</div><div class="s-num">${stats.toGrade}</div><div class="s-sub">this week</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.score)}Avg. score</div><div class="s-num">${stats.avgScore}%</div><div class="s-sub">this term</div></div>
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
    : `<div class="empty-state">No classes yet. A real build would let you create one here.</div>`;

  $("#taskList").innerHTML = content.tasks.length
    ? content.tasks.map((t) => `
      <div class="task-row ${t.state}"><span class="task-dot"></span><div><b>${esc(t.title)}</b><span>${esc(t.detail)}</span></div></div>`).join("")
    : `<div class="empty-state">Nothing due this week.</div>`;

  $("#resultList").innerHTML = content.results.length
    ? content.results.map((r) => `
      <div class="result-row"><span>${esc(r.label)}</span><span class="score ${r.kind}">${r.score}%</span></div>`).join("")
    : `<div class="empty-state">No results recorded yet.</div>`;

  $("#libraryList").innerHTML = content.library.length
    ? content.library.map((l) => `
      <div class="task-row"><div><b>${esc(l.title)}</b><span>${esc(l.subject)}</span></div></div>`).join("")
    : `<div class="empty-state">Nothing saved from the library yet.</div>`;
}

function doSignOut() {
  signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
