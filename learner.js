import "./nav.js";
import { $, $$, esc, initials, formatDuration, groupByType } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { LEARNER_CONTENT, SUBJECT_ICON_PATHS, normalizeLibraryAudience, CONTENT_TYPES } from "./data.js";
import {
  getLibrary, libraryFilesHtml, getAssignments, markAssignmentDone, getMyLibraryUsage,
} from "./store.js";

const CIRCUMFERENCE = 2 * Math.PI * 34;

async function main() {
  const user = await requireRole("learner");
  if (!user) return;
  const seed = LEARNER_CONTENT[user.id] || { classes: [], assignments: [] };

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `Learner · ${user.grade || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  $("#topSub").textContent = `${user.school || "No school set"} · ${user.grade || "—"}`;

  /* Assignments live in the real database now (learning_portal.assignments)
     — a fresh learner account has none until a teacher assigns some (there
     is no "create assignment" UI yet, so a signed-up account stays at
     0/0, honestly, rather than borrowed demo content). */
  async function loadAssignments() {
    try {
      return await getAssignments();
    } catch (err) {
      console.warn("could not load assignments:", err.message);
      return [];
    }
  }
  async function markDone(id) {
    try {
      await markAssignmentDone(id);
    } catch (err) {
      console.warn("could not save assignment:", err.message);
    }
  }

  function renderProgress(assignments) {
    const done = assignments.filter((a) => a.done).length;
    const total = assignments.length;
    const fraction = total ? done / total : 0;
    $("#progressText").textContent = `${done}/${total}`;
    $("#progressArc").setAttribute("stroke-dasharray", String(CIRCUMFERENCE));
    $("#progressArc").setAttribute("stroke-dashoffset", String(CIRCUMFERENCE * (1 - fraction)));
    const outstanding = assignments.filter((a) => !a.done);
    $("#progressHeading").textContent = total
      ? `${done} of ${total} assignments done this week`
      : "No assignments yet";
    $("#progressSub").textContent = outstanding.length
      ? `${outstanding.length} left, starting with "${outstanding[0].title}" (${outstanding[0].subject}), due ${outstanding[0].due}.`
      : total
      ? "Everything's done — nice work."
      : "Your teacher hasn't set any assignments yet.";

    // "My Progress" page — same numbers as the Home ring, just at a
    // glance in stat-tile form for whoever navigates there specifically.
    const pct = total ? Math.round(fraction * 100) : 0;
    $("#progressStats").innerHTML = `
      <div class="stat-tile"><div class="s-label">Completed</div><div class="s-num">${done}</div><div class="s-sub">of ${total} assignments</div></div>
      <div class="stat-tile"><div class="s-label">Outstanding</div><div class="s-num">${outstanding.length}</div><div class="s-sub">still to do</div></div>
      <div class="stat-tile"><div class="s-label">Completion</div><div class="s-num">${pct}%</div><div class="s-sub">this week</div></div>
    `;
  }

  function renderAssignments(assignments, onMarkDone) {
    $("#assignmentList").innerHTML = assignments.length
      ? assignments.map((a) => `
        <div class="task-row ${a.done ? "done" : "due"}">
          <span class="task-dot"></span>
          <div><b>${esc(a.title)}</b><span>${esc(a.subject)} · due ${esc(a.due)}</span></div>
          ${a.done ? "" : `<button class="mark-done" type="button" data-done-id="${esc(a.id)}">Mark done</button>`}
        </div>`).join("")
      : `<div class="empty-state">No assignments yet.</div>`;
    $$("[data-done-id]").forEach((btn) =>
      btn.addEventListener("click", () => onMarkDone(btn.dataset.doneId))
    );
  }

  async function boot() {
    $("#assignmentList").innerHTML = `<div class="empty-state">Loading…</div>`;
    let assignments = await loadAssignments();

    function renderAll() {
      renderProgress(assignments);
      renderAssignments(assignments, async (id) => {
        await markDone(id);
        assignments = assignments.map((a) => (a.id === id ? { ...a, done: true } : a));
        renderAll();
      });
    }
    renderAll();
  }
  boot();

  $("#classGrid").innerHTML = seed.classes.length
    ? seed.classes.map((c) => `
      <div class="learn-card">
        <div class="lc-top">
          <span class="lc-icon" style="background:${c.swatch}"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${SUBJECT_ICON_PATHS[c.subject] || ""}</svg></span>
          <div><b>${esc(c.subject)}</b><span class="lc-meta">${esc(user.grade || "")} · ${esc(c.teacher)}</span></div>
        </div>
        <div class="lc-next">${c.next
          ? `Next: <b>${esc(c.next.label)}</b> · due ${esc(c.next.due)}`
          : c.lastResult
          ? `Last result: <b>${c.lastResult.score}%</b> · ${esc(c.lastResult.label)}`
          : "Nothing scheduled yet"}</div>
      </div>`).join("")
    : `<div class="empty-state">You're not enrolled in any classes yet.</div>`;

  $("#libraryStrip").innerHTML = `<div class="empty-state">Loading…</div>`;
  getLibrary().then((library) => {
    const forLearners = library.filter((l) => normalizeLibraryAudience(l.audience) === "library");
    const card = (l) => `
        <div class="lib-item">
          <span class="li-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${SUBJECT_ICON_PATHS[l.subject] || ""}</svg></span>
          <b>${esc(l.title)}</b><span>${esc(l.subject)}</span>
          ${libraryFilesHtml(l)}
        </div>`;
    $("#libraryStrip").innerHTML = forLearners.length
      ? groupByType(forLearners, CONTENT_TYPES).map(({ type, items }) => `
        <div class="list-group">
          <div class="list-group-title">${esc(type)}<span class="count">${items.length}</span></div>
          <div class="lib-strip">${items.map(card).join("")}</div>
        </div>`).join("")
      : `<div class="empty-state">Nothing in the library yet.</div>`;
  });

  /* My learning activity — every "Open to read" click above is timed
     from open to return; see nav.js. */
  renderUsageSummary();
  async function renderUsageSummary() {
    const el = $("#usageSummary");
    el.innerHTML = `<div class="empty-state">Loading…</div>`;
    let u;
    try { u = await getMyLibraryUsage(); } catch {
      el.innerHTML = `<div class="empty-state is-error">Couldn't load your activity.</div>`;
      return;
    }
    if (!u.interactions.length) {
      el.innerHTML = `<div class="empty-state">Open something from the library to start tracking your activity here.</div>`;
      return;
    }
    const rows = u.interactions.slice(0, 10).map((it) => `
      <div class="task-row">
        <div style="flex:1"><b>${esc(it.title || "Resource")}</b><span>Started ${new Date(it.startedAt).toLocaleString()}${
          it.completedAt ? " · Finished " + new Date(it.completedAt).toLocaleString() : " · In progress"}</span></div>
        <span class="bar-num">${it.durationSeconds != null ? formatDuration(it.durationSeconds) : "—"}</span>
      </div>`).join("");
    const badgeChips = (u.badges || []).slice(0, 6).map((b) => `
      <span class="pill" style="display:inline-flex;align-items:center;gap:.3rem;margin:0 .3rem .3rem 0">&#127942; ${esc(b.title || "Resource")}</span>`).join("");
    el.innerHTML = `
      <div class="chart-stats" style="grid-template-columns:repeat(3,1fr)">
        <div><b>${formatDuration(u.totalSeconds)}</b><span>Time spent</span></div>
        <div><b>${u.resourcesOpened}</b><span>Resources opened</span></div>
        <div><b>${u.badgesEarned || 0}</b><span>Badges earned</span></div>
      </div>
      ${badgeChips ? `<div style="margin:.7rem 0 .1rem">${badgeChips}</div>` : ""}
      ${rows}
    `;
  }
}
main();

async function doSignOut() {
  await signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
