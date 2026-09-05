import { $, $$, esc, initials } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { LEARNER_CONTENT, SUBJECT_ICON_PATHS } from "./data.js";
import { getLibrary } from "./store.js";
import { supabase } from "./supabase.js";

const CIRCUMFERENCE = 2 * Math.PI * 34;

const user = requireRole("learner");
if (user) {
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
    const { data, error } = await supabase
      .from("assignments").select("*").eq("learner_id", user.id).order("id");
    if (error) { console.warn("could not load assignments:", error.message); return []; }
    return data.map((a) => ({ id: a.id, title: a.title, subject: a.subject, due: a.due, done: a.done }));
  }
  async function markDone(id) {
    const { error } = await supabase.from("assignments").update({ done: true }).eq("id", id);
    if (error) console.warn("could not save assignment:", error.message);
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
    $("#libraryStrip").innerHTML = library.length
      ? library.map((l) => `
        <div class="lib-item">
          <span class="li-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${SUBJECT_ICON_PATHS[l.subject] || ""}</svg></span>
          <b>${esc(l.title)}</b><span>${esc(l.subject)} · ${esc(l.type)}</span>
        </div>`).join("")
      : `<div class="empty-state">Nothing in the library yet.</div>`;
  });
}

function doSignOut() {
  signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
