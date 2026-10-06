import { mountNavigation } from "./nav.js";
// Staff dashboards always need Supabase Auth: fetched with the page, not after it.
import "./supabase-auth.js";
import { $, $$, esc, initials, schoolLine, formatDuration, skeleton, emptyState, errorState, friendlyError, toast, confirmDialog } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { normalizeLibraryAudience, GRADES, nextGrade } from "./data.js";
import {
  getForms, getResponses, getLibrary, getLibraryFolders, mountLibraryShelves, libraryPreviewHtml, getMyLibraryUsage,
  getSchoolOverview, getClasses, createClass, updateClass, assignClassTeacher, removeClassTeacher, promoteClass,
  getLearners, updateLearner, setLearnerStatus, getEnrollments,
  getSubjects, addClassSubject, removeClassSubject, getResults, getStaffAssignments, currentTermLabel,
} from "./store.js";
import { resultsTableHtml, openAssignmentDetail, assignmentStatusPill, fmtWhen } from "./assignments-ui.js";
import { openContentPanel, closeViewer } from "./viewer.js";
import { statusPill, openArchiveDialog, openHistoryPanel } from "./learners-ui.js";
import { mountFormList } from "./forms.js";
// The school profile and teachers pages (admin-ui.js) load when first opened.
const adminUi = () => import("./admin-ui.js");
const pageFailed = (el) => (err) => { el.innerHTML = errorState(friendlyError(err, "Couldn't load this page — check your connection.")); };

const ICON = {
  learners: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  teachers: '<path d="M4 19V6a2 2 0 0 1 2-2h13v14H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h13"/><path d="M9 8h7M9 11h7"/>',
  grades: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;

/* A short label for the grade-row "avatar" swatch — "Grade 5" → "G5",
   anything without a number falls back to its first two letters, and an
   unset grade gets a plain dash rather than a made-up code. */
function gradeCode(grade) {
  if (!grade || grade === "(not set)") return "–";
  const m = grade.match(/\d+/);
  if (m) return "G" + m[0];
  return grade.slice(0, 2).toUpperCase();
}

async function main() {
  const user = await requireRole("school_leader");
  if (!user) return;

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `School Head · ${user.userCode || user.county || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  // The menu (navigation.js). Everything here is this school's only — the server makes sure.
  mountNavigation(user, {
    onPage(page) {
      if (page === "school-profile") adminUi().then((m) => m.renderSchoolProfile($("#spBody"), user.schoolId)).catch(pageFailed($("#spBody")));
    },
  });
  $("#topSub").textContent = schoolLine(user);
  currentTermLabel().then((term) => { if (term) $("#topSub").textContent = `${schoolLine(user)} · ${term}`; });

  /* Everything on this dashboard is an aggregate — counts, percentages,
     grade-level rollups — never a single learner's name or row. That's
     the whole point of a school-leader view versus a teacher's: less
     detail, more "is my school on track." */
  let overview = {
    teacherCount: 0, learnerCount: 0, teachersByType: [],
    assignmentsTotal: 0, assignmentsDone: 0, gradeBreakdown: [],
    visits: [], visitsTotal: 0, visitedThisTerm: false,
  };
  let formsCache = [];
  let responsesCache = [];

  function renderKpis() {
    $("#statRow").innerHTML = `
      <div class="stat-tile"><div class="s-label">${svg(ICON.learners)}Learners</div><div class="s-num">${overview.learnerCount}</div><div class="s-sub">enrolled</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.teachers)}Teachers</div><div class="s-num">${overview.teacherCount}</div><div class="s-sub">on staff</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.grades)}Grades running</div><div class="s-num">${overview.gradeBreakdown.length}</div><div class="s-sub">this term</div></div>
    `;
  }

  /* Completion (work handed in) and achievement (marks on marked work),
     side by side and never combined. */
  function renderLearningActivity() {
    const { assignmentsTotal: total, assignmentsDone: done, achievement } = overview;
    $("#learningActivity").innerHTML = total
      ? `<div class="chart-stats" style="grid-template-columns:repeat(2,1fr)">
           <div><b>${Math.round((done / total) * 100)}%</b><span>Work handed in (${done}/${total})</span></div>
           <div><b>${achievement?.averagePercent != null ? Math.round(achievement.averagePercent) + "%" : "—"}</b><span>${achievement?.marked ? `Average mark, ${achievement.marked} marked${achievement.band ? ` · ${esc(achievement.band)}` : ""}` : "Average mark — nothing marked yet"}</span></div>
         </div>`
      : `<div class="empty-state">No assignments set yet.</div>`;
  }

  function gradeRow({ grade, learners, assignmentsTotal, assignmentsDone, marked, averagePercent, band }, withWork) {
    const pct = assignmentsTotal ? Math.round((assignmentsDone / assignmentsTotal) * 100) : 0;
    return `
      <div class="class-row">
        <div class="class-swatch" style="background:var(--brand)">${esc(gradeCode(grade))}</div>
        <div class="class-info"><b>${esc(grade)}</b><span>${learners} learner${learners === 1 ? "" : "s"}${withWork
          ? ` · ${assignmentsDone}/${assignmentsTotal} handed in · ${marked ? `average mark ${Math.round(averagePercent)}%${band ? ` (${esc(band)})` : ""} on ${marked} marked` : "nothing marked yet"}` : ""}</span>
          ${withWork ? `<div class="class-bar"><i style="width:${pct}%"></i></div>` : ""}</div>
        ${withWork ? `<div class="class-meta"><b>${pct}%</b>handed in</div>` : ""}
      </div>`;
  }

  function renderLearningByGrade() {
    $("#learningByGrade").innerHTML = overview.gradeBreakdown.length
      ? overview.gradeBreakdown.map((g) => gradeRow(g, true)).join("")
      : `<div class="empty-state">No grades recorded yet.</div>`;
  }

  function renderLearnersByGrade() {
    $("#learnersByGrade").innerHTML = overview.gradeBreakdown.length
      ? overview.gradeBreakdown.map((g) => gradeRow(g, false)).join("")
      : `<div class="empty-state">No learners recorded yet.</div>`;
  }

  function renderTeachers() {
    $("#teacherStatRow").innerHTML =
      `<div class="stat-tile"><div class="s-label">${svg(ICON.teachers)}Teachers</div><div class="s-num">${overview.teacherCount}</div><div class="s-sub">on staff</div></div>`;
    $("#teacherTypeList").innerHTML = overview.teachersByType.length
      ? overview.teachersByType.map((t) => `<div class="result-row"><span>${esc(t.label)}</span><span>${t.value}</span></div>`).join("")
      : `<div class="empty-state">No teacher type recorded yet.</div>`;
  }

  function visitRow(v) {
    return `
      <div class="task-row"><div><b>${esc(v.visitType || "Visit")}</b><span>${new Date(v.createdAt).toLocaleDateString()}</span></div></div>`;
  }

  function renderVisits() {
    $("#visitList").innerHTML = overview.visits.length
      ? overview.visits.map(visitRow).join("")
      : `<div class="empty-state">No field visits recorded yet.</div>`;
    $("#visitSummary").innerHTML = overview.visits.length
      ? overview.visits.slice(0, 3).map(visitRow).join("")
        + (overview.visitsTotal > 3 ? `<p class="hint" style="margin-top:.4rem">${overview.visitsTotal} visits on record — view all.</p>` : "")
      : `<div class="empty-state">No field visits recorded yet.</div>`;
  }

  function renderReportingStatus() {
    const el = $("#reportingStatus");
    const total = formsCache.length;
    if (!total) {
      el.innerHTML = `<div class="empty-state">No forms from the Education Team yet.</div>`;
      return;
    }
    const answeredIds = new Set(responsesCache.filter((r) => r.respondentId === user.id).map((r) => r.formId));
    const pending = formsCache.filter((f) => !answeredIds.has(f.id));
    el.innerHTML = pending.length
      ? `<div class="alert alert-warn"><div><b>${pending.length} form${pending.length === 1 ? "" : "s"} awaiting response</b>${total - pending.length} of ${total} filed so far.</div></div>`
      : `<div class="alert alert-ok"><div><b>All caught up</b>${total} of ${total} form${total === 1 ? "" : "s"} from the Education Team ${total === 1 ? "is" : "are"} filed.</div></div>`;
  }

  /* Plain-language, real signals only — no manufactured "tasks." Each item
     here is derived straight from data already on the page, so nothing
     shows up here that isn't also visible (and explainable) elsewhere. */
  function renderAttention() {
    const items = [];
    const answeredIds = new Set(responsesCache.filter((r) => r.respondentId === user.id).map((r) => r.formId));
    for (const f of formsCache.filter((f) => !answeredIds.has(f.id))) {
      items.push({ tone: "warn", title: "Form awaiting response", detail: `"${f.title}" from the Education Team hasn't been filled in yet.` });
    }
    if (overview.assignmentsTotal > 0) {
      const rate = overview.assignmentsDone / overview.assignmentsTotal;
      if (rate < 0.5) {
        items.push({ tone: "warn", title: "Work not being handed in", detail: `Only ${Math.round(rate * 100)}% of the work set across the school has been handed in so far.` });
      }
    }
    if (!overview.visitedThisTerm) {
      items.push({ tone: "info", title: "Outstanding school task", detail: "No field visit has been recorded for the school this term." });
    }
    $("#attentionList").innerHTML = items.length
      ? items.map((it) => `<div class="alert alert-${it.tone}"><div><b>${esc(it.title)}</b>${esc(it.detail)}</div></div>`).join("")
      : `<div class="empty-state">Nothing needs your attention right now.</div>`;
  }

  // Every panel below reads from the one `overview` object, so a single
  // failed fetch would otherwise silently render as "0 learners, no
  // grades yet" — indistinguishable from a genuinely new school. One
  // shared guard here, instead of six separate ones, replaces every
  // overview-driven panel with the same error+retry when that happens;
  // reporting status/attention (forms-derived) still render normally.
  let overviewFailed = false;
  const OVERVIEW_TARGETS = ["#statRow", "#learningActivity", "#learningByGrade", "#learnersByGrade", "#teacherStatRow", "#teacherTypeList", "#visitSummary", "#visitList"];

  function renderAllOverview() {
    if (overviewFailed) {
      const msg = errorState("Couldn't load your school's data — check your connection and try again.", loadOverview);
      OVERVIEW_TARGETS.forEach((sel) => { const el = $(sel); if (el) el.innerHTML = msg; });
    } else {
      renderKpis();
      renderLearningActivity();
      renderLearningByGrade();
      renderLearnersByGrade();
      renderTeachers();
      renderVisits();
    }
    renderReportingStatus();
    renderAttention();
  }
  OVERVIEW_TARGETS.forEach((sel) => { const el = $(sel); if (el) el.innerHTML = skeleton(3); });
  $("#reportingStatus").innerHTML = skeleton(1, { avatar: false });
  $("#attentionList").innerHTML = skeleton(2, { avatar: false });

  async function loadOverview() {
    OVERVIEW_TARGETS.forEach((sel) => { const el = $(sel); if (el) el.innerHTML = skeleton(3); });
    try {
      overview = await getSchoolOverview();
      overviewFailed = false;
    } catch (err) {
      overviewFailed = true;
      console.error("could not load school overview:", err);
    }
    renderAllOverview();
  }
  loadOverview();

  /* Forms the Education Team has sent to school heads — the same
     create-once-fill-once loop as the teacher dashboard. Lives on
     Overview now (per the new layout); "School reporting status" and
     "Attention required" above are both derived from this same data. */
  renderForms();
  async function renderForms() {
    $("#formsList").innerHTML = skeleton(2, { avatar: false });
    try {
      const [allForms, responses] = await Promise.all([getForms(), getResponses()]);
      formsCache = allForms.filter((f) => f.audience === "school_leader");
      responsesCache = responses;
    } catch (err) {
      console.error("could not load forms:", err);
      $("#formsList").innerHTML = errorState(friendlyError(err), renderForms);
      return;
    }
    renderReportingStatus();
    renderAttention();

    // The API already sends only forms addressed to school heads in this
    // school's county; forms.js renders and submits them (all three kinds).
    mountFormList($("#formsList"), {
      forms: formsCache, responses: responsesCache, userId: user.id, onSubmitted: renderForms,
    });
  }

  /* Content library. As head of institution, the school leader sees all
     three shelves: Teacher Resources (staff-only), the learner-facing
     Digital Library, and anything addressed specifically to school
     leadership — the last of which also gets a short preview on
     Overview, since that's the one most relevant to this role. */
  $("#resourceList").innerHTML = skeleton(3);
  $("#libraryList").innerHTML = skeleton(3);
  $("#headOnlyList").innerHTML = skeleton(2);
  $("#leadershipResources").innerHTML = skeleton(2, { avatar: false });
  async function renderLibraryShelves() {
    let library, folders;
    try {
      [library, folders] = await Promise.all([getLibrary(), getLibraryFolders()]);
    } catch (err) {
      console.error("could not load library:", err);
      const msg = errorState(friendlyError(err), renderLibraryShelves);
      $("#resourceList").innerHTML = msg;
      $("#libraryList").innerHTML = msg;
      $("#headOnlyList").innerHTML = msg;
      $("#leadershipResources").innerHTML = msg;
      return;
    }
    const resources = library.filter((l) => normalizeLibraryAudience(l.audience) === "staff");
    const shared = library.filter((l) => normalizeLibraryAudience(l.audience) === "library");
    const headOnly = library.filter((l) => normalizeLibraryAudience(l.audience) === "school_leader");
    mountLibraryShelves([
      { el: $("#headOnlyList"), countEl: $("#headOnlyCount"), items: headOnly, emptyMsg: "Nothing addressed to school heads yet." },
      { el: $("#resourceList"), countEl: $("#resourceCount"), items: resources, emptyMsg: "No teacher resources uploaded yet." },
      { el: $("#libraryList"), countEl: $("#libraryCount"), items: shared, emptyMsg: "Nothing in the library yet." },
    ], folders, $("#shelfSearch"));
    $("#leadershipResources").innerHTML = libraryPreviewHtml(headOnly, { emptyMsg: "Nothing addressed to school heads yet." });
  }
  renderLibraryShelves();

  /* My learning activity — every "Open to read" click above is timed
     from open to return; see nav.js. Personal, so it stays on the
     Resources page rather than the school-wide Overview. */
  renderUsageSummary();
  async function renderUsageSummary() {
    const el = $("#usageSummary");
    el.innerHTML = skeleton(3);
    let u;
    try { u = await getMyLibraryUsage(); } catch (err) {
      console.error("could not load usage:", err);
      el.innerHTML = errorState(friendlyError(err), renderUsageSummary);
      return;
    }
    if (!u.interactions.length) {
      el.innerHTML = emptyState("Nothing to show yet", "Open something from the library to start tracking your activity here.");
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
  /* ------------------------------------------------------------ learners & classes
     The school head manages everyone enrolled in their own school: the
     school-wide roster, the year's classes (create, class teacher,
     promotion) and the record of everyone who has left. The API keeps all
     of this to this school only. */
  let classes = [];
  let schoolTeachers = [];
  let roster = [];

  $("#nc_grade").innerHTML = GRADES.map((g) => `<option>${esc(g)}</option>`).join("");

  let terms = null;
  async function loadClasses() {
    try {
      ({ classes, schoolTeachers = [], terms = [] } = await getClasses());
    } catch (err) {
      $("#classManager").innerHTML = errorState(friendlyError(err), loadClasses);
      return;
    }
    $("#classesMeta").textContent = `${classes.length} class${classes.length === 1 ? "" : "es"} this year`;
    const keep = $("#srClass").value;
    $("#srClass").innerHTML = `<option value="">All classes</option>${
      classes.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}<option value="none">Not in a class</option>`;
    $("#srClass").value = [...$("#srClass").options].some((o) => o.value === keep) ? keep : "";
    const keepR = $("#hr_class").value;
    $("#hr_class").innerHTML = `<option value="">All classes</option>${classes.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}`;
    $("#hr_class").value = classes.some((c) => c.id === keepR) ? keepR : "";
    if (terms) {
      const keepT = $("#hr_term").value;
      $("#hr_term").innerHTML = `<option value="">All terms</option>${terms.map((t) => `<option value="${esc(t.id)}">${esc(t.label || t.id)}</option>`).join("")}`;
      $("#hr_term").value = terms.some((t) => t.id === keepT) ? keepT : "";
    }
    renderClassManager();
    renderRoster();
  }

  /* ------------------------------------------------------------ results and assignments
     Read-only for the school head: what's been set across the school, and
     results with completion and achievement kept apart. */
  async function renderHeadResults() {
    const el = $("#headResults");
    el.innerHTML = skeleton(4, { avatar: false });
    try {
      el.innerHTML = resultsTableHtml(await getResults({
        by: $("#hr_by").value, classId: $("#hr_class").value, subjectId: $("#hr_subject").value, termId: $("#hr_term").value,
      }));
    } catch (err) {
      el.innerHTML = errorState(friendlyError(err), renderHeadResults);
    }
  }
  for (const sel of ["#hr_by", "#hr_class", "#hr_subject", "#hr_term"]) $(sel).addEventListener("change", () => { renderHeadResults(); renderHeadAssignments(); });
  getSubjects().then((list) => {
    $("#hr_subject").innerHTML = `<option value="">All subjects</option>${list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}`;
  }).catch(() => {});

  async function renderHeadAssignments() {
    const el = $("#headAssignments");
    el.innerHTML = skeleton(3);
    let list;
    try {
      list = await getStaffAssignments({ classId: $("#hr_class").value, subjectId: $("#hr_subject").value, termId: $("#hr_term").value });
    } catch (err) {
      el.innerHTML = errorState(friendlyError(err), renderHeadAssignments);
      return;
    }
    list = list.filter((a) => a.status !== "draft");
    el.innerHTML = list.length
      ? list.map((a) => {
          const c = a.counts || {};
          return `
          <div class="task-row" data-asg="${esc(a.id)}">
            <div style="flex:1;min-width:0"><b>${esc(a.title)}</b>
              <span>${assignmentStatusPill(a.status)} ${esc(a.className || "")} · ${esc(a.subject)}${a.teacherName ? ` · ${esc(a.teacherName)}` : ""}${a.dueAt ? ` · due ${esc(fmtWhen(a.dueAt))}` : ""} · ${c.submitted ?? 0}/${c.expected ?? 0} handed in · ${c.marked ?? 0} marked</span></div>
            <div class="roster-actions"><button type="button">Open</button></div>
          </div>`;
        }).join("")
      : `<div class="empty-state">No assignments published yet.</div>`;
  }
  $("#headAssignments").addEventListener("click", (e) => {
    const row = e.target.closest("[data-asg]");
    if (row) openAssignmentDetail(row.dataset.asg, { canManage: false, canMark: false });
  });
  renderHeadResults();
  renderHeadAssignments();

  function renderClassManager() {
    if (!classes.length) {
      $("#classManager").innerHTML = emptyState("No classes yet", "Add the year's classes above, then give each one a class teacher.");
      return;
    }
    $("#classManager").innerHTML = classes.map((c) => {
      const ct = c.teachers.find((t) => t.role === "class_teacher");
      const options = `<option value="">No class teacher</option>${schoolTeachers.map((t) =>
        `<option value="${esc(t.id)}"${ct?.teacherId === t.id ? " selected" : ""}>${esc(t.fullName)}</option>`).join("")}`;
      return `
        <div class="task-row" data-class="${esc(c.id)}" style="flex-wrap:wrap">
          <div style="flex:1;min-width:12rem">
            <b>${esc(c.name)}</b>
            <span>${esc(c.grade)} · ${c.learnerCount} active learner${c.learnerCount === 1 ? "" : "s"}</span>
          </div>
          <label class="field" style="margin:0;min-width:12rem"><span class="hint-inline">Class teacher</span>
            <select data-class-teacher="${esc(c.id)}">${options}</select></label>
          <div class="roster-actions">
            <button type="button" data-edit-class="${esc(c.id)}">Edit…</button>
            <button type="button" data-subjects="${esc(c.id)}">Subjects…</button>
            ${c.learnerCount ? `<button type="button" data-promote="${esc(c.id)}">Promote…</button>` : ""}
            ${c.learnerCount ? "" : `<button type="button" class="danger" data-archive-class="${esc(c.id)}">Archive</button>`}
          </div>
          <div style="flex-basis:100%;font-size:.8rem;color:var(--ink-soft)">${(c.subjects || []).length
            ? `Subjects: ${c.subjects.map((x) => esc(x.name)).join(", ")}` : "No subjects set — teachers can set work in any subject"}</div>
        </div>`;
    }).join("");
  }

  $("#newClassForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const cls = await createClass({ grade: $("#nc_grade").value, name: $("#nc_name").value.trim() });
      toast("Class added", `${cls.name} is ready — give it a class teacher.`, "success");
      $("#nc_name").value = "";
      loadClasses();
    } catch (err) {
      toast("Couldn't add the class", friendlyError(err), "error");
    } finally {
      btn.disabled = false;
    }
  });

  $("#classManager").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-class-teacher]");
    if (!sel) return;
    const cls = classes.find((c) => c.id === sel.dataset.classTeacher);
    const current = cls?.teachers.find((t) => t.role === "class_teacher");
    sel.disabled = true;
    try {
      if (sel.value) await assignClassTeacher(cls.id, sel.value);
      else if (current) await removeClassTeacher(cls.id, current.teacherId);
      toast("Class teacher updated", sel.value ? `Learners in ${cls.name} now show on their roster.` : "", "success");
      loadClasses();
    } catch (err) {
      sel.disabled = false;
      toast("Couldn't change the class teacher", friendlyError(err), "error");
    }
  });

  /* Rename a class, or change its grade (only while it has no learners —
     otherwise learners move up by promotion). */
  function openEditClass(cls) {
    const panel = openContentPanel({
      title: `Edit ${cls.name}`,
      html: `
        <form class="fill-form" data-edit style="max-width:30rem">
          <div class="field"><label for="ec_name">Name</label><input id="ec_name" type="text" maxlength="80" value="${esc(cls.name)}" required></div>
          <div class="field"><label for="ec_grade">Grade</label>
            <select id="ec_grade" ${cls.learnerCount ? "disabled" : ""}>${GRADES.map((g) => `<option${g === cls.grade ? " selected" : ""}>${esc(g)}</option>`).join("")}</select>
            ${cls.learnerCount ? `<p class="field-hint">The grade can't change while the class has learners — promote them instead.</p>` : ""}</div>
          <p class="field-hint">School year ${esc(cls.academicYear)}.</p>
          <div style="display:flex;gap:.6rem"><button class="btn btn-primary" type="submit">Save</button></div>
        </form>`,
    });
    panel.querySelector("[data-edit]").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const patch = { name: panel.querySelector("#ec_name").value.trim() };
      if (!cls.learnerCount) patch.grade = panel.querySelector("#ec_grade").value;
      try {
        await updateClass(cls.id, patch);
        toast("Class updated", "", "success");
        closeViewer();
        loadClasses();
      } catch (err) {
        toast("Couldn't update the class", friendlyError(err), "error");
      }
    });
  }

  /* The subjects a class takes — teachers set work in these. */
  let allSubjects = null;
  async function openClassSubjects(cls) {
    const panel = openContentPanel({ title: `${cls.name} — subjects`, html: skeleton(3, { avatar: false }) });
    try { allSubjects ??= await getSubjects(); } catch (err) {
      panel.innerHTML = errorState(friendlyError(err));
      return;
    }
    const render = () => {
      const taken = new Set((cls.subjects || []).map((x) => x.id));
      panel.innerHTML = `
        <p class="field-hint" style="margin-top:0">Teachers of ${esc(cls.name)} can set work in these subjects. With none set, they can use any subject.</p>
        ${(cls.subjects || []).length ? cls.subjects.map((x) => `
          <div class="task-row"><div style="flex:1"><b>${esc(x.name)}</b></div>
            <div class="roster-actions"><button type="button" class="danger" data-rm-subject="${esc(x.id)}">Remove</button></div></div>`).join("")
          : `<div class="empty-state">No subjects yet.</div>`}
        ${allSubjects.every((x) => taken.has(x.id)) ? `<p class="field-hint">This class takes every subject on the list.</p>` : `
        <form class="fill-form" data-add-subject style="display:flex;gap:.6rem;align-items:flex-end;margin-top:.8rem;flex-wrap:wrap">
          <div class="field" style="margin:0;flex:1;min-width:12rem"><label for="cs_add">Add a subject</label>
            <select id="cs_add">${allSubjects.filter((x) => !taken.has(x.id)).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></div>
          <button class="btn btn-primary" type="submit">Add</button>
        </form>`}`;
    };
    render();
    const refresh = async () => {
      await loadClasses();
      cls = classes.find((x) => x.id === cls.id) || cls;
      render();
    };
    panel.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-rm-subject]");
      if (!btn) return;
      try { await removeClassSubject(cls.id, btn.dataset.rmSubject); await refresh(); }
      catch (err) { toast("Couldn't remove it", friendlyError(err), "error"); }
    });
    panel.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = panel.querySelector("#cs_add")?.value;
      if (!id) return;
      try { await addClassSubject(cls.id, id); await refresh(); }
      catch (err) { toast("Couldn't add it", friendlyError(err), "error"); }
    });
  }

  $("#classManager").addEventListener("click", async (e) => {
    const editBtn = e.target.closest("[data-edit-class]");
    if (editBtn) { openEditClass(classes.find((c) => c.id === editBtn.dataset.editClass)); return; }
    const subjBtn = e.target.closest("[data-subjects]");
    if (subjBtn) { openClassSubjects(classes.find((c) => c.id === subjBtn.dataset.subjects)); return; }
    const archiveBtn = e.target.closest("[data-archive-class]");
    if (archiveBtn) {
      const cls = classes.find((c) => c.id === archiveBtn.dataset.archiveClass);
      if (!(await confirmDialog({ title: `Archive ${cls.name}?`, body: "It disappears from this year's class lists. Its records are kept.", confirmLabel: "Archive class", danger: true }))) return;
      try { await updateClass(cls.id, { archived: true }); toast("Class archived", "", "success"); loadClasses(); }
      catch (err) { toast("Couldn't archive the class", friendlyError(err), "error"); }
      return;
    }
    const promoteBtn = e.target.closest("[data-promote]");
    if (!promoteBtn) return;
    const from = classes.find((c) => c.id === promoteBtn.dataset.promote);
    const next = nextGrade(from.grade);
    const targets = next ? classes.filter((c) => c.grade === next) : [];
    const panel = openContentPanel({
      title: `Promote ${from.name}`,
      html: next
        ? (targets.length
          ? `<form class="fill-form" data-promote-form style="max-width:30rem">
               <p class="field-hint" style="margin-top:0">All ${from.learnerCount} active learner${from.learnerCount === 1 ? "" : "s"} in ${esc(from.name)} move up to ${esc(next)}. Their time in ${esc(from.name)} is kept in their history.</p>
               <div class="field"><label for="pr_to">Into class</label><select id="pr_to">${targets.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select></div>
               <div style="display:flex;gap:.6rem"><button class="btn btn-primary" type="submit">Promote to ${esc(next)}</button></div>
             </form>`
          : `<div class="empty-state"><b>Add a ${esc(next)} class first</b><div>Learners in ${esc(from.grade)} move up to ${esc(next)}. Create that class above, then promote.</div></div>`)
        : `<form class="fill-form" data-promote-form style="max-width:30rem">
             <p class="field-hint" style="margin-top:0">${esc(from.grade)} is the last grade. All ${from.learnerCount} active learner${from.learnerCount === 1 ? "" : "s"} will be marked as having completed school. Their records are kept.</p>
             <button class="btn btn-primary" type="submit">Mark as completed</button>
           </form>`,
    });
    panel.querySelector("[data-promote-form]")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = ev.target.querySelector("[type=submit]");
      btn.disabled = true;
      try {
        const res = await promoteClass(from.id, { toClassId: panel.querySelector("#pr_to")?.value });
        toast(res.promoted ? "Class promoted" : "Learners completed", res.promoted ? `${res.promoted} learner(s) moved up to ${next}.` : `${res.completed} learner(s) marked as completed.`, "success");
        closeViewer();
        loadClasses();
        loadPast();
      } catch (err) {
        btn.disabled = false;
        toast("Couldn't promote the class", friendlyError(err), "error");
      }
    });
  });

  /* ---- the school roster ---- */
  async function loadRoster() {
    $("#schoolRoster").innerHTML = skeleton(4);
    const classId = $("#srClass").value;
    try {
      roster = await getLearners({ status: $("#srStatus").value, classId: classId && classId !== "none" ? classId : "" });
      if (classId === "none") roster = roster.filter((l) => !l.classId);
    } catch (err) {
      $("#schoolRoster").innerHTML = errorState(friendlyError(err), loadRoster);
      return;
    }
    renderRoster();
  }
  function renderRoster() {
    const q = $("#srSearch").value.trim().toLowerCase();
    const rows = roster.filter((l) => !q || [l.fullName, l.username, l.learnerCode, l.userCode].some((v) => (v || "").toLowerCase().includes(q)));
    $("#rosterMeta").textContent = `${rows.length} learner${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) {
      $("#schoolRoster").innerHTML = emptyState(roster.length ? "No matches" : "No learners here", roster.length ? "Try another search." : "Teachers add learners from their dashboard; they appear here straight away.");
      return;
    }
    const classOptions = (current) => `<option value="">Not in a class</option>${classes.map((c) =>
      `<option value="${esc(c.id)}"${c.id === current ? " selected" : ""}>${esc(c.name)}</option>`).join("")}`;
    $("#schoolRoster").innerHTML = rows.map((l) => {
      const active = l.status === "ACTIVE";
      return `
      <div class="task-row" data-learner="${esc(l.id)}" style="flex-wrap:wrap">
        <div style="flex:1;min-width:12rem">
          <b>${esc(l.fullName)}</b>
          <span>${statusPill(l.status)} <span class="code-chip">${esc(l.learnerCode || l.userCode || "")}</span> @${esc(l.username)} · ${esc(l.grade || "no grade")}${l.currentTeacherName ? ` · ${esc(l.currentTeacherName)}` : ""}${!active && l.exitReason ? ` · ${esc(l.exitReason)}` : ""}</span>
        </div>
        ${active ? `<label class="field" style="margin:0;min-width:11rem"><span class="hint-inline">Class</span><select data-move="${esc(l.id)}">${classOptions(l.classId)}</select></label>` : ""}
        <div class="roster-actions">
          <button type="button" data-history="${esc(l.id)}">History</button>
          ${active ? `<button type="button" class="danger" data-archive="${esc(l.id)}">Archive</button>` : `<button type="button" data-reactivate="${esc(l.id)}">Reactivate</button>`}
        </div>
      </div>`;
    }).join("");
  }
  $("#srSearch").addEventListener("input", renderRoster);
  $("#srStatus").addEventListener("change", loadRoster);
  $("#srClass").addEventListener("change", loadRoster);

  $("#schoolRoster").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-move]");
    if (!sel) return;
    const l = roster.find((x) => x.id === sel.dataset.move);
    sel.disabled = true;
    try {
      await updateLearner(l.id, { classId: sel.value || null });
      toast("Learner moved", sel.value ? `${l.fullName} is now in ${classes.find((c) => c.id === sel.value)?.name}.` : `${l.fullName} is no longer in a class.`, "success");
      loadClasses();
      loadRoster();
    } catch (err) {
      sel.disabled = false;
      toast("Couldn't move the learner", friendlyError(err), "error");
    }
  });
  $("#schoolRoster").addEventListener("click", async (e) => {
    const h = e.target.closest("[data-history]");
    if (h) { const l = roster.find((x) => x.id === h.dataset.history); openHistoryPanel(l.id, l.fullName); return; }
    const a = e.target.closest("[data-archive]");
    if (a) {
      const l = roster.find((x) => x.id === a.dataset.archive);
      if (await openArchiveDialog(l)) { loadRoster(); loadClasses(); loadPast(); }
      return;
    }
    const r = e.target.closest("[data-reactivate]");
    if (r) {
      const l = roster.find((x) => x.id === r.dataset.reactivate);
      r.disabled = true;
      try {
        await setLearnerStatus(l.id, "ACTIVE");
        toast("Learner reactivated", `${l.fullName} is back on the roster and can sign in.`, "success");
        loadRoster();
        loadClasses();
      } catch (err) {
        r.disabled = false;
        toast("Couldn't reactivate", friendlyError(err), "error");
      }
    }
  });

  /* ---- past learners: every closed enrollment at this school ---- */
  async function loadPast() {
    let rows;
    try {
      rows = await getEnrollments({ status: "past" });
    } catch (err) {
      $("#pastLearners").innerHTML = errorState(friendlyError(err), loadPast);
      return;
    }
    const fmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString() : "");
    $("#pastLearners").innerHTML = rows.length
      ? rows.map((e) => `
        <div class="task-row">
          <div style="flex:1;min-width:0"><b>${esc(e.learnerName || "Learner")}</b>
            <span><span class="code-chip">${esc(e.learnerCode || "")}</span> ${esc(e.className || e.grade || "")} · ${esc(fmt(e.enrollmentDate))} – ${esc(fmt(e.exitDate))}${e.exitReason ? ` · ${esc(e.exitReason)}` : ""}</span></div>
          ${statusPill(e.status)}
        </div>`).join("")
      : emptyState("No past learners yet", "When learners move school, are promoted out of a class or leave, their record stays here.");
  }

  loadClasses();
  loadRoster();
  loadPast();

}
main();

async function doSignOut() {
  if ((await signOut()) === false) return;
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
