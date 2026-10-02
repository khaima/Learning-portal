import "./nav.js";
import { $, $$, esc, initials, schoolLine, toast, formatDuration, skeleton, emptyState, errorState, friendlyError, confirmDialog } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { normalizeLibraryAudience } from "./data.js";
import {
  getLibrary, getLibraryFolders, getForms, getResponses, mountLibraryShelves, libraryPreviewHtml,
  getLearners, addLearner, updateLearner, getMyLibraryUsage, getLearnerActivity,
  getClasses, setLearnerStatus, getSubjects, getStaffAssignments, getSubmissions, getResults,
  addLearnersToClass, removeLearnerFromClass,
} from "./store.js";
import { statusPill, openArchiveDialog, openHistoryPanel } from "./learners-ui.js";
import {
  openAssignmentEditor, openAssignmentDetail, openMarking, resultsTableHtml,
  assignmentStatusPill, completionPill, markPill, fmtWhen,
} from "./assignments-ui.js";
import { openContentPanel } from "./viewer.js";
import { mountFormList } from "./forms.js";

const ICON = {
  classes: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  grade: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  score: '<path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M9 13l2 2 4-4"/>',
  attendance: '<path d="M12 20V10M18 20V4M6 20v-6"/>',
  learners: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="M17 3.13a4 4 0 0 1 0 7.75"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;

async function main() {
  const user = await requireRole("teacher");
  if (!user) return;

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `Teacher · ${user.userCode || user.county || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  $("#topSub").textContent = schoolLine(user);

  /* ------------------------------------------------------------ KPI row
     Real counts only, from the same data as the lists below: work waiting
     to be marked, and work handed in this week (completion — not marks). */
  function renderKpis() {
    const toMark = submissionCache.filter((x) => x.status === "submitted").length;
    const handedInThisWeek = submissionCache.filter((x) => x.submittedAt && isThisWeek(x.submittedAt)).length;
    const resourcesUsed = usageCache ? usageCache.resourcesOpened : 0;
    $("#statRow").innerHTML = `
      <div class="stat-tile"><div class="s-label">${svg(ICON.learners)}My learners</div><div class="s-num">${activeCount}</div><div class="s-sub">active, across your classes</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.grade)}Work to mark</div><div class="s-num">${toMark}</div><div class="s-sub">handed in, waiting for you</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.score)}Handed in this week</div><div class="s-num">${handedInThisWeek}</div><div class="s-sub">submissions</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.library)}Resources used</div><div class="s-num">${resourcesUsed}</div><div class="s-sub">by you, all time</div></div>
    `;
  }

  /* ------------------------------------------------------------ my classes
     The classes a school head (or administrator) has assigned this teacher
     to in the current academic year. */
  let myClasses = [];
  let classTerms = [];
  // Declared up here: renderKpis() runs before the sections below set them.
  let submissionCache = [];
  let submissionsFailed = false;
  let assignmentList = [];
  let learnerCache = [];
  let activeCount = 0; // active learners, shown in the KPI tile whichever list is open
  let usageCache = null;

  async function renderClasses() {
    $("#classList").innerHTML = skeleton(2, { avatar: false });
    let res;
    try {
      res = await getClasses();
    } catch (err) {
      const msg = errorState(friendlyError(err), renderClasses);
      $("#classList").innerHTML = msg;
      $("#homeClassList").innerHTML = msg;
      return;
    }
    myClasses = res.classes;
    classTerms = res.terms || [];
    const today = new Date().toISOString().slice(0, 10);
    const term = classTerms.find((t) => t.startsOn <= today && today <= t.endsOn);
    $("#topSub").textContent = [schoolLine(user), term?.label || res.academicYear].filter(Boolean).join(" · ");
    const html = myClasses.length
      ? myClasses.map((c) => {
          const mine = c.teachers.find((t) => t.teacherId === user.id);
          const subjects = (c.subjects || []).map((x) => x.name).join(", ");
          return `
          <div class="class-row" data-class="${esc(c.id)}" style="flex-wrap:wrap">
            <div class="class-swatch" style="background:var(--panel)">${esc(c.grade.replace("Grade ", "G"))}</div>
            <div class="class-info"><b>${esc(c.name)}</b><span>${c.learnerCount} active learner${c.learnerCount === 1 ? "" : "s"} · ${esc(c.academicYear)}${subjects ? ` · ${esc(subjects)}` : ""}</span></div>
            <div class="class-meta"><b>${mine?.role === "class_teacher" ? "Class teacher" : "Subject teacher"}</b></div>
            <div class="roster-actions">
              <button type="button" data-class-act="learners">Learners</button>
              <button type="button" data-class-act="assign">Set work</button>
            </div>
          </div>`;
        }).join("")
      : emptyState("No classes yet", "Your school head assigns teachers to classes. Learners you add yourself still appear under My Learners.");
    $("#classList").innerHTML = html;
    $("#homeClassList").innerHTML = html;
    const classOpts = myClasses.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.grade)})</option>`).join("");
    $("#nl_class").innerHTML = `<option value="">Not in a class yet</option>${classOpts}`;
    for (const sel of ["#af_class", "#rf_class"]) {
      const keep = $(sel).value;
      $(sel).innerHTML = `<option value="">All my classes</option>${classOpts}`;
      $(sel).value = myClasses.some((c) => c.id === keep) ? keep : "";
    }
    const keepTerm = $("#rf_term").value;
    $("#rf_term").innerHTML = `<option value="">All terms</option>${classTerms.map((t) => `<option value="${esc(t.id)}">${esc(t.label || t.id)}</option>`).join("")}`;
    $("#rf_term").value = classTerms.some((t) => t.id === keepTerm) ? keepTerm : "";
  }
  renderClasses();

  for (const list of ["#classList", "#homeClassList"]) {
    $(list).addEventListener("click", (e) => {
      const btn = e.target.closest("[data-class-act]");
      if (!btn) return;
      const cls = myClasses.find((c) => c.id === btn.closest("[data-class]").dataset.class);
      if (!cls) return;
      if (btn.dataset.classAct === "learners") openClassLearners(cls);
      else newAssignment(cls.id);
    });
  }

  /* A class's learners: take one out, or add learners from this teacher's
     roster (their other classes, or not in a class yet). */
  async function openClassLearners(cls) {
    const panel = openContentPanel({ title: `${cls.name} — learners`, html: skeleton(4) });
    async function load() {
      let inClass, mine;
      try {
        [inClass, mine] = await Promise.all([getLearners({ classId: cls.id }), getLearners({})]);
      } catch (err) {
        panel.innerHTML = errorState(friendlyError(err), load);
        return;
      }
      const others = mine.filter((l) => l.classId !== cls.id);
      panel.innerHTML = `
        <h3 style="margin-top:0">In this class (${inClass.length})</h3>
        ${inClass.length ? inClass.map((l) => `
          <div class="task-row">
            <div style="flex:1;min-width:0"><b>${esc(l.fullName)}</b><span>${l.learnerCode ? `<span class="code-chip">${esc(l.learnerCode)}</span> ` : ""}@${esc(l.username)}</span></div>
            <div class="roster-actions"><button type="button" class="danger" data-remove="${esc(l.id)}" data-name="${esc(l.fullName)}">Take out of class</button></div>
          </div>`).join("") : `<div class="empty-state">Nobody is in this class yet.</div>`}
        <h3 style="margin:1.1rem 0 .3rem">Add learners</h3>
        <p class="field-hint" style="margin-top:0">Learners on your roster who aren't in this class. Your school head can add anyone in the school.</p>
        ${others.length ? `
          <form data-add class="fill-form">
            ${others.map((l) => `<label class="q-choice"><input type="checkbox" value="${esc(l.id)}"> ${esc(l.fullName)} <span class="hint-inline">${l.className ? `now in ${esc(l.className)}` : "not in a class"}</span></label>`).join("")}
            <button class="btn btn-primary" type="submit" style="margin-top:.6rem">Add to ${esc(cls.name)}</button>
          </form>` : `<div class="empty-state">Everyone on your roster is already in this class.</div>`}`;
    }
    panel.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-remove]");
      if (!btn) return;
      if (!(await confirmDialog({ title: `Take ${btn.dataset.name} out of ${cls.name}?`, body: "They stay on your roster, not in any class, until they're placed again. Their work is kept.", confirmLabel: "Take out" }))) return;
      try {
        await removeLearnerFromClass(cls.id, btn.dataset.remove);
        toast("Taken out of the class", "");
        await load();
        renderClasses();
        renderRoster();
      } catch (err) {
        toast("Couldn't do that", friendlyError(err), "error");
      }
    });
    panel.addEventListener("submit", async (e) => {
      if (!e.target.matches("[data-add]")) return;
      e.preventDefault();
      const ids = [...e.target.querySelectorAll("input:checked")].map((i) => i.value);
      if (!ids.length) { toast("Pick learners to add", "", "error"); return; }
      try {
        const res = await addLearnersToClass(cls.id, ids);
        toast("Added", `${res.added} learner${res.added === 1 ? "" : "s"} added to ${cls.name}.`, "success");
        await load();
        renderClasses();
        renderRoster();
      } catch (err) {
        toast("Couldn't add them", friendlyError(err), "error");
      }
    });
    load();
  }

  /* ------------------------------------------------------------ assignments
     The teacher's assignments (built here, for the classes they teach),
     work handed in and waiting to be marked, and what was marked lately.
     Home shows the marking queue and recent marks from the same data. */
  function isThisWeek(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return false;
    const now = new Date();
    const day = (now.getDay() + 6) % 7; // Monday = 0
    const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - day);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    return d >= start && d < end;
  }

  function queueRow(x) {
    return `
      <div class="task-row">
        <span class="task-dot"></span>
        <div style="flex:1;min-width:0"><b>${esc(x.learnerName || "Learner")}</b><span>${esc(x.assignmentTitle)} · ${esc(x.subject)}${x.className ? ` · ${esc(x.className)}` : ""} · handed in ${esc(fmtWhen(x.submittedAt))}${x.isLate ? ' <span class="pill warm">Late</span>' : ""}</span></div>
        <button type="button" class="pill warm" style="border:0;cursor:pointer" data-open-sub="${esc(x.id)}">Mark</button>
      </div>`;
  }
  function markedRow(x) {
    return `<div class="result-row"><button type="button" data-open-sub="${esc(x.id)}" style="background:none;border:0;padding:0;font:inherit;color:inherit;text-align:left;cursor:pointer">${esc(x.learnerName)} — ${esc(x.assignmentTitle)}</button>${markPill(x.percentage, x.band)}</div>`;
  }
  function filterSubs(list, query) {
    if (!query) return list;
    const q = query.toLowerCase();
    return list.filter((x) => `${x.learnerName} ${x.assignmentTitle} ${x.subject} ${x.className}`.toLowerCase().includes(q));
  }

  function renderQueueInto(targetId, searchInputId) {
    const el = $(targetId);
    if (!el) return;
    if (submissionsFailed) {
      el.innerHTML = errorState("Couldn't load work to mark — check your connection and try again.", loadSubmissions);
      return;
    }
    const queue = submissionCache.filter((x) => x.status === "submitted")
      .sort((x, y) => String(x.submittedAt).localeCompare(String(y.submittedAt))); // oldest first
    const filtered = filterSubs(queue, ($(searchInputId)?.value || "").trim());
    el.innerHTML = filtered.length
      ? filtered.map(queueRow).join("")
      : queue.length
        ? `<div class="empty-state">No matches for that search.</div>`
        : emptyState("Nothing to mark", "Work your learners hand in shows up here.");
  }

  function renderRecentResults() {
    if (submissionsFailed) {
      const msg = errorState("Couldn't load marked work — check your connection and try again.", loadSubmissions);
      $("#resultList").innerHTML = msg;
      $("#homeResultList").innerHTML = msg;
      return;
    }
    const marked = submissionCache.filter((x) => x.status === "marked")
      .sort((x, y) => String(y.markedAt).localeCompare(String(x.markedAt)));
    const empty = `<div class="empty-state">Nothing marked yet.</div>`;
    $("#resultList").innerHTML = marked.length ? marked.slice(0, 50).map(markedRow).join("") : empty;
    $("#homeResultList").innerHTML = marked.length
      ? marked.slice(0, 8).map(markedRow).join("") + (marked.length > 8 ? `<p class="hint" style="margin-top:.4rem">+${marked.length - 8} more — see Results.</p>` : "")
      : empty;
  }

  function renderAllAssignmentViews() {
    renderQueueInto("#gradingQueue", "#gradingSearch");
    renderQueueInto("#taskList", "#assignSearch");
    renderRecentResults();
    renderKpis();
  }

  async function loadSubmissions() {
    try {
      submissionCache = await getSubmissions({ limit: 500 });
      submissionsFailed = false;
    } catch (err) {
      submissionsFailed = true;
      submissionCache = [];
      console.error("could not load submissions:", err);
    }
    renderAllAssignmentViews();
  }
  /** After anything changes: the lists, the queue and the results. */
  function refreshWork() {
    loadAssignmentList();
    loadSubmissions();
    renderResults();
  }

  for (const sel of ["#gradingQueue", "#taskList", "#resultList", "#homeResultList"]) {
    $(sel).addEventListener("click", (e) => {
      const b = e.target.closest("[data-open-sub]");
      if (b) openMarking(b.dataset.openSub, { canMark: true, onDone: refreshWork });
    });
  }
  $("#gradingSearch")?.addEventListener("input", () => renderQueueInto("#gradingQueue", "#gradingSearch"));
  $("#assignSearch")?.addEventListener("input", () => renderQueueInto("#taskList", "#assignSearch"));

  function assignmentRow(a) {
    const c = a.counts || {};
    return `
      <div class="task-row" data-asg="${esc(a.id)}">
        <div style="flex:1;min-width:0"><b>${esc(a.title)}</b>
          <span>${assignmentStatusPill(a.status)} ${esc(a.className || "")} · ${esc(a.subject)}${a.term ? ` · ${esc(a.term)}` : ""}${a.dueAt ? ` · due ${esc(fmtWhen(a.dueAt))}` : ""}${
            a.status !== "draft" ? ` · ${c.submitted ?? 0}/${c.expected ?? 0} handed in${c.toMark ? ` · <b>${c.toMark} to mark</b>` : ""}` : ""}</span></div>
        <div class="roster-actions"><button type="button" data-open-asg>Open</button></div>
      </div>`;
  }
  async function loadAssignmentList() {
    const el = $("#assignmentList");
    el.innerHTML = skeleton(3);
    try {
      assignmentList = await getStaffAssignments({ classId: $("#af_class").value, status: $("#af_status").value });
    } catch (err) {
      el.innerHTML = errorState(friendlyError(err), loadAssignmentList);
      return;
    }
    el.innerHTML = assignmentList.length
      ? assignmentList.map(assignmentRow).join("")
      : emptyState("No assignments here yet", "Set work for a class you teach with “New assignment”.");
  }
  $("#af_class").addEventListener("change", loadAssignmentList);
  $("#af_status").addEventListener("change", loadAssignmentList);
  const openAsg = (id) => openAssignmentDetail(id, { canManage: true, canMark: true, classes: myClasses, terms: classTerms, onChanged: refreshWork });
  $("#assignmentList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-asg]");
    if (row) openAsg(row.dataset.asg);
  });
  async function newAssignment(classId = "") {
    if (!myClasses.length) {
      toast("No classes yet", "Your school head assigns you to classes — then you can set them work.", "error");
      return;
    }
    const saved = await openAssignmentEditor({ classes: myClasses, terms: classTerms, defaultClassId: classId || $("#af_class").value });
    if (saved) {
      refreshWork();
      openAsg(saved.assignment.id);
    }
  }
  $("#newAssignmentBtn").addEventListener("click", () => newAssignment());

  /* ------------------------------------------------------------ results
     Completion and achievement, side by side — never one number. */
  async function renderResults() {
    const el = $("#resultsTable");
    el.innerHTML = skeleton(4, { avatar: false });
    try {
      el.innerHTML = resultsTableHtml(await getResults({
        by: $("#rf_by").value, classId: $("#rf_class").value, subjectId: $("#rf_subject").value, termId: $("#rf_term").value,
      }));
    } catch (err) {
      el.innerHTML = errorState(friendlyError(err), renderResults);
    }
  }
  for (const sel of ["#rf_by", "#rf_class", "#rf_subject", "#rf_term"]) $(sel).addEventListener("change", renderResults);
  getSubjects().then((list) => {
    $("#rf_subject").innerHTML = `<option value="">All subjects</option>${list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}`;
  }).catch(() => {});

  renderKpis();

  /* ------------------------------------------------------------ my learners
     Learners sign in with a username + 4-digit PIN. This teacher creates
     and manages the accounts; the roster below is the whole editable list. */
  const roster = $("#learnerRoster");
  const pager = $("#learnerRosterPager");
  const addForm = $("#addLearnerForm");
  const addError = $("#addLearnerError");

  const LEARNER_PAGE_SIZE = 8;
  let learnerPage = 0;

  function learnerRow(l) {
    const active = l.status === "ACTIVE";
    const left = !active && l.exitDate ? ` · left ${esc(new Date(`${l.exitDate}T00:00:00`).toLocaleDateString())}${l.exitReason ? ` (${esc(l.exitReason)})` : ""}` : "";
    return `
      <div class="task-row" data-learner="${esc(l.id)}" data-username="${esc(l.username)}" data-grade="${esc(l.grade || "")}" data-gender="${esc(l.gender || "")}">
        <div style="flex:1;min-width:0">
          <button type="button" data-act="view" style="background:none;border:0;padding:0;font:inherit;cursor:pointer;color:var(--brand-fg);text-align:left"><b>${esc(l.fullName)}</b></button>
          <span>${statusPill(l.status)} ${l.userCode ? `<span class="code-chip">${esc(l.userCode)}</span> ` : ""}@${esc(l.username)}${l.className ? " · " + esc(l.className) : l.grade ? " · " + esc(l.grade) : ""}${l.locked ? ' · <span class="pill warm">Locked</span>' : ""}${left}</span>
        </div>
        <div class="roster-actions">
          ${active ? `
          <button type="button" data-act="view">View activity</button>
          <button type="button" data-act="edit">Edit</button>
          <button type="button" data-act="pin">Reset PIN</button>
          ${l.locked ? '<button type="button" data-act="unlock">Unlock</button>' : ""}
          <button type="button" data-act="history">History</button>
          <button type="button" data-act="archive" class="danger">Archive</button>` : `
          <button type="button" data-act="history">History</button>
          <button type="button" data-act="reactivate">Reactivate</button>`}
        </div>
      </div>`;
  }

  // The roster is fully loaded already (getLearners() has no server paging),
  // so "next page" here is just a compact client-side slice — a class of 30
  // shows 8 at a time instead of one long scroll.
  function renderRosterPage() {
    if (learnersFailed) {
      roster.innerHTML = errorState("Couldn't load your learners — check your connection and try again.", renderRoster);
      pager.innerHTML = "";
      return;
    }
    const totalPages = Math.max(1, Math.ceil(learnerCache.length / LEARNER_PAGE_SIZE));
    if (learnerPage > totalPages - 1) learnerPage = totalPages - 1;
    if (learnerPage < 0) learnerPage = 0;
    const start = learnerPage * LEARNER_PAGE_SIZE;
    const pageItems = learnerCache.slice(start, start + LEARNER_PAGE_SIZE);

    roster.innerHTML = learnerCache.length
      ? pageItems.map(learnerRow).join("")
      : rosterStatus() === "archived"
        ? emptyState("No archived learners", "Learners who leave, move school or finish appear here — they're never deleted.")
        : emptyState("No learners yet", "Add one to give them a sign-in.");

    pager.innerHTML = learnerCache.length > LEARNER_PAGE_SIZE
      ? `<span>${start + 1}–${Math.min(learnerCache.length, start + LEARNER_PAGE_SIZE)} of ${learnerCache.length}</span>
         <div style="display:flex;gap:.4rem">
           <button type="button" class="btn btn-outline" data-learner-page="prev" style="padding:.25rem .7rem;font-size:.8rem" ${learnerPage <= 0 ? "disabled" : ""}>← Prev</button>
           <button type="button" class="btn btn-outline" data-learner-page="next" style="padding:.25rem .7rem;font-size:.8rem" ${learnerPage >= totalPages - 1 ? "disabled" : ""}>Next →</button>
         </div>`
      : "";
  }

  pager.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-learner-page]");
    if (!btn) return;
    learnerPage += btn.dataset.learnerPage === "next" ? 1 : -1;
    renderRosterPage();
  });

  let learnersFailed = false;
  const rosterStatus = () => $("#rosterStatus").value;
  $("#rosterStatus").addEventListener("change", () => { learnerPage = 0; renderRoster(); });
  async function renderRoster() {
    roster.innerHTML = skeleton(LEARNER_PAGE_SIZE);
    try {
      learnerCache = await getLearners({ status: rosterStatus() });
      if (rosterStatus() === "active") activeCount = learnerCache.length;
      learnersFailed = false;
    } catch (err) {
      learnersFailed = true;
      learnerCache = [];
      console.error("could not load learners:", err);
    }
    renderRosterPage();
    renderHomeLearnerActivity();
    renderKpis();
  }

  /* Home's "Learner activity" panel — the same roster, but read + jump-to
     only (no edit/PIN/remove); those management actions stay on My
     Learners so this stays a quick scan-and-check-in view. */
  function learnerActivityRow(l) {
    return `
      <div class="task-row" data-learner-activity="${esc(l.id)}">
        <div style="flex:1">
          <b>${esc(l.fullName)}</b>
          <span>${l.userCode ? `<span class="code-chip">${esc(l.userCode)}</span> ` : ""}@${esc(l.username)}${l.grade ? " · " + esc(l.grade) : ""}${l.locked ? ' · <span class="pill warm">Locked</span>' : ""}</span>
        </div>
        <button type="button" class="pill" style="border:0;cursor:pointer" data-view-activity="${esc(l.id)}">View activity</button>
      </div>`;
  }
  function renderHomeLearnerActivity() {
    const el = $("#learnerActivityList");
    if (!el) return;
    if (learnersFailed) {
      el.innerHTML = errorState("Couldn't load your learners — check your connection and try again.", renderRoster);
      return;
    }
    const q = ($("#learnerActivitySearch")?.value || "").trim().toLowerCase();
    const filtered = q
      ? learnerCache.filter((l) => `${l.fullName} ${l.username} ${l.grade || ""} ${l.userCode || ""}`.toLowerCase().includes(q))
      : learnerCache;
    el.innerHTML = filtered.length
      ? filtered.map(learnerActivityRow).join("")
      : learnerCache.length
        ? `<div class="empty-state">No matches for that search.</div>`
        : `<div class="empty-state">No learners yet. Add one from My Learners.</div>`;
  }
  $("#learnerActivitySearch")?.addEventListener("input", renderHomeLearnerActivity);
  $("#learnerActivityList")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view-activity]");
    if (!btn) return;
    const row = btn.closest("[data-learner-activity]");
    openLearnerActivity(btn.dataset.viewActivity, row.querySelector("b").textContent);
  });

  // Learners always join this teacher's own school — shown up front so
  // it's clear where they'll land and what code they'll get.
  const schoolCode = user.userCode ? user.userCode.split("-").slice(0, 2).join("-") : "";
  $("#nl_school_hint").innerHTML = user.school
    ? `Placed automatically in <b>${esc(user.school)}</b>${schoolCode ? ` (${esc(schoolCode)})` : ""}${user.county ? ` · ${esc(user.county)} County` : ""}. Each learner gets their own code${schoolCode ? `, like <b>${esc(schoolCode)}-L0001</b>` : ""}.`
    : "Placed automatically in your own school and county.";

  // A class sets the grade; the free grade box is only for learners not in a class yet.
  $("#nl_class").addEventListener("change", () => { $("#nl_grade_field").hidden = !!$("#nl_class").value; });
  $("#addLearnerBtn").addEventListener("click", () => {
    addForm.hidden = false;
    addError.hidden = true;
    $("#nl_name").focus();
  });
  $("#cancelLearnerBtn").addEventListener("click", () => {
    addForm.hidden = true;
    addForm.reset();
  });

  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    addError.hidden = true;
    const btn = addForm.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const learner = await addLearner({
        fullName: $("#nl_name").value.trim(),
        username: $("#nl_user").value.trim().toLowerCase(),
        grade: $("#nl_grade").value.trim(),
        pin: $("#nl_pin").value.trim(),
        classId: $("#nl_class").value || undefined,
        gender: $("#nl_gender").value || undefined,
      });
      addForm.reset();
      addForm.hidden = true;
      toast("Learner added",
        `${learner.fullName} is ${learner.userCode || "in your school"} and signs in with @${learner.username}.`, "success");
      renderRoster();
    } catch (err) {
      addError.textContent = friendlyError(err, "Could not add the learner. Check your connection and try again.");
      addError.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- bulk add (CSV)
  // A blank template to fill in offline and bring back — matches exactly
  // what the parser below reads, so a filled-in copy round-trips cleanly.
  $("#downloadLearnerTemplate").addEventListener("click", () => {
    const csv = "﻿Full name,Username,Grade,PIN,Gender\r\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "learners-template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  function suggestUsername(fullName, taken) {
    const base = fullName.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/).filter(Boolean);
    const stem = base.length > 1 ? `${base[0]}.${base[1][0]}` : (base[0] || "learner");
    let candidate = stem.slice(0, 28);
    let n = 1;
    while (taken.has(candidate)) candidate = `${stem.slice(0, 26)}${++n}`;
    taken.add(candidate);
    return candidate;
  }
  const randomPin = () => String(Math.floor(1000 + Math.random() * 9000));

  // Gender is optional: F / M, female / male, or "prefer not to say".
  function csvGender(v) {
    const g = String(v || "").trim().toLowerCase();
    if (!g) return undefined;
    return { f: "female", m: "male" }[g] || g.replace(/\s+/g, "_");
  }

  function parseLearnerCsv(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/^﻿/, "").trim())
      .filter(Boolean)
      .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")))
      .filter((cells) => cells[0] && cells[0].toLowerCase() !== "full name")
      .map(([fullName, username, grade, pin, gender]) => ({
        fullName, username: (username || "").toLowerCase(), grade: grade || "", pin: pin || "", gender: csvGender(gender),
      }));
  }

  $("#learnerCsvInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const resultEl = $("#bulkLearnerResult");
    resultEl.innerHTML = `<div class="empty-state">Reading file…</div>`;

    const text = await file.text().catch(() => "");
    const rows = parseLearnerCsv(text);
    e.target.value = "";
    if (!rows.length) {
      resultEl.innerHTML = `<div class="field-error">That file had no learners in it — the first column of each row should be a full name.</div>`;
      return;
    }

    resultEl.innerHTML = `<div class="empty-state">Adding ${rows.length} learner(s)…</div>`;
    const taken = new Set(learnerCache.map((l) => l.username));
    const created = []; // { fullName, username, pin, code }
    const failed = []; // { fullName, error }
    for (const row of rows) {
      const username = row.username && !taken.has(row.username) ? row.username : suggestUsername(row.fullName || "learner", taken);
      const pin = /^\d{4}$/.test(row.pin) ? row.pin : randomPin();
      try {
        const learner = await addLearner({ fullName: row.fullName, username, grade: row.grade, pin, gender: row.gender });
        taken.add(username);
        created.push({ fullName: row.fullName, username, pin, code: learner.userCode });
      } catch (err) {
        failed.push({ fullName: row.fullName, error: friendlyError(err, "Could not add") });
      }
    }

    resultEl.innerHTML = `
      ${created.length ? `<p class="hint" style="margin-bottom:.3rem"><b>${created.length} learner(s) added.</b> Sign-ins generated for anyone who didn't have one — write these down:</p>
        <div style="max-height:12rem;overflow:auto;border:1px solid var(--line);border-radius:.5rem;padding:.5rem .7rem;font-size:.85rem">
          ${created.map((c) => `<div>${c.code ? `<span class="code-chip">${esc(c.code)}</span> ` : ""}${esc(c.fullName)} — <b>@${esc(c.username)}</b> · PIN ${esc(c.pin)}</div>`).join("")}
        </div>` : ""}
      ${failed.length ? `<p class="field-error" style="margin-top:.5rem">${failed.length} row(s) couldn't be added: ${failed.map((f) => `${esc(f.fullName)} (${esc(f.error)})`).join(", ")}</p>` : ""}
    `;
    toast("Bulk add finished", `${created.length} added${failed.length ? `, ${failed.length} failed` : ""}.`, failed.length ? "error" : "success");
    renderRoster();
  });

  roster.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const rowEl = btn.closest("[data-learner]");
    const id = rowEl.dataset.learner;
    const nameEl = rowEl.querySelector("b");
    const act = btn.dataset.act;
    if (act === "view") return openLearnerActivity(id, nameEl.textContent);

    try {
      if (act === "edit") {
        const fullName = prompt("Full name", nameEl.textContent);
        if (fullName === null) return;
        const username = prompt("Username (lowercase, 3–32 chars)", rowEl.dataset.username);
        if (username === null) return;
        const grade = prompt("Grade / class", rowEl.dataset.grade);
        if (grade === null) return;
        const GENDER_WORDS = { female: "female", male: "male", prefer_not_to_say: "prefer not to say" };
        const gender = prompt("Gender — optional: female, male or prefer not to say (leave empty if not recorded)", GENDER_WORDS[rowEl.dataset.gender] || "");
        if (gender === null) return;
        await updateLearner(id, {
          fullName: fullName.trim(),
          username: username.trim().toLowerCase(),
          grade: grade.trim(),
          gender: { f: "female", m: "male" }[gender.trim().toLowerCase()] || gender.trim(),
        });
        toast("Learner updated", "");
      } else if (act === "pin") {
        const pin = prompt("New 4-digit PIN");
        if (!pin) return;
        await updateLearner(id, { pin: pin.trim() });
        toast("PIN reset", "Tell the learner their new PIN.");
      } else if (act === "unlock") {
        await updateLearner(id, { unlock: true });
        toast("Unlocked", "");
      } else if (act === "archive") {
        const l = learnerCache.find((x) => x.id === id);
        if (!(await openArchiveDialog(l))) return;
      } else if (act === "reactivate") {
        await setLearnerStatus(id, "ACTIVE");
        toast("Learner reactivated", `${nameEl.textContent} is back on the active roster and can sign in.`, "success");
      } else if (act === "history") {
        openHistoryPanel(id, nameEl.textContent);
        return;
      }
      renderRoster();
    } catch (err) {
      toast("Couldn't do that", friendlyError(err), "error");
    }
  });

  /* "View activity" — a read-only look at what this learner has actually
     done: their assignments (handed in or not, and the marks — two
     separate things) and their library usage/badges. Nothing here can be
     edited; marking happens from the assignment itself. */
  async function openLearnerActivity(id, fallbackName) {
    const panel = openContentPanel({
      title: fallbackName || "Learner activity",
      html: skeleton(4),
    });
    let learner, assignments, library, summary;
    try {
      ({ learner, assignments, library, summary } = await getLearnerActivity(id));
    } catch (err) {
      console.error("could not load learner activity:", err);
      panel.innerHTML = errorState(friendlyError(err), () => openLearnerActivity(id, fallbackName));
      return;
    }
    const now = new Date();
    const assignmentRows = assignments.length
      ? assignments.map((a) => {
          const s = a.submission;
          const overdue = !s?.submittedAt && a.dueAt && new Date(a.dueAt) < now;
          return `
          <div class="task-row">
            <div style="flex:1;min-width:0"><b>${esc(a.title)}</b><span>${esc(a.subject)}${a.className ? ` · ${esc(a.className)}` : ""}${a.dueAt ? ` · due ${esc(fmtWhen(a.dueAt))}` : ""}</span></div>
            <span>${completionPill(a.completion, { late: s?.isLate, overdue })} ${s?.status === "marked" ? markPill(s.percentage, s.band) : ""}</span>
          </div>`;
        }).join("")
      : `<div class="empty-state">No assignments set for them yet.</div>`;
    const c = summary.completion;
    const ach = summary.achievement;
    const usageRows = library.interactions.length
      ? library.interactions.slice(0, 10).map((it) => `
        <div class="task-row">
          <div style="flex:1"><b>${esc(it.title || "Resource")}</b><span>Started ${new Date(it.startedAt).toLocaleString()}${
            it.completedAt ? " · Finished " + new Date(it.completedAt).toLocaleString() : " · In progress"}</span></div>
          <span class="bar-num">${it.durationSeconds != null ? formatDuration(it.durationSeconds) : "—"}</span>
        </div>`).join("")
      : `<div class="empty-state">Nothing opened from the library yet.</div>`;
    const badgeChips = (library.badges || []).slice(0, 6).map((b) => `
      <span class="pill" style="display:inline-flex;align-items:center;gap:.3rem;margin:0 .3rem .3rem 0">&#127942; ${esc(b.title || "Resource")}</span>`).join("");

    panel.innerHTML = `
      <p class="hint" style="margin-top:0">${esc(learner.school || "")}${learner.county ? " · " + esc(learner.county) : ""}${learner.grade ? " · " + esc(learner.grade) : ""} · @${esc(learner.username)}</p>
      <div class="chart-stats" style="grid-template-columns:repeat(3,1fr)">
        <div><b>${c.submitted}/${c.assigned}</b><span>Work handed in${c.rate != null ? ` (${Math.round(c.rate)}%)` : ""}</span></div>
        <div><b>${ach.averagePercent != null ? Math.round(ach.averagePercent) + "%" : "—"}</b><span>Average mark${ach.marked ? `, ${ach.marked} marked` : ""}</span></div>
        <div><b>${formatDuration(library.totalSeconds)}</b><span>Library time</span></div>
      </div>
      <p class="field-hint">Handed in is completion; the average mark is achievement on marked work only. They're separate.</p>
      <h3 style="margin:1rem 0 .4rem">Assignments</h3>
      ${assignmentRows}
      <h3 style="margin:1.1rem 0 .4rem">Digital Library activity</h3>
      <div class="chart-stats" style="grid-template-columns:repeat(2,1fr);margin-bottom:.6rem">
        <div><b>${library.resourcesOpened}</b><span>Resources opened</span></div>
        <div><b>${library.badgesEarned || 0}</b><span>Badges earned</span></div>
      </div>
      ${badgeChips ? `<div style="margin-bottom:.6rem">${badgeChips}</div>` : ""}
      ${usageRows}
    `;
  }

  renderRoster();
  loadSubmissions();
  loadAssignmentList();
  renderResults();

  /* Content library lives in the real database (education.js writes it).
     Teacher Resources go to teachers and the head of institution only —
     never the Learner dashboard; the Digital Library is the learner-facing
     shelf, which teachers and heads can see too. Home gets a short preview
     of each with a link to the full folder-grouped view here (shared
     layout — see "library shelves" in store.js). */
  $("#teacherResourceList").innerHTML = skeleton(3);
  $("#libraryList").innerHTML = skeleton(3);
  $("#homeTeacherResources").innerHTML = skeleton(2, { avatar: false });
  $("#homeLibrary").innerHTML = skeleton(2, { avatar: false });
  async function renderLibraryShelves() {
    let library, folders;
    try {
      [library, folders] = await Promise.all([getLibrary(), getLibraryFolders()]);
    } catch (err) {
      console.error("could not load library:", err);
      const msg = errorState(friendlyError(err), renderLibraryShelves);
      $("#teacherResourceList").innerHTML = msg;
      $("#libraryList").innerHTML = msg;
      $("#homeTeacherResources").innerHTML = msg;
      $("#homeLibrary").innerHTML = msg;
      return;
    }
    const resources = library.filter((l) => normalizeLibraryAudience(l.audience) === "staff");
    const shared = library.filter((l) => normalizeLibraryAudience(l.audience) === "library");
    mountLibraryShelves([
      { el: $("#teacherResourceList"), countEl: $("#teacherResourceCount"), items: resources, emptyMsg: "No teacher resources uploaded yet." },
      { el: $("#libraryList"), countEl: $("#libraryCount"), items: shared, emptyMsg: "Nothing in the library yet." },
    ], folders, $("#shelfSearch"));
    $("#homeTeacherResources").innerHTML = libraryPreviewHtml(resources, { emptyMsg: "No teacher resources uploaded yet." });
    $("#homeLibrary").innerHTML = libraryPreviewHtml(shared, { emptyMsg: "Nothing in the library yet." });
  }
  renderLibraryShelves();

  /* My learning activity — every "Open to read" click above is timed
     from open to return; see nav.js. Home gets the summary tiles only;
     the full interaction log stays on the Activity page. */
  renderUsageSummary();
  async function renderUsageSummary() {
    const el = $("#usageSummary");
    const homeEl = $("#homeUsageSummary");
    el.innerHTML = skeleton(3);
    if (homeEl) homeEl.innerHTML = skeleton(2);
    let u;
    try { u = await getMyLibraryUsage(); } catch (err) {
      console.error("could not load usage:", err);
      const msg = errorState(friendlyError(err), renderUsageSummary);
      el.innerHTML = msg;
      if (homeEl) homeEl.innerHTML = msg;
      return;
    }
    usageCache = u;
    renderKpis();

    const summaryHtml = `
      <div class="chart-stats" style="grid-template-columns:repeat(3,1fr)">
        <div><b>${formatDuration(u.totalSeconds)}</b><span>Time spent</span></div>
        <div><b>${u.resourcesOpened}</b><span>Resources opened</span></div>
        <div><b>${u.badgesEarned || 0}</b><span>Badges earned</span></div>
      </div>`;
    if (homeEl) {
      homeEl.innerHTML = u.interactions.length
        ? summaryHtml
        : `<div class="empty-state">Open something from the library to start tracking your activity here.</div>`;
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
      ${summaryHtml}
      ${badgeChips ? `<div style="margin:.7rem 0 .1rem">${badgeChips}</div>` : ""}
      ${rows}
    `;
  }

  /* Forms the Education Team has sent to teachers — same
     create-once-fill-once loop as the field officer's report form, just
     addressed at this account instead of built into it. */
  renderForms();
  async function renderForms() {
    $("#formsList").innerHTML = skeleton(2, { avatar: false });
    let forms, responses;
    try {
      [forms, responses] = await Promise.all([getForms(), getResponses()]);
    } catch (err) {
      console.error("could not load forms:", err);
      $("#formsList").innerHTML = errorState(friendlyError(err), renderForms);
      return;
    }
    // The API already sends only forms addressed to this teacher's role
    // and county; forms.js renders and submits them (all three kinds).
    mountFormList($("#formsList"), {
      forms: forms.filter((f) => f.audience === "teacher"),
      responses, userId: user.id, onSubmitted: renderForms,
    });
  }
}
main();

async function doSignOut() {
  await signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
