import "./nav.js";
import { $, $$, esc, initials, formatDuration, groupByType, skeleton, emptyState, errorState, friendlyError, toast } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { normalizeLibraryAudience, CONTENT_TYPES } from "./data.js";
import {
  getForms, getResponses, addResponse, getLibrary, libraryFilesHtml, getMyLibraryUsage,
  getSchoolOverview,
} from "./store.js";

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
  $("#sideMeta").textContent = `School Leader · ${user.county || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  $("#topSub").textContent = `${user.school || "No school set"} · Term 2, 2026`;

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

  function renderLearningActivity() {
    const { assignmentsTotal: total, assignmentsDone: done } = overview;
    $("#learningActivity").innerHTML = total
      ? `<div class="chart-stats" style="grid-template-columns:repeat(2,1fr)">
           <div><b>${Math.round((done / total) * 100)}%</b><span>Assignments completed</span></div>
           <div><b>${done}/${total}</b><span>across the school</span></div>
         </div>`
      : `<div class="empty-state">No assignments recorded yet.</div>`;
  }

  function gradeRow({ grade, learners, assignmentsTotal, assignmentsDone }, withCompletion) {
    const pct = assignmentsTotal ? Math.round((assignmentsDone / assignmentsTotal) * 100) : 0;
    return `
      <div class="class-row">
        <div class="class-swatch" style="background:var(--brand)">${esc(gradeCode(grade))}</div>
        <div class="class-info"><b>${esc(grade)}</b><span>${learners} learner${learners === 1 ? "" : "s"}${withCompletion ? ` · ${assignmentsDone}/${assignmentsTotal} assignments done` : ""}</span>
          ${withCompletion ? `<div class="class-bar"><i style="width:${pct}%"></i></div>` : ""}</div>
        ${withCompletion ? `<div class="class-meta"><b>${pct}%</b>complete</div>` : ""}
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
        items.push({ tone: "warn", title: "Low learning activity", detail: `Only ${Math.round(rate * 100)}% of assignments are completed across the school so far.` });
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

    $("#formsList").innerHTML = formsCache.length
      ? formsCache.map((f) => {
          const done = new Set(responsesCache.filter((r) => r.respondentId === user.id).map((r) => r.formId)).has(f.id);
          return `
            <div class="form-card">
              <div class="fc-head"><h3>${esc(f.title)}</h3>${done ? `<span class="pill ok">Submitted</span>` : `<span class="pill warm">Pending</span>`}</div>
              <div class="fc-meta">${f.description ? esc(f.description) : "From " + esc(f.createdBy)}</div>
              ${done ? "" : `<button class="btn btn-outline" type="button" data-fill-form="${esc(f.id)}">Fill out</button>
                <div class="fill-form" id="fill-${esc(f.id)}" hidden></div>`}
            </div>`;
        }).join("")
      : emptyState("No forms yet", "The Education Team hasn't sent anything here.");

    $$("[data-fill-form]").forEach((btn) =>
      btn.addEventListener("click", () => openFormFill(btn.dataset.fillForm, formsCache, btn))
    );
  }

  function openFormFill(formId, forms, btn) {
    const form = forms.find((f) => f.id === formId);
    const box = $("#fill-" + formId);
    if (!form || !box) return;
    btn.hidden = true;
    box.hidden = false;
    box.innerHTML = form.questions.map((q) => `
      <div class="field">
        <label>${esc(q.prompt)}</label>
        ${q.type === "rating"
          ? `<select data-q="${esc(q.id)}"><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3" selected>3 — Okay</option><option value="2">2 — Weak</option><option value="1">1 — Poor</option></select>`
          : `<input type="text" data-q="${esc(q.id)}" placeholder="Your answer">`}
      </div>`).join("") +
      `<button class="btn btn-primary btn-block" type="button" id="submit-${esc(formId)}">Submit feedback</button>`;

    $("#submit-" + formId).addEventListener("click", async () => {
      const submitBtn = $("#submit-" + formId);
      submitBtn.disabled = true;
      submitBtn.classList.add("is-saving");
      submitBtn.textContent = "Saving…";
      const answers = form.questions.map((q) => ({
        questionId: q.id,
        value: box.querySelector(`[data-q="${q.id}"]`).value,
      }));
      try {
        await addResponse({
          id: "resp_" + Date.now().toString(36),
          formId: form.id,
          respondentId: user.id,
          respondentName: user.fullName,
          respondentRole: "school_leader",
          answers,
        });
        toast("Feedback submitted successfully.", "", "success");
        renderForms();
      } catch (err) {
        console.error("could not submit form response:", err);
        toast("Couldn't submit that", friendlyError(err), "error");
        submitBtn.disabled = false;
        submitBtn.classList.remove("is-saving");
        submitBtn.textContent = "Submit feedback";
      }
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
    let library;
    try {
      library = await getLibrary();
    } catch (err) {
      console.error("could not load library:", err);
      const msg = errorState(friendlyError(err), renderLibraryShelves);
      $("#resourceList").innerHTML = msg;
      $("#libraryList").innerHTML = msg;
      $("#headOnlyList").innerHTML = msg;
      $("#leadershipResources").innerHTML = msg;
      return;
    }
    const row = (l) => `
      <div class="task-row"><div><b>${esc(l.title)}</b><span>${esc(l.subject)}${
        l.description ? " — " + esc(l.description) : ""}</span>${libraryFilesHtml(l)}</div></div>`;
    const folders = (list) => groupByType(list, CONTENT_TYPES).map(({ type, items }) => `
      <div class="list-group">
        <div class="list-group-title">${esc(type)}<span class="count">${items.length}</span></div>
        ${items.map(row).join("")}
      </div>`).join("");
    const resources = library.filter((l) => normalizeLibraryAudience(l.audience) === "staff");
    const shared = library.filter((l) => normalizeLibraryAudience(l.audience) === "library");
    const headOnly = library.filter((l) => normalizeLibraryAudience(l.audience) === "school_leader");
    $("#resourceList").innerHTML = resources.length
      ? folders(resources)
      : `<div class="empty-state">No teacher resources uploaded yet.</div>`;
    $("#libraryList").innerHTML = shared.length
      ? folders(shared)
      : `<div class="empty-state">Nothing in the library yet.</div>`;
    $("#headOnlyList").innerHTML = headOnly.length
      ? folders(headOnly)
      : `<div class="empty-state">Nothing addressed to school heads yet.</div>`;
    $("#leadershipResources").innerHTML = headOnly.length
      ? headOnly.slice(0, 5).map(row).join("") + (headOnly.length > 5 ? `<p class="hint" style="margin-top:.4rem">+${headOnly.length - 5} more — view all.</p>` : "")
      : `<div class="empty-state">Nothing addressed to school heads yet.</div>`;
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
}
main();

async function doSignOut() {
  await signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
