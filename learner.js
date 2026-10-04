import { mountNavigation } from "./nav.js";
import { $, $$, esc, initials, schoolLine, formatDuration, skeleton, emptyState, errorState, friendlyError, toast } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { normalizeLibraryAudience } from "./data.js";
import {
  getLibrary, getLibraryFolders, libraryFilesHtml, mountLibraryShelves, libraryPreviewHtml, getMyLibraryUsage,
  getMyAssignments, getResults,
} from "./store.js";
import { openLearnerAssignment, completionPill, markPill, fmtWhen, resultsTableHtml } from "./assignments-ui.js";
import { getMyAssignment } from "./store.js";
import { viewableKind } from "./viewer.js";
import * as sync from "./sync.js";

/* Offline: at every sync, this learner's assignments (and the reading they
   point to, if it's small) are downloaded, so they can be opened, answered
   and handed in without a connection. */
const AUTO_SAVE_LIMIT = 5 * 1024 * 1024;
const OFFLINE_KINDS = ["pdf", "image", "video", "audio", "text"];
sync.registerPrefetch(async () => {
  const list = await getMyAssignments();
  for (const a of list.filter((x) => !x.opensLater).slice(0, 60)) {
    const d = await getMyAssignment(a.id);
    const canWork = d.completion === "not_started" || d.completion === "in_progress";
    for (const f of (canWork && d.resource?.files) || []) {
      if (!OFFLINE_KINDS.includes(viewableKind(f.name)) || !f.viewUrl || (f.size || 0) > AUTO_SAVE_LIMIT || sync.savedFile(d.resource.id, f.name)) continue;
      await sync.saveFile({ itemId: d.resource.id, title: d.resource.title, name: f.name, size: f.size, url: f.viewUrl }).catch(() => {});
    }
  }
  await Promise.all([getLibrary(), getLibraryFolders(), getMyLibraryUsage(), getResults({ by: "subject" })]);
});

const CIRCUMFERENCE = 2 * Math.PI * 34;
const HOME_TEASER_LIMIT = 3; // keep the digest scannable — the sidebar is where the full list lives

async function main() {
  const user = await requireRole("learner");
  if (!user) return;
  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `Learner · ${user.learnerCode || user.userCode || user.grade || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  mountNavigation(user); // the menu (navigation.js)
  const termLabel = user.term ? `${user.academicYear} Term ${String(user.term).replace(/^\d{4}-T/, "")}` : user.academicYear || "";
  $("#topSub").textContent = [schoolLine(user), user.className || user.grade, termLabel].filter(Boolean).join(" · ");

  /* ------------------------------------------------------------ my class
     The class this learner is enrolled in this year, from their school's
     records (school → year → term → class). */
  const classHtml = user.className || user.grade
    ? `
      <div class="learn-card">
        <div class="lc-top">
          <span class="lc-icon" style="background:var(--panel)"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/></svg></span>
          <div><b>${esc(user.className || user.grade)}</b><span class="lc-meta">${esc(user.school || "")}${user.teacherName ? ` · ${esc(user.teacherName)}` : ""}</span></div>
        </div>
        <div class="lc-next">${esc(termLabel)}${user.learnerCode ? ` · Your learner code: <b>${esc(user.learnerCode)}</b>` : ""}</div>
      </div>`
    : `<div class="empty-state">You're not in a class yet — your teacher or school head will add you.</div>`;
  $("#classGrid").innerHTML = classHtml;
  $("#homeClasses").innerHTML = classHtml;

  /* ------------------------------------------------------------ assignments
     Work set for this learner's class. Open one to start it, save answers
     along the way, then hand it in. Two separate things are shown:
     how much work is handed in (completion) and the marks on work the
     teacher has marked (achievement) — never one number for both. */
  let assignmentsFailed = false;
  async function loadAssignments() {
    try {
      const data = await getMyAssignments();
      assignmentsFailed = false;
      return data;
    } catch (err) {
      assignmentsFailed = true;
      console.error("could not load assignments:", err);
      return [];
    }
  }

  function assignmentRow(a) {
    const s = a.submission;
    const handedIn = a.completion === "submitted" || a.completion === "marked";
    const action = a.opensLater ? "" : a.canWork ? (a.completion === "in_progress" ? "Continue" : "Start") : "View";
    return `
      <div class="task-row ${handedIn ? "done" : "due"}">
        <span class="task-dot"></span>
        <div style="flex:1;min-width:0"><b>${esc(a.title)}</b><span>${esc(a.subject)}${a.dueAt ? ` · due ${esc(fmtWhen(a.dueAt))}` : ""}${
          a.opensLater ? ` · opens ${esc(fmtWhen(a.startsAt))}` : ""}${a.estimatedMinutes ? ` · about ${a.estimatedMinutes} min` : ""}</span></div>
        <span>${completionPill(a.completion, { late: s?.isLate, overdue: a.overdue })} ${a.completion === "marked" ? markPill(s.percentage, s.band) : ""}${
          a.pendingSync || sync.waiting(`asg:${a.id}`) ? ' <span class="pill">Waiting to sync</span>' : ""}</span>
        ${action ? `<button class="mark-done" type="button" data-open-asg="${esc(a.id)}">${action}</button>` : ""}
      </div>`;
  }

  function renderAssignments(list, onRetry) {
    if (assignmentsFailed) {
      const msg = errorState("Check your connection and try again.", onRetry);
      $("#assignmentList").innerHTML = msg;
      $("#homeAssignments").innerHTML = msg;
      return;
    }
    $("#assignmentList").innerHTML = list.length
      ? list.map(assignmentRow).join("")
      : emptyState("No assignments yet", "Your teacher hasn't set anything for your class.");
    const toDo = list.filter((a) => a.canWork);
    $("#homeAssignments").innerHTML = toDo.length
      ? toDo.slice(0, HOME_TEASER_LIMIT).map(assignmentRow).join("")
      : list.length
      ? `<div class="empty-state">Nothing to do right now — nice work! 🎉</div>`
      : emptyState("No assignments yet", "Your teacher hasn't set anything for your class.");
  }

  /* Completion only: how much of the work set is handed in. */
  function renderProgress(list) {
    const set = list.filter((a) => !a.opensLater);
    const handedIn = set.filter((a) => a.completion === "submitted" || a.completion === "marked").length;
    const total = set.length;
    const fraction = total ? handedIn / total : 0;
    const toDo = set.filter((a) => a.canWork);
    const overdue = set.filter((a) => a.overdue).length;
    $("#progressText").textContent = `${handedIn}/${total}`;
    $("#progressArc").setAttribute("stroke-dasharray", String(CIRCUMFERENCE));
    $("#progressArc").setAttribute("stroke-dashoffset", String(CIRCUMFERENCE * (1 - fraction)));
    $("#progressHeading").textContent = total ? `${handedIn} of ${total} assignments handed in` : "No assignments yet";
    $("#progressSub").textContent = toDo.length
      ? `${toDo.length} to do, starting with "${toDo[0].title}" (${toDo[0].subject})${toDo[0].dueAt ? `, due ${fmtWhen(toDo[0].dueAt)}` : ""}.`
      : total
      ? "Everything's handed in — nice work."
      : assignmentsFailed
      ? "Couldn't load your assignments — check your connection."
      : "Your teacher hasn't set any assignments yet.";
    const statsHtml = `
      <div class="stat-tile"><div class="s-label">Handed in</div><div class="s-num">${handedIn}</div><div class="s-sub">of ${total} assignments</div></div>
      <div class="stat-tile"><div class="s-label">To do</div><div class="s-num">${toDo.length}</div><div class="s-sub">still open</div></div>
      <div class="stat-tile"><div class="s-label">Overdue</div><div class="s-num">${overdue}</div><div class="s-sub">past the due date</div></div>
    `;
    $("#progressStats").innerHTML = statsHtml;
    $("#homeProgressStats").innerHTML = statsHtml;
  }

  /* Achievement: marks on marked work, overall and by subject. */
  async function renderMarks() {
    const el = $("#marksSummary");
    el.innerHTML = skeleton(3, { avatar: false });
    let data;
    try { data = await getResults({ by: "subject" }); } catch (err) {
      el.innerHTML = errorState(friendlyError(err), renderMarks);
      return;
    }
    const ach = data.overall?.achievement;
    const marked = assignments.filter((a) => a.completion === "marked")
      .sort((x, y) => String(y.submission?.markedAt).localeCompare(String(x.submission?.markedAt)));
    if (!ach?.marked) {
      el.innerHTML = `<div class="empty-state">No marked work yet. Your marks appear here once your teacher marks something you handed in.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="chart-stats" style="grid-template-columns:repeat(3,1fr)">
        <div><b>${Math.round(ach.averagePercent)}%</b><span>Average mark</span></div>
        <div><b>${esc(ach.band || "—")}</b><span>${esc((data.bands || []).find((b) => b.code === ach.band)?.label || "Band")}</span></div>
        <div><b>${ach.marked}</b><span>Marked</span></div>
      </div>
      <h3 style="margin:1rem 0 .4rem">By subject</h3>
      ${resultsTableHtml(data)}
      <h3 style="margin:1rem 0 .4rem">Marked work</h3>
      ${marked.map((a) => `
        <div class="task-row">
          <div style="flex:1;min-width:0"><b>${esc(a.title)}</b><span>${esc(a.subject)}${a.submission?.feedback ? ` · “${esc(a.submission.feedback)}”` : ""}</span></div>
          ${markPill(a.submission.percentage, a.submission.band)}
          <button class="mark-done" type="button" data-open-asg="${esc(a.id)}">View</button>
        </div>`).join("")}`;
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
    // Same shelf layout as every other dashboard — see "library shelves" in store.js.
    mountLibraryShelves([
      { el: $("#libraryStrip"), countEl: $("#libraryCount"), items: forLearners, emptyMsg: "Nothing in the library yet." },
    ], folders, $("#shelfSearch"));
    $("#homeResources").innerHTML = libraryPreviewHtml(forLearners, {
      emptyMsg: "Nothing in the library yet.", limit: HOME_TEASER_LIMIT,
    });
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

    const nextAssignment = assignments.find((a) => a.canWork && a.completion === "in_progress") || assignments.find((a) => a.canWork);
    if (nextAssignment) {
      card.innerHTML = `
        <p class="continue-eyebrow">Continue learning</p>
        <h2>${esc(nextAssignment.title)}</h2>
        <p>${esc(nextAssignment.subject)}${nextAssignment.dueAt ? ` · due ${esc(fmtWhen(nextAssignment.dueAt))}` : ""}</p>
        <button class="btn btn-primary" type="button" data-open-asg="${esc(nextAssignment.id)}">${nextAssignment.completion === "in_progress" ? "Continue" : "Start"}</button>
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
    renderAssignments(assignments, retryAssignments);
    renderResources(library, libraryFolders, retryLibrary);
    renderActivity(usage, retryUsage);
    renderContinueCard({ library, usage, assignments });
  }

  // Open an assignment from anywhere on the page; refresh everything after.
  async function refreshAssignments() {
    assignments = await loadAssignments();
    renderAll();
    renderMarks();
  }
  document.querySelector(".app-main").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-asg]");
    if (btn) openLearnerAssignment(btn.dataset.openAsg, { onChange: refreshAssignments });
  });

  // When queued work lands (or is settled), show the server's version.
  let lastWaiting = sync.status().items.length;
  sync.onChange((st) => {
    if (st.items.length < lastWaiting) refreshAssignments();
    lastWaiting = st.items.length;
  });

  [assignments, [library, libraryFolders], usage] = await Promise.all([
    loadAssignments(), Promise.all([loadLibrary(), loadFolders()]), loadUsage(),
  ]);
  renderAll();
  renderMarks();
}
main();

async function doSignOut() {
  if ((await signOut()) === false) return;
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
