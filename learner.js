import "./nav.js";
import { $, $$, esc, initials, formatDuration, groupByType, groupByFolder, skeleton, emptyState, errorState, friendlyError, toast } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { LEARNER_CONTENT, SUBJECT_ICON_PATHS, normalizeLibraryAudience, CONTENT_TYPES } from "./data.js";
import {
  getLibrary, getLibraryFolders, libraryFilesHtml, getAssignments, markAssignmentDone, getMyLibraryUsage,
} from "./store.js";

const CIRCUMFERENCE = 2 * Math.PI * 34;
const HOME_TEASER_LIMIT = 3; // keep the digest scannable — the sidebar is where the full list lives

async function main() {
  const user = await requireRole("learner");
  if (!user) return;
  const seed = LEARNER_CONTENT[user.id] || { classes: [], assignments: [] };

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `Learner · ${user.grade || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  $("#topSub").textContent = `${user.school || "No school set"} · ${user.grade || "—"}`;

  /* ------------------------------------------------------------ classes
     (Home shows the first few; My Learning shows all of them.) */
  const classesHtml = (classes) => classes.length
    ? classes.map((c) => `
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
  $("#classGrid").innerHTML = classesHtml(seed.classes);
  $("#homeClasses").innerHTML = classesHtml(seed.classes.slice(0, HOME_TEASER_LIMIT));

  /* ------------------------------------------------------------ assignments
     Live in the real database (learning_portal.assignments) — a fresh
     learner account has none until a teacher assigns some (there's no
     "create assignment" UI yet, so a signed-up account stays at 0/0,
     honestly, rather than borrowed demo content). One state, rendered
     into both the full Assignments page and the Home teaser, so marking
     something done anywhere updates everywhere. */
  let assignmentsFailed = false;
  async function loadAssignments() {
    try {
      const data = await getAssignments();
      assignmentsFailed = false;
      return data;
    } catch (err) {
      assignmentsFailed = true;
      console.error("could not load assignments:", err);
      return [];
    }
  }
  async function markDone(id) {
    try {
      await markAssignmentDone(id);
    } catch (err) {
      console.error("could not save assignment:", err);
      toast("Couldn't save that", friendlyError(err, "Check your connection and try again."), "error");
    }
  }

  function assignmentRow(a) {
    return `
      <div class="task-row ${a.done ? "done" : "due"}">
        <span class="task-dot"></span>
        <div><b>${esc(a.title)}</b><span>${esc(a.subject)} · due ${esc(a.due)}</span></div>
        ${a.done
          ? `<span class="pill ok">Done</span>`
          : `<button class="mark-done" type="button" data-done-id="${esc(a.id)}">Mark done</button>`}
      </div>`;
  }

  function wireMarkDone(onMarkDone) {
    $$("[data-done-id]").forEach((btn) =>
      btn.addEventListener("click", () => onMarkDone(btn.dataset.doneId))
    );
  }

  function renderAssignments(assignments, onMarkDone, onRetry) {
    if (assignmentsFailed) {
      const msg = errorState("Check your connection and try again.", onRetry);
      $("#assignmentList").innerHTML = msg;
      $("#homeAssignments").innerHTML = msg;
      return;
    }

    $("#assignmentList").innerHTML = assignments.length
      ? assignments.map(assignmentRow).join("")
      : emptyState("No assignments yet", "Your teacher hasn't assigned anything here.");

    const outstanding = assignments.filter((a) => !a.done);
    $("#homeAssignments").innerHTML = outstanding.length
      ? outstanding.slice(0, HOME_TEASER_LIMIT).map(assignmentRow).join("")
      : assignments.length
      ? `<div class="empty-state">Nothing outstanding — nice work! 🎉</div>`
      : emptyState("No assignments yet", "Your teacher hasn't assigned anything here.");

    wireMarkDone(onMarkDone);
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
      : assignmentsFailed
      ? "Couldn't load your assignments — check your connection."
      : "Your teacher hasn't set any assignments yet.";

    const pct = total ? Math.round(fraction * 100) : 0;
    const statsHtml = `
      <div class="stat-tile"><div class="s-label">Completed</div><div class="s-num">${done}</div><div class="s-sub">of ${total} assignments</div></div>
      <div class="stat-tile"><div class="s-label">Outstanding</div><div class="s-num">${outstanding.length}</div><div class="s-sub">still to do</div></div>
      <div class="stat-tile"><div class="s-label">Completion</div><div class="s-num">${pct}%</div><div class="s-sub">this week</div></div>
    `;
    $("#progressStats").innerHTML = statsHtml; // full My Progress page
    $("#homeProgressStats").innerHTML = statsHtml; // Home teaser — same real numbers, just closer to hand
  }

  /* ------------------------------------------------------------ library + activity + "Continue learning"
     One shared fetch of the library and of "my usage" feeds three
     things: the full Resources shelf, the full Activity log, and the
     Home page's "Continue learning" card — which resumes whatever was
     opened most recently and never finished, the single most useful
     thing Home can point at. Falls back to the next outstanding
     assignment, then to a plain "you're caught up" state — never a
     guess, only what's actually true. */
  let libraryFailed = false;
  async function loadLibrary() {
    try {
      const data = await getLibrary();
      libraryFailed = false;
      return data;
    } catch (err) {
      libraryFailed = true;
      console.error("could not load library:", err);
      return [];
    }
  }
  // Organizational folders (the education team's own groupings) — best
  // effort: nothing here is critical enough to show its own error state,
  // a failed fetch just means everything renders ungrouped this time.
  async function loadFolders() {
    try {
      return await getLibraryFolders();
    } catch (err) {
      console.error("could not load library folders:", err);
      return [];
    }
  }
  let usageFailed = false;
  async function loadUsage() {
    try {
      const data = await getMyLibraryUsage();
      usageFailed = false;
      return data;
    } catch (err) {
      usageFailed = true;
      console.error("could not load usage:", err);
      return null;
    }
  }

  function renderResources(library, folders, onRetry) {
    if (libraryFailed) {
      const msg = errorState("Check your connection and try again.", onRetry);
      $("#libraryStrip").innerHTML = msg;
      $("#homeResources").innerHTML = msg;
      return;
    }
    const forLearners = library.filter((l) => normalizeLibraryAudience(l.audience) === "library");
    const card = (l) => `
        <div class="lib-item">
          <span class="li-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${SUBJECT_ICON_PATHS[l.subject] || ""}</svg></span>
          <b>${esc(l.title)}</b><span>${esc(l.subject)}</span>
          ${libraryFilesHtml(l)}
        </div>`;
    const byType = (items) => groupByType(items, CONTENT_TYPES).map(({ type, items: t }) => `
        <div class="list-group">
          <div class="list-group-title">${esc(type)}<span class="count">${t.length}</span></div>
          <div class="lib-strip">${t.map(card).join("")}</div>
        </div>`).join("");

    // Organizational folders (the education team's own groupings) come
    // first; each folder's items still sub-group by type underneath.
    $("#libraryStrip").innerHTML = forLearners.length
      ? groupByFolder(forLearners, folders).map(({ name, items }) => `
        <div class="folder-group">
          <div class="folder-group-title">${esc(name)}<span class="count">${items.length}</span></div>
          ${byType(items)}
        </div>`).join("")
      : `<div class="empty-state">Nothing in the library yet.</div>`;

    $("#homeResources").innerHTML = forLearners.length
      ? `<div class="lib-strip">${forLearners.slice(0, HOME_TEASER_LIMIT).map(card).join("")}</div>`
      : `<div class="empty-state">Nothing in the library yet.</div>`;
  }

  function renderActivity(usage, onRetry) {
    const el = $("#usageSummary");
    if (usageFailed) {
      const msg = errorState("Check your connection and try again.", onRetry);
      el.innerHTML = msg;
      $("#homeActivity").innerHTML = msg;
      return;
    }
    if (!usage) {
      const msg = emptyState("Nothing to show yet", "Open something from the library to start tracking your activity here.");
      el.innerHTML = msg;
      $("#homeActivity").innerHTML = msg;
      return;
    }
    if (!usage.interactions.length) {
      const msg = `<div class="empty-state">Open something from the library to start tracking your activity here.</div>`;
      el.innerHTML = msg;
      $("#homeActivity").innerHTML = msg;
      return;
    }
    const row = (it) => `
      <div class="task-row">
        <div style="flex:1"><b>${esc(it.title || "Resource")}</b><span>Started ${new Date(it.startedAt).toLocaleString()}${
          it.completedAt ? " · Finished " + new Date(it.completedAt).toLocaleString() : " · In progress"}</span></div>
        <span class="bar-num">${it.durationSeconds != null ? formatDuration(it.durationSeconds) : "—"}</span>
      </div>`;
    const badgeChips = (usage.badges || []).slice(0, 6).map((b) => `
      <span class="pill" style="display:inline-flex;align-items:center;gap:.3rem;margin:0 .3rem .3rem 0">&#127942; ${esc(b.title || "Resource")}</span>`).join("");

    el.innerHTML = `
      <div class="chart-stats" style="grid-template-columns:repeat(3,1fr)">
        <div><b>${formatDuration(usage.totalSeconds)}</b><span>Time spent</span></div>
        <div><b>${usage.resourcesOpened}</b><span>Resources opened</span></div>
        <div><b>${usage.badgesEarned || 0}</b><span>Badges earned</span></div>
      </div>
      ${badgeChips ? `<div style="margin:.7rem 0 .1rem">${badgeChips}</div>` : ""}
      ${usage.interactions.slice(0, 10).map(row).join("")}
    `;
    // Home teaser: just the recent rows — the stats/badges above already
    // live on "Learning progress" and the full Activity page, no need
    // to repeat them a third time.
    $("#homeActivity").innerHTML = usage.interactions.slice(0, HOME_TEASER_LIMIT).map(row).join("");
  }

  function renderContinueCard({ library, usage, assignments }) {
    const card = $("#continueCard");
    const inProgress = usage?.interactions.find((it) => !it.completedAt);
    const inProgressItem = inProgress ? library.find((l) => l.id === inProgress.libraryItemId) : null;

    if (inProgressItem) {
      card.innerHTML = `
        <p class="continue-eyebrow">Continue learning</p>
        <h2>${esc(inProgressItem.title)}</h2>
        <p>${esc(inProgressItem.subject || "")}${inProgressItem.subject ? " · " : ""}you started this earlier — pick up where you left off.</p>
        ${libraryFilesHtml(inProgressItem)}
      `;
      return;
    }

    const nextAssignment = assignments.find((a) => !a.done);
    if (nextAssignment) {
      card.innerHTML = `
        <p class="continue-eyebrow">Continue learning</p>
        <h2>${esc(nextAssignment.title)}</h2>
        <p>${esc(nextAssignment.subject)} · due ${esc(nextAssignment.due)}</p>
        <a class="btn btn-primary" href="#assignments">Start</a>
      `;
      return;
    }

    card.innerHTML = `
      <p class="continue-eyebrow">Continue learning</p>
      <h2>You're all caught up! 🎉</h2>
      <p>No assignments waiting on you right now — browse the library for something new.</p>
      <a class="btn btn-primary" href="#resources">Browse resources</a>
    `;
  }

  /* ------------------------------------------------------------ boot
     Assignments, library and usage all feed more than one section (and
     the Continue card needs all three), so they're fetched once, kept
     in memory, and every render function reads from the same copy —
     marking an assignment done, for instance, re-renders the full list,
     the Home teaser, the progress ring/stats and the Continue card
     together, never leaving one of them stale. */
  $("#assignmentList").innerHTML = skeleton(3);
  $("#homeAssignments").innerHTML = skeleton(2, { avatar: false });
  $("#libraryStrip").innerHTML = skeleton(3, { avatar: false });
  $("#homeResources").innerHTML = skeleton(2, { avatar: false });
  $("#usageSummary").innerHTML = skeleton(3);
  $("#homeActivity").innerHTML = skeleton(2);
  $("#continueCard").innerHTML = `<p class="continue-eyebrow">Continue learning</p><h2>Loading…</h2>`;

  let assignments = [];
  let library = [];
  let libraryFolders = [];
  let usage = null;

  async function retryAssignments() { assignments = await loadAssignments(); renderAll(); }
  async function retryLibrary() { [library, libraryFolders] = await Promise.all([loadLibrary(), loadFolders()]); renderAll(); }
  async function retryUsage() { usage = await loadUsage(); renderAll(); }

  function renderAll() {
    renderProgress(assignments);
    renderAssignments(assignments, async (id) => {
      await markDone(id);
      assignments = assignments.map((a) => (a.id === id ? { ...a, done: true } : a));
      renderAll();
    }, retryAssignments);
    renderResources(library, libraryFolders, retryLibrary);
    renderActivity(usage, retryUsage);
    renderContinueCard({ library, usage, assignments });
  }

  [assignments, [library, libraryFolders], usage] = await Promise.all([
    loadAssignments(), Promise.all([loadLibrary(), loadFolders()]), loadUsage(),
  ]);
  renderAll();
}
main();

async function doSignOut() {
  await signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
