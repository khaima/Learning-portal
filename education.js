import { $, esc, initials } from "./util.js";
import { requireRole, signOut, allUsers } from "./auth.js";
import {
  ROLES, CONTENT_TYPES, LIBRARY_SUBJECTS, LIBRARY_AUDIENCES, FORM_AUDIENCES, QUESTION_TYPES,
} from "./data.js";
import { getLibrary, addLibraryItem, getForms, addForm, getResponses } from "./store.js";
import { supabase } from "./supabase.js";

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
const AUDIENCE_LABEL = Object.fromEntries(FORM_AUDIENCES.map((a) => [a.value, a.label]));
const LIBRARY_AUDIENCE_LABEL = Object.fromEntries(LIBRARY_AUDIENCES.map((a) => [a.value, a.label]));

const ICON = {
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  forms: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  responses: '<path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M9 13l2 2 4-4"/>',
  progress: '<path d="M12 20V10M18 20V4M6 20v-6"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;

const user = requireRole("education_team");
if (user) {
  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = "Education Team";
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;

  /* ------------------------------------------------------------ live org-wide stats
     Reads every account actually recorded in the real database (auth.js)
     plus what each has produced there — real cross-account aggregation
     from the database, not a fixed number. A field report filed on the
     Field Officer dashboard, or an assignment marked done on the Learner
     dashboard, changes what shows up here on the next load — from any
     browser or device, not just the one that filed it. */
  async function renderStats() {
    $("#statRow").innerHTML = `<div class="empty-state">Loading…</div>`;
    const users = await allUsers();
    const counts = { teacher: 0, learner: 0, school_leader: 0, field_officer: 0, education_team: 0 };
    users.forEach((u) => { if (counts[u.role] !== undefined) counts[u.role]++; });

    const [assignmentsRes, reportsRes, forms, responses] = await Promise.all([
      supabase.from("assignments").select("done"),
      supabase.from("field_reports").select("id", { count: "exact", head: true }),
      getForms(),
      getResponses(),
    ]);
    const assignments = assignmentsRes.data || [];
    const assignmentsTotal = assignments.length;
    const assignmentsDone = assignments.filter((a) => a.done).length;
    const reportsFiled = reportsRes.count || 0;

    $("#statRow").innerHTML = `
      <div class="stat-tile"><div class="s-label">${svg(ICON.progress)}Accounts</div><div class="s-num">${users.length}</div>
        <div class="s-sub">${counts.teacher} teachers · ${counts.learner} learners · ${counts.school_leader} leaders · ${counts.field_officer} officers</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.responses)}Assignments done</div><div class="s-num">${assignmentsDone}/${assignmentsTotal}</div>
        <div class="s-sub">across all learner accounts</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.forms)}Field reports filed</div><div class="s-num">${reportsFiled}</div>
        <div class="s-sub">across all field officer accounts</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.library)}Forms & responses</div><div class="s-num">${forms.length} / ${responses.length}</div>
        <div class="s-sub">sent / received</div></div>
    `;
  }

  /* ------------------------------------------------------------ content library */
  $("#up_subject").innerHTML = LIBRARY_SUBJECTS.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#up_type").innerHTML = CONTENT_TYPES.map((t) => `<option>${esc(t)}</option>`).join("");
  $("#up_audience").innerHTML = LIBRARY_AUDIENCES.map((a) => `<option value="${a.value}">${esc(a.label)}</option>`).join("");

  async function renderLibrary() {
    $("#libraryList").innerHTML = `<div class="empty-state">Loading…</div>`;
    const items = await getLibrary();
    $("#libraryList").innerHTML = items.length
      ? items.map((it) => `
        <div class="task-row">
          <span class="task-dot" style="background:var(--brand);margin-top:.55rem"></span>
          <div style="flex:1">
            <b>${esc(it.title)}</b>
            <span>${esc(it.subject)} · ${esc(it.type)}${it.description ? " — " + esc(it.description) : ""}</span>
          </div>
          <span class="pill">${esc(LIBRARY_AUDIENCE_LABEL[it.audience] || "Teachers & Learners")}</span>
        </div>`).join("")
      : `<div class="empty-state">Nothing uploaded yet.</div>`;
  }

  $("#uploadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#up_title").value.trim();
    if (!title) return;
    const submitBtn = e.target.querySelector("[type=submit]");
    submitBtn.disabled = true;
    await addLibraryItem({
      id: "lib_" + Date.now().toString(36),
      title,
      subject: $("#up_subject").value,
      type: $("#up_type").value,
      audience: $("#up_audience").value,
      description: $("#up_desc").value.trim(),
      uploadedBy: user.fullName,
    });
    submitBtn.disabled = false;
    e.target.reset();
    $("#up_subject").value = LIBRARY_SUBJECTS[0];
    $("#up_type").value = CONTENT_TYPES[0];
    $("#up_audience").value = LIBRARY_AUDIENCES[0].value;
    renderLibrary();
  });

  /* ------------------------------------------------------------ form builder */
  $("#fb_audience").innerHTML = FORM_AUDIENCES.map((a) => `<option value="${a.value}">${esc(a.label)}</option>`).join("");

  const questionRows = $("#questionRows");
  function addQuestionRow() {
    const row = document.createElement("div");
    row.className = "qrow";
    row.innerHTML = `
      <div class="field"><input type="text" class="q-prompt" placeholder="Question"></div>
      <select class="q-type">${QUESTION_TYPES.map((q) => `<option value="${q.value}">${esc(q.label)}</option>`).join("")}</select>
      <button type="button" class="qrow-remove" aria-label="Remove question">&times;</button>
    `;
    row.querySelector(".qrow-remove").addEventListener("click", () => {
      if (questionRows.children.length > 1) row.remove();
    });
    questionRows.appendChild(row);
  }
  addQuestionRow();
  $("#addQuestion").addEventListener("click", addQuestionRow);

  $("#formBuilder").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#fb_title").value.trim();
    if (!title) return;
    const questions = [...questionRows.querySelectorAll(".qrow")]
      .map((row, i) => ({
        id: "q" + (i + 1),
        type: row.querySelector(".q-type").value,
        prompt: row.querySelector(".q-prompt").value.trim(),
      }))
      .filter((q) => q.prompt);
    if (!questions.length) return;

    const submitBtn = e.target.querySelector("[type=submit]");
    submitBtn.disabled = true;
    await addForm({
      id: "form_" + Date.now().toString(36),
      title,
      description: $("#fb_desc").value.trim(),
      audience: $("#fb_audience").value,
      createdBy: user.fullName,
      questions,
    });
    submitBtn.disabled = false;

    e.target.reset();
    questionRows.innerHTML = "";
    addQuestionRow();
    renderForms();
    renderStats();
  });

  /* ------------------------------------------------------------ forms & feedback */
  async function renderForms() {
    $("#formsList").innerHTML = `<div class="empty-state">Loading…</div>`;
    const [forms, responses] = await Promise.all([getForms(), getResponses()]);
    $("#formsList").innerHTML = forms.length
      ? forms.map((f) => {
          const answers = responses.filter((r) => r.formId === f.id);
          const qBlocks = f.questions.map((q) => {
            const qAnswers = answers.map((r) => r.answers.find((a) => a.questionId === q.id)).filter(Boolean);
            if (q.type === "rating") {
              const nums = qAnswers.map((a) => Number(a.value)).filter((n) => !Number.isNaN(n));
              const avg = nums.length ? (nums.reduce((s, n) => s + n, 0) / nums.length).toFixed(1) : null;
              return `<div class="fc-q"><b>${esc(q.prompt)}</b>${
                avg ? `<span class="fc-avg">${avg}</span> / 5 avg · ${nums.length} response(s)`
                    : `<span style="color:var(--ink-soft);font-size:.82rem">No responses yet</span>`
              }</div>`;
            }
            return `<div class="fc-q"><b>${esc(q.prompt)}</b>${
              qAnswers.length
                ? qAnswers.map((a) => {
                    const respondent = answers.find((r) => r.answers.includes(a));
                    return `<div class="fc-answer"><b>${esc(respondent.respondentName)}</b>${esc(a.value)}</div>`;
                  }).join("")
                : `<span style="color:var(--ink-soft);font-size:.82rem">No responses yet</span>`
            }</div>`;
          }).join("");
          return `
            <div class="form-card">
              <div class="fc-head"><h3>${esc(f.title)}</h3><span class="pill">${esc(AUDIENCE_LABEL[f.audience] || f.audience)}</span></div>
              <div class="fc-meta">${answers.length} response(s)${f.description ? " · " + esc(f.description) : ""}</div>
              ${qBlocks}
            </div>`;
        }).join("")
      : `<div class="empty-state">No forms created yet.</div>`;
  }

  renderStats();
  renderLibrary();
  renderForms();
}

function doSignOut() {
  signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
