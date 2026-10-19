/* ============================================================
   HPF Digital Learning Portal — assignments, marking and results.

   Shared screens for the teacher dashboard (build an assignment, look
   after it, mark the work, read results), the learner dashboard (open,
   work on and hand in an assignment, see marks) and the school head's.

   Two measures are kept apart on every screen:
     completion  — was the work handed in (on time or late)?
     achievement — the marks earned on work that has been marked.
   Handing work in is never shown as doing well in it.

   The kinds of question — how each is built, answered, read and marked —
   are in question-types.js.

   The API decides who may see or change what; these are only screens.
   ============================================================ */

import { esc, toast, friendlyError, skeleton, errorState, confirmDialog } from "./util.js";
import { marksBins, marksSpread } from "./charts.js";
import { openContentPanel, closeViewer } from "./viewer.js";
import { normalizeLibraryAudience } from "./data.js";
import { getProfile } from "./auth.js";
import {
  QUESTION_GROUPS, TYPE_LABEL, blankQuestion, retype, toEditable, toSaved, editorBody, moreOptions, applyEdit, applyAction,
  promptText, tagsHtml, rubricTable, rubricMarks, responseView, keyText, learnerInput, collectAnswer, isBlank, moveItem,
  afterMarking, chosenLevels,
} from "./question-types.js";
import {
  getSubjects, getLibrary, libraryFilesHtml,
  getAssignment, createAssignment, updateAssignment, setAssignmentStatus, deleteAssignment,
  getSubmission, markSubmission,
  getMyAssignment, startAssignment, saveAssignmentAnswers, submitAssignment, uploadAnswerFile,
} from "./store.js";

export const STATUS_LABEL = { draft: "Draft", published: "Published", closed: "Closed" };
export const COMPLETION_LABEL = { not_started: "Not started", in_progress: "In progress", submitted: "Handed in", marked: "Marked" };

/* ------------------------------------------------------------ small helpers */

export const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, {
  weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
}) : "");
/** "Handed in …" — with the device's time when it was handed in offline. */
export const handedInText = (s) => !s?.submittedAt ? "" : s.offlineSubmittedAt
  ? `Handed in offline ${fmtWhen(s.offlineSubmittedAt)}${s.offlineSubmittedAt !== s.submittedAt ? ` (received ${fmtWhen(s.submittedAt)})` : ""}`
  : `Handed in ${fmtWhen(s.submittedAt)}`;
const PENDING_NOTE = `<p class="sync-note"><i class="sync-dot" aria-hidden="true"></i> Saved on this device — waiting to sync. It's sent automatically when you're back online.</p>`;

export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const num = (v) => (v == null ? "—" : String(Math.round(v * 100) / 100));
/** ISO → the value a datetime-local input wants (local time). */
const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export function assignmentStatusPill(status) {
  const cls = status === "published" ? "ok" : status === "closed" ? "warm" : "";
  return `<span class="pill ${cls}">${esc(STATUS_LABEL[status] || status)}</span>`;
}
/** Where a learner is with a piece of work — a completion state, not a score. */
export function completionPill(completion, { late = false, overdue = false } = {}) {
  if (completion === "marked") return `<span class="pill ok">Marked</span>${late ? ' <span class="pill warm">Late</span>' : ""}`;
  if (completion === "submitted") return `<span class="pill ok">Handed in</span>${late ? ' <span class="pill warm">Late</span>' : ""}`;
  if (overdue) return `<span class="pill danger">Overdue</span>`;
  if (completion === "in_progress") return `<span class="pill warm">In progress</span>`;
  return `<span class="pill">Not started</span>`;
}
/** A mark: percentage and band (achievement). */
export function markPill(percentage, band) {
  if (percentage == null) return "";
  return `<span class="pill band-pill band-${esc(band || "")}">${pct(percentage)}${band ? ` · ${esc(band)}` : ""}</span>`;
}

/* ------------------------------------------------------------ results table */

const BY_LABEL = {
  learner: "Learner", class: "Class", subject: "Subject", grade: "Grade", term: "Term",
  year: "School year", school: "School", assignment: "Assignment",
};

/** Completion and achievement side by side, under their own headings. */
export function resultsTableHtml(data) {
  if (!data?.rows?.length) {
    return `<div class="empty-state">No results yet — they appear once published work is due or handed in.</div>`;
  }
  // By learner: how their marks spread, above the table (each learner's average on marked work, in tens).
  const marked = data.by === "learner" ? data.rows.filter((r) => r.achievement.marked && r.achievement.averagePercent != null) : [];
  const spread = marked.length ? `<div class="results-spread"><div class="chart-subhead">Learners' average marks · ${marked.length} with marked work</div>
    ${marksSpread(marksBins(marked.map((r) => r.achievement.averagePercent), data.bands || []), data.bands || [])}</div>` : "";
  const bandsKey = (data.bands || []).map((b) => `<b>${esc(b.code)}</b> ${esc(b.label)} (${b.minPercent}%+)`).join(" · ");
  const row = (label, r, tag = "td") => `
    <tr>
      <${tag === "th" ? "th" : "td"} class="lms-name">${label}</${tag === "th" ? "th" : "td"}>
      <td>${r.completion.assigned}</td><td>${r.completion.submitted}</td><td>${r.completion.late}</td><td>${r.completion.missing}</td>
      <td class="lms-strong">${pct(r.completion.rate)}</td>
      <td class="lms-gap">${r.achievement.marked}</td><td class="lms-strong">${pct(r.achievement.averagePercent)}</td>
      <td>${r.achievement.band ? esc(r.achievement.band) : "—"}</td>
    </tr>`;
  return `${spread}
    <div class="lms-table-wrap">
      <table class="lms-table">
        <thead>
          <tr><th rowspan="2">${esc(BY_LABEL[data.by] || "")}</th>
            <th colspan="5" class="lms-group">Completion — work handed in</th>
            <th colspan="3" class="lms-group lms-gap">Achievement — marks on marked work</th></tr>
          <tr><th>Expected</th><th>Handed in</th><th>Late</th><th>Missing</th><th>Rate</th>
            <th class="lms-gap">Marked</th><th>Average</th><th>Band</th></tr>
        </thead>
        <tbody>${data.rows.map((r) => row(esc(r.label), r)).join("")}</tbody>
        ${data.rows.length > 1 && data.overall ? `<tfoot>${row("All", data.overall, "th")}</tfoot>` : ""}
      </table>
    </div>
    <p class="field-hint">The average counts marked work only — missing work isn't scored as 0.${bandsKey ? `<br>Bands: ${bandsKey}` : ""}</p>`;
}

/* ------------------------------------------------------------ teacher: build / edit an assignment */

function questionCardHtml(q, i, total) {
  const typeOpts = QUESTION_GROUPS.map(([group, list]) => `<optgroup label="${esc(group)}">${list.map(([v, l]) =>
    `<option value="${v}"${v === q.type ? " selected" : ""}>${esc(l)}</option>`).join("")}</optgroup>`).join("");
  return `
    <div class="q-card" data-q="${i}">
      <div class="q-head">
        <b>Question ${i + 1}</b>
        <select data-f="type" aria-label="Question type">${typeOpts}</select>
        <label class="q-marks">Marks <input type="number" data-f="maxMarks" min="0.5" max="1000" step="0.5" value="${esc(q.maxMarks)}"></label>
        <span class="q-tools">
          ${i > 0 ? `<button type="button" class="q-icon" data-act="up" aria-label="Move question ${i + 1} up">↑</button>` : ""}
          ${i < total - 1 ? `<button type="button" class="q-icon" data-act="down" aria-label="Move question ${i + 1} down">↓</button>` : ""}
          <button type="button" class="q-icon danger" data-act="remove" aria-label="Remove question ${i + 1}">✕</button>
        </span>
      </div>
      <textarea data-f="prompt" rows="2" maxlength="2000" aria-label="Question ${i + 1}" placeholder="${q.type === "fill_blanks"
        ? "Write the sentence, with each answer in [brackets]…" : q.type === "rubric" ? "Describe the task — what learners make, do or say…" : "Write the question…"}">${esc(q.prompt)}</textarea>
      ${editorBody(q, i)}
      ${moreOptions(q)}
    </div>`;
}
/** A focus target after adding a part: the new part's text box. */
const NEW_PART = { "add-opt": "[data-opt]", "add-left": "[data-left]", "add-right": "[data-right]", "add-step": "[data-step]", "add-crit": "[data-crit]" };

/** Create (existing = null) or edit an assignment. `classes` are the
    classes this teacher teaches (with their subjects); `terms` the school
    year's terms. Resolves to the saved detail, or null. */
export async function openAssignmentEditor({ classes, terms = [], existing = null, defaultClassId = "" }) {
  let onClosed = () => {};
  const panel = openContentPanel({ title: existing ? `Edit: ${existing.assignment.title}` : "New assignment", html: skeleton(5) }, () => onClosed());
  let subjects = [], library = [];
  try {
    [subjects, library] = await Promise.all([getSubjects(), getLibrary().catch(() => [])]);
  } catch (err) {
    panel.innerHTML = errorState(friendlyError(err));
    return null;
  }
  library = library.filter((l) => normalizeLibraryAudience(l.audience) === "library");
  const a = existing?.assignment;
  const locked = !!a && a.status !== "draft"; // questions and class are fixed once learners have it
  let questions = existing
    ? existing.questions.map(toEditable)
    : [blankQuestion()];

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    onClosed = () => finish(null);
    panel.innerHTML = `
      <form class="fill-form lms-editor" novalidate>
        <div class="lms-grid3">
          <div class="field"><label for="ae_class">Class</label>
            <select id="ae_class" ${locked ? "disabled" : ""}>${classes.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.grade)})</option>`).join("")}</select></div>
          <div class="field"><label for="ae_subject">Subject</label><select id="ae_subject"></select></div>
          <div class="field"><label for="ae_term">Term</label>
            <select id="ae_term"><option value="">From the start date</option>${terms.map((t) => `<option value="${esc(t.id)}">${esc(t.label || t.id)}</option>`).join("")}</select></div>
        </div>
        <div class="field"><label for="ae_title">Title</label><input id="ae_title" type="text" maxlength="200" required value="${esc(a?.title || "")}"></div>
        <div class="field"><label for="ae_desc">Description <span class="hint-inline">— what it's about</span></label><textarea id="ae_desc" rows="2" maxlength="5000">${esc(a?.description || "")}</textarea></div>
        <div class="field"><label for="ae_instr">Instructions <span class="hint-inline">— what learners should do</span></label><textarea id="ae_instr" rows="3" maxlength="10000">${esc(a?.instructions || "")}</textarea></div>
        <div class="lms-grid3">
          <div class="field"><label for="ae_start">Opens <span class="hint-inline">— optional</span></label><input id="ae_start" type="datetime-local" value="${toLocalInput(a?.startsAt)}"></div>
          <div class="field"><label for="ae_due">Due</label><input id="ae_due" type="datetime-local" value="${toLocalInput(a?.dueAt)}"></div>
          <div class="field"><label for="ae_mins">Estimated time (minutes)</label><input id="ae_mins" type="number" min="1" max="1440" value="${esc(a?.estimatedMinutes ?? "")}"></div>
        </div>
        <div class="field"><label for="ae_res">Attached resource <span class="hint-inline">— optional, from the Digital Library</span></label>
          <select id="ae_res"><option value="">None</option>${library.map((l) => `<option value="${esc(l.id)}">${esc(l.title)}${l.subject ? ` · ${esc(l.subject)}` : ""}</option>`).join("")}</select></div>
        <div class="panel-head" style="margin-top:.4rem"><h3 style="margin:0">Questions</h3><span class="hint-inline" data-total></span></div>
        ${locked ? `<p class="field-hint" style="margin-top:0">Questions can't change once learners have the assignment — the marks they're working towards stay fixed.</p>` : ""}
        <div data-questions></div>
        ${locked ? "" : `<button type="button" class="btn btn-outline" data-act="add-q" style="margin:.2rem 0 1rem">+ Add question</button>`}
        <div class="field-error" data-error hidden></div>
        <div class="lms-actions">
          <button class="btn btn-primary" type="submit" data-publish="0">${a ? "Save changes" : "Save as draft"}</button>
          ${!a || a.status === "draft" ? `<button class="btn btn-outline" type="submit" data-publish="1">Save and publish</button>` : ""}
          <button class="btn btn-ghost" type="button" data-cancel>Cancel</button>
        </div>
      </form>`;
    const form = panel.querySelector("form");
    const qBox = panel.querySelector("[data-questions]");
    const err = panel.querySelector("[data-error]");
    const classSel = panel.querySelector("#ae_class");
    const subjSel = panel.querySelector("#ae_subject");
    classSel.value = a?.classId || defaultClassId || classes[0]?.id || "";
    panel.querySelector("#ae_term").value = a?.termId || "";
    panel.querySelector("#ae_res").value = a?.resourceId || "";

    function fillSubjects() {
      const cls = classes.find((c) => c.id === classSel.value);
      const list = cls?.subjects?.length ? cls.subjects : subjects;
      const keep = subjSel.value || a?.subjectId || "";
      subjSel.innerHTML = list.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
      if (list.some((s) => s.id === keep)) subjSel.value = keep;
    }
    fillSubjects();
    classSel.addEventListener("change", fillSubjects);

    const totalMarks = () => questions.reduce((t, q) => t + (Number(q.maxMarks) || 0), 0);
    function renderQuestions() {
      if (locked) {
        qBox.innerHTML = existing.questions.map((q, i) => `
          <div class="q-card"><div class="q-head"><b>Question ${i + 1}</b><span class="hint-inline">${esc(TYPE_LABEL[q.type] || q.type)} · ${num(q.maxMarks)} mark${q.maxMarks === 1 ? "" : "s"}</span></div>
          <p style="margin:.2rem 0 0;white-space:pre-wrap">${esc(promptText(q))}</p>${tagsHtml(q)}</div>`).join("");
      } else {
        qBox.innerHTML = questions.length
          ? questions.map((q, i) => questionCardHtml(q, i, questions.length)).join("")
          : `<div class="empty-state">No questions yet — add at least one before publishing.</div>`;
      }
      showTotal();
    }
    const showTotal = () => { panel.querySelector("[data-total]").textContent = `${questions.length} question${questions.length === 1 ? "" : "s"} · ${num(totalMarks())} marks`; };
    renderQuestions();

    if (!locked) {
      // Typing updates the question in place; ticks, choices and new parts draw the card again when they must.
      const onEdit = (e) => {
        const el = e.target;
        const card = el.closest("[data-q]");
        if (!card) return;
        const typing = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type !== "checkbox" && el.type !== "radio");
        if ((e.type === "input") !== typing) return;
        const i = Number(card.dataset.q);
        if (el.dataset.f === "type") { questions[i] = retype(questions[i], el.value); renderQuestions(); return; }
        const did = applyEdit(questions[i], el, card);
        if (did === "render") renderQuestions();
        else if (did === "total") showTotal();
      };
      qBox.addEventListener("input", onEdit);
      qBox.addEventListener("change", onEdit);
      // "More" stays open (or shut) when the card is drawn again.
      qBox.addEventListener("toggle", (e) => {
        const card = e.target.matches?.("details.q-more") && e.target.closest("[data-q]");
        if (card) questions[Number(card.dataset.q)]._open = e.target.open;
      }, true);
      qBox.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-act]");
        const card = btn?.closest("[data-q]");
        if (!card) return;
        const i = Number(card.dataset.q);
        const act = btn.dataset.act;
        const j = Number(btn.dataset.j);
        if (act === "remove") questions.splice(i, 1);
        else if (act === "up" && i > 0) [questions[i - 1], questions[i]] = [questions[i], questions[i - 1]];
        else if (act === "down" && i < questions.length - 1) [questions[i + 1], questions[i]] = [questions[i], questions[i + 1]];
        else if (!applyAction(questions[i], act, j)) return;
        renderQuestions();
        const again = qBox.querySelector(`[data-q="${i}"]`);
        if (NEW_PART[act]) [...(again?.querySelectorAll(NEW_PART[act]) || [])].pop()?.focus();
        else if (act === "step-up" || act === "step-down") again?.querySelector(`[data-step="${act === "step-up" ? j - 1 : j + 1}"]`)?.focus();
      });
      panel.querySelector('[data-act="add-q"]').addEventListener("click", () => {
        questions.push(blankQuestion(questions[questions.length - 1]?.type || "multiple_choice"));
        renderQuestions();
        qBox.lastElementChild?.querySelector("textarea")?.focus();
      });
    }

    panel.querySelector("[data-cancel]").addEventListener("click", () => { closeViewer(); finish(null); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const publish = e.submitter?.dataset.publish === "1";
      const fields = {
        subjectId: subjSel.value,
        termId: panel.querySelector("#ae_term").value || null,
        title: panel.querySelector("#ae_title").value.trim(),
        description: panel.querySelector("#ae_desc").value.trim(),
        instructions: panel.querySelector("#ae_instr").value.trim(),
        startsAt: fromLocalInput(panel.querySelector("#ae_start").value),
        dueAt: fromLocalInput(panel.querySelector("#ae_due").value),
        estimatedMinutes: panel.querySelector("#ae_mins").value ? Number(panel.querySelector("#ae_mins").value) : null,
        resourceId: panel.querySelector("#ae_res").value || null,
      };
      if (!locked) {
        fields.classId = classSel.value;
        fields.questions = questions.map(toSaved);
      }
      if (!fields.termId) delete fields.termId; // let the server pick it from the dates
      const buttons = form.querySelectorAll("button");
      buttons.forEach((b) => { b.disabled = true; });
      try {
        let saved = a ? await updateAssignment(a.id, fields) : await createAssignment(fields);
        if (publish) saved = await setAssignmentStatus(saved.assignment.id, "published");
        toast(publish ? "Published" : "Saved", publish
          ? `${saved.assignment.title} is now open to ${saved.assignment.className || "the class"}.`
          : `${saved.assignment.title} is saved as a ${saved.assignment.status === "draft" ? "draft" : "change"}.`, "success");
        finish(saved); // before closing: closing reports "cancelled" to whoever's waiting
        closeViewer();
      } catch (ex) {
        err.textContent = friendlyError(ex, "Couldn't save the assignment.");
        err.hidden = false;
        // A create that saved but couldn't publish is still a draft: edit from here.
        buttons.forEach((b) => { b.disabled = false; });
      }
    });
  });
}

/* ------------------------------------------------------------ teacher / head: one assignment */

/** The assignment's page: details, questions, and the class roster with
    each learner's work. `canManage` (its teacher) can edit, publish and
    close; `canMark` can open work to mark it. `onChanged` after any change. */
export async function openAssignmentDetail(id, { canManage = false, canMark = false, classes = [], terms = [], onChanged = () => {} } = {}) {
  const panel = openContentPanel({ title: "Assignment", html: skeleton(5) });
  let d;
  try { d = await getAssignment(id); } catch (err) {
    panel.innerHTML = errorState(friendlyError(err), () => openAssignmentDetail(id, { canManage, canMark, classes, terms, onChanged }));
    return;
  }
  const a = d.assignment;
  const c = a.counts || {};
  const canDelete = canManage && a.status === "draft";
  panel.innerHTML = `
    <p class="hint" style="margin-top:0">${assignmentStatusPill(a.status)} ${esc(a.className || "")} · ${esc(a.subject)}${a.term ? ` · ${esc(a.term)}` : ""}
      ${a.dueAt ? ` · due <b>${esc(fmtWhen(a.dueAt))}</b>` : ""}${a.startsAt ? ` · opens ${esc(fmtWhen(a.startsAt))}` : ""}
      ${a.estimatedMinutes ? ` · about ${a.estimatedMinutes} min` : ""} · ${num(a.maxMarks)} mark${a.maxMarks === 1 ? "" : "s"}</p>
    <h2 style="margin:.2rem 0 .4rem">${esc(a.title)}</h2>
    ${a.description ? `<p style="white-space:pre-wrap;margin:.2rem 0">${esc(a.description)}</p>` : ""}
    ${a.instructions ? `<p class="field-hint" style="white-space:pre-wrap"><b>Instructions:</b> ${esc(a.instructions)}</p>` : ""}
    ${a.resourceTitle ? `<p class="field-hint">Attached: ${esc(a.resourceTitle)}</p>` : ""}
    ${canManage ? `<div class="lms-actions" style="margin:.7rem 0">
      <button type="button" class="btn btn-outline" data-do="edit">Edit</button>
      ${a.status === "draft" ? `<button type="button" class="btn btn-primary" data-do="published">Publish</button>` : ""}
      ${a.status === "published" ? `<button type="button" class="btn btn-outline" data-do="closed">Close</button>` : ""}
      ${a.status === "closed" ? `<button type="button" class="btn btn-outline" data-do="published">Reopen</button>` : ""}
      ${a.status === "published" && !c.started ? `<button type="button" class="btn btn-ghost" data-do="draft">Back to draft</button>` : ""}
      ${canDelete ? `<button type="button" class="btn btn-ghost danger" data-do="delete">Delete draft</button>` : ""}
    </div>` : ""}
    ${a.status === "draft" ? "" : `
    <div class="chart-stats" style="grid-template-columns:repeat(4,1fr);margin:.6rem 0">
      <div><b>${c.submitted ?? 0}/${c.expected ?? 0}</b><span>Handed in</span></div>
      <div><b>${c.late ?? 0}</b><span>Late</span></div>
      <div><b>${c.toMark ?? 0}</b><span>To mark</span></div>
      <div><b>${c.marked ?? 0}</b><span>Marked</span></div>
    </div>`}
    <h3 style="margin:1rem 0 .4rem">Questions</h3>
    ${d.questions.length ? d.questions.map((q, i) => `
      <div class="q-card">
        <div class="q-head"><b>${i + 1}.</b><span class="hint-inline">${esc(TYPE_LABEL[q.type] || q.type)} · ${num(q.maxMarks)} mark${q.maxMarks === 1 ? "" : "s"}</span></div>
        <p style="margin:.2rem 0;white-space:pre-wrap">${esc(promptText(q))}</p>
        ${q.type === "multiple_choice" || q.type === "multiple_response" ? `<ol class="q-list q-list-abc">${q.options.map((o) => `<li>${esc(o)}</li>`).join("")}</ol>` : ""}
        ${q.type === "rubric" ? rubricTable(q) : ""}
        <p class="field-hint" style="margin:0">${keyText(q)}</p>
        ${q.meta?.explanation ? `<p class="q-explain"><b>Why:</b> ${esc(q.meta.explanation)}</p>` : ""}
        ${tagsHtml(q)}
      </div>`).join("") : `<div class="empty-state">No questions yet.</div>`}
    ${a.status === "draft" ? "" : `
    <h3 style="margin:1rem 0 .4rem">Learners</h3>
    ${d.roster.length ? d.roster.map((r) => {
      const s = r.submission;
      return `
      <div class="task-row">
        <div style="flex:1;min-width:0"><b>${esc(r.fullName)}</b>
          <span>${r.learnerCode ? `<span class="code-chip">${esc(r.learnerCode)}</span> ` : ""}${completionPill(s?.status || "not_started", { late: s?.isLate, overdue: !s?.submittedAt && a.dueAt && new Date(a.dueAt) < new Date() })}
          ${s?.submittedAt ? ` · ${esc(fmtWhen(s.submittedAt))}` : ""} ${s?.status === "marked" ? markPill(s.percentage, s.band) : ""}</span></div>
        ${s && s.status !== "in_progress" ? `<div class="roster-actions"><button type="button" data-sub="${esc(s.id)}">${s.status === "submitted" && canMark ? "Mark" : "View"}</button></div>` : ""}
      </div>`;
    }).join("") : `<div class="empty-state"><b>Nobody is enrolled in this class yet.</b><div>Learners appear here once they're added to the class.</div></div>`}`}`;

  panel.addEventListener("click", async (e) => {
    const sub = e.target.closest("[data-sub]");
    if (sub) {
      openMarking(sub.dataset.sub, { canMark, onDone: () => { onChanged(); openAssignmentDetail(id, { canManage, canMark, classes, terms, onChanged }); } });
      return;
    }
    const btn = e.target.closest("[data-do]");
    if (!btn) return;
    const what = btn.dataset.do;
    try {
      if (what === "edit") {
        const saved = await openAssignmentEditor({ classes, terms, existing: d });
        if (saved) { onChanged(); openAssignmentDetail(id, { canManage, canMark, classes, terms, onChanged }); }
        return;
      }
      if (what === "delete") {
        if (!(await confirmDialog({ title: "Delete this draft?", body: "Learners have never seen it. This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
        await deleteAssignment(id);
        toast("Draft deleted", "Learners never saw it.", "success");
        closeViewer();
        onChanged();
        return;
      }
      if (what === "closed" && !(await confirmDialog({ title: "Close this assignment?", body: "Learners can no longer start or hand it in. Work already handed in stays, and you can reopen it.", confirmLabel: "Close" }))) return;
      btn.disabled = true;
      await setAssignmentStatus(id, what);
      toast(what === "published" ? "Published" : what === "closed" ? "Closed" : "Back to draft", "", "success");
      onChanged();
      openAssignmentDetail(id, { canManage, canMark, classes, terms, onChanged });
    } catch (err) {
      btn.disabled = false;
      toast({ published: "Couldn't publish it", closed: "Couldn't close it", draft: "Couldn't move it back to draft", delete: "Couldn't delete the draft" }[what]
        || "Couldn't change the assignment", friendlyError(err), "error");
    }
  });
}

/* ------------------------------------------------------------ teacher: mark one learner's work */

export async function openMarking(submissionId, { canMark = false, onDone = () => {} } = {}) {
  const panel = openContentPanel({ title: canMark ? "Mark work" : "Learner's work", html: skeleton(5) });
  let d;
  try { d = await getSubmission(submissionId); } catch (err) {
    panel.innerHTML = errorState(friendlyError(err), () => openMarking(submissionId, { canMark, onDone }));
    return;
  }
  const s = d.submission;
  const answers = Object.fromEntries(d.answers.map((x) => [x.questionId, x]));
  const editable = canMark && s.status !== "in_progress";
  const startMark = (q) => { const x = answers[q.id]; return x?.marks ?? x?.autoMarks ?? (q.autoMarked && !x ? 0 : null); };
  const max = d.questions.reduce((t, q) => t + q.maxMarks, 0);
  panel.innerHTML = `
    <p class="hint" style="margin-top:0"><b>${esc(d.learner?.fullName || "Learner")}</b>${d.learner?.learnerCode ? ` <span class="code-chip">${esc(d.learner.learnerCode)}</span>` : ""}
      · ${esc(d.assignment.title)} · ${esc(d.assignment.subject)}</p>
    ${d.pendingSync ? PENDING_NOTE : ""}
    <p class="hint">${completionPill(s.status, { late: s.isLate })} ${s.submittedAt ? esc(handedInText(s)) : "Not handed in yet"}
      ${s.status === "marked" ? ` · ${markPill(s.percentage, s.band)} · marked ${esc(fmtDay(s.markedAt))} by ${esc(s.markerName || "—")}` : ""}</p>
    <form class="fill-form" data-mark>
      ${d.questions.map((q, i) => {
        const x = answers[q.id];
        const m = startMark(q);
        return `
        <div class="q-card" data-qid="${esc(q.id)}">
          <div class="q-head"><b>${i + 1}.</b><span class="hint-inline">${esc(TYPE_LABEL[q.type] || q.type)} · out of ${num(q.maxMarks)}</span></div>
          ${q.type === "fill_blanks" ? "" : `<p style="margin:.2rem 0;white-space:pre-wrap">${esc(q.prompt)}</p>`}
          <div class="q-answer">${responseView(q, x, { withKey: true })}</div>
          ${q.autoMarked ? `<p class="field-hint" style="margin:.2rem 0">${keyText(q)} · marked automatically${x?.autoMarks != null ? `: ${num(x.autoMarks)}` : ""} — you can change it</p>` : ""}
          ${q.type === "rubric" ? `${editable ? `<p class="field-hint" style="margin:.5rem 0 .2rem">Choose a level for each criterion — the marks follow.</p>` : ""}
            ${rubricTable(q, { chosen: x?.rubric, pick: editable, name: `rb-${q.id}` })}` : ""}
          ${editable ? `
          <div class="lms-grid-mark">
            <div class="field" style="margin:0"><label>Marks (0–${num(q.maxMarks)})</label>
              <input type="number" data-marks min="0" max="${q.maxMarks}" step="any" value="${m ?? ""}" ${q.autoMarked ? "" : "required"}></div>
            <div class="field" style="margin:0"><label>Feedback <span class="hint-inline">— optional</span></label>
              <input type="text" data-fb maxlength="2000" value="${esc(x?.feedback || "")}"></div>
          </div>` : `
          <p class="field-hint" style="margin:.2rem 0">Marks: <b>${m == null ? "—" : num(m)}</b> / ${num(q.maxMarks)}${x?.feedback ? ` · ${esc(x.feedback)}` : ""}</p>`}
        </div>`;
      }).join("")}
      ${editable ? `
      <div class="field"><label for="mk_fb">Feedback for the learner <span class="hint-inline">— optional</span></label>
        <textarea id="mk_fb" rows="3" maxlength="5000">${esc(s.feedback || "")}</textarea></div>
      <p class="hint" data-total></p>
      <div class="field-error" data-error hidden></div>
      <div class="lms-actions">
        <button class="btn btn-primary" type="submit">${s.status === "marked" ? "Update marks" : "Save marks"}</button>
        <button class="btn btn-ghost" type="button" data-cancel>Cancel</button>
      </div>` : s.feedback ? `<p><b>Feedback:</b> ${esc(s.feedback)}</p>` : ""}
    </form>`;
  if (!editable) return;
  const form = panel.querySelector("[data-mark]");
  const totalEl = panel.querySelector("[data-total]");
  const showTotal = () => {
    const vals = [...form.querySelectorAll("[data-marks]")].map((i) => i.value === "" ? null : Number(i.value));
    const got = vals.reduce((t, v) => t + (v || 0), 0);
    const missing = vals.filter((v) => v == null).length;
    totalEl.innerHTML = `Total: <b>${num(got)} / ${num(max)}</b> (${pct(max ? (got / max) * 100 : 0)})${missing ? ` · ${missing} still to mark` : ""}`;
  };
  form.addEventListener("input", showTotal);
  // A rubric's levels fill in its marks.
  const byId = Object.fromEntries(d.questions.map((q) => [q.id, q]));
  form.addEventListener("change", (e) => {
    const pick = e.target.closest("[data-rubric]");
    const card = pick?.closest("[data-qid]");
    if (!card) return;
    for (const td of card.querySelectorAll(".q-rubric td")) td.classList.toggle("is-chosen", !!td.querySelector("input:checked"));
    const q = byId[card.dataset.qid];
    const levels = chosenLevels(card, q);
    if (levels) card.querySelector("[data-marks]").value = rubricMarks(levels, q.maxMarks);
    showTotal();
  });
  showTotal();
  panel.querySelector("[data-cancel]").addEventListener("click", () => closeViewer());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = panel.querySelector("[data-error]");
    err.hidden = true;
    const cards = [...form.querySelectorAll("[data-qid]")];
    // A rubric is all or nothing: a level for every criterion, or none (and the marks typed).
    const half = cards.findIndex((card) => byId[card.dataset.qid].type === "rubric" && card.querySelector("[data-rubric]:checked") && !chosenLevels(card, byId[card.dataset.qid]));
    if (half >= 0) {
      err.textContent = `Question ${half + 1}: choose a level for every criterion.`;
      err.hidden = false;
      cards[half].scrollIntoView({ block: "center" });
      return;
    }
    const body = {
      answers: cards.map((card) => {
        const q = byId[card.dataset.qid];
        const levels = q.type === "rubric" ? chosenLevels(card, q) : null;
        return {
          questionId: card.dataset.qid,
          marks: card.querySelector("[data-marks]").value === "" ? null : Number(card.querySelector("[data-marks]").value),
          feedback: card.querySelector("[data-fb]").value,
          ...(levels ? { rubric: levels } : {}),
        };
      }),
      feedback: panel.querySelector("#mk_fb").value,
    };
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const res = await markSubmission(submissionId, body, {
        baseMarkedAt: s.markedAt ?? null,
        label: `Marks for ${d.learner?.fullName || "a learner"} — “${d.assignment.title}”`,
      });
      if (res.queued) toast("Marks saved on this device", "They're sent when you're back online.", "success");
      else toast("Marked", `${d.learner?.fullName || "Learner"}: ${pct(res.submission.percentage)}${res.submission.band ? ` (${res.submission.band})` : ""}.`, "success");
      closeViewer();
      onDone(res);
    } catch (ex) {
      err.textContent = friendlyError(ex, "Couldn't save the marks.");
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------ learner: do an assignment */

/** What a learner is asked to do, beside the marks. */
const HOW = { multiple_response: "Tick all that apply", matching: "Match each one", ordering: "Put in order", fill_blanks: "Fill in the blanks", numeric: "A number", rubric: "Marked with a rubric" };

function learnerQuestionHtml(q, i, ans, editable, marked, seed) {
  return `
    <div class="q-card" data-qid="${esc(q.id)}" data-type="${esc(q.type)}">
      <div class="q-head"><b>${i + 1}.</b><span class="hint-inline">${HOW[q.type] ? `${HOW[q.type]} · ` : ""}${num(q.maxMarks)} mark${q.maxMarks === 1 ? "" : "s"}</span></div>
      ${q.type === "fill_blanks" ? "" : `<p style="margin:.2rem 0 .5rem;white-space:pre-wrap">${esc(q.prompt)}</p>`}
      ${editable ? learnerInput(q, ans, { seed }) : `<div class="q-answer">${responseView(q, ans)}</div>`}
      ${marked ? `<p class="field-hint" style="margin:.4rem 0 0">Marks: <b>${ans?.marks == null ? "—" : num(ans.marks)}</b> / ${num(q.maxMarks)}${ans?.feedback ? ` · ${esc(ans.feedback)}` : ""}</p>
        ${afterMarking(q, ans)}` : ""}
    </div>`;
}

/** Opens one assignment for the signed-in learner. `onChange` after they
    start, save or hand in, so the lists behind can refresh. */
export async function openLearnerAssignment(id, { onChange = () => {} } = {}) {
  const panel = openContentPanel({ title: "Assignment", html: skeleton(5) });
  let d;
  try { d = await getMyAssignment(id); } catch (err) {
    panel.innerHTML = errorState(friendlyError(err), () => openLearnerAssignment(id, { onChange }));
    return;
  }
  // Shuffled options come in the same order for this learner every time.
  const seed = `${(await getProfile().catch(() => null))?.id || ""}|${id}`;
  // Files picked so far for each file question (kept between saves).
  // (A file chosen offline keeps its pendingUpload reference until it's uploaded at sync.)
  const files = Object.fromEntries(d.answers.map((x) => [x.questionId, (x.files || []).map((f) => ({
    name: f.name, path: f.path, size: f.size, ...(f.pendingUpload ? { pendingUpload: f.pendingUpload } : {}),
  }))]));

  function render() {
    const a = d.assignment;
    const s = d.submission;
    const editable = d.completion === "in_progress" && !d.cannotWork;
    const marked = d.completion === "marked";
    const answers = Object.fromEntries(d.answers.map((x) => [x.questionId, x]));
    const overdue = a.dueAt && new Date(a.dueAt) < new Date() && (!s || s.status === "in_progress");
    panel.innerHTML = `
      <p class="hint" style="margin-top:0">${esc(a.subject)} · ${esc(a.className || "")}${a.dueAt ? ` · due <b>${esc(fmtWhen(a.dueAt))}</b>` : ""}${a.estimatedMinutes ? ` · about ${a.estimatedMinutes} min` : ""} · ${num(a.maxMarks)} mark${a.maxMarks === 1 ? "" : "s"}</p>
      <h2 style="margin:.2rem 0 .4rem">${esc(a.title)}</h2>
      ${d.pendingSync ? PENDING_NOTE : ""}
      <p>${completionPill(d.completion, { late: s?.isLate, overdue })}${s?.submittedAt ? ` ${esc(handedInText(s))}` : ""}</p>
      ${marked ? `
        <div class="chart-stats" style="grid-template-columns:repeat(3,1fr);margin:.5rem 0">
          <div><b>${num(s.marks)}/${num(s.maxMarks)}</b><span>Marks</span></div>
          <div><b>${pct(s.percentage)}</b><span>Score</span></div>
          <div><b>${esc(s.band || "—")}</b><span>Band</span></div>
        </div>
        ${s.feedback ? `<p><b>Your teacher says:</b> ${esc(s.feedback)}</p>` : ""}` : ""}
      ${d.completion === "submitted" ? `<p class="field-hint">Your teacher will mark it. You'll see your marks here.</p>` : ""}
      ${a.description ? `<p style="white-space:pre-wrap">${esc(a.description)}</p>` : ""}
      ${a.instructions ? `<p class="field-hint" style="white-space:pre-wrap"><b>What to do:</b> ${esc(a.instructions)}</p>` : ""}
      ${d.resource ? `<div class="task-row"><div style="flex:1"><b>${esc(d.resource.title)}</b><span>Read this first</span></div>${libraryFilesHtml(d.resource)}</div>` : ""}
      ${d.cannotWork && d.completion !== "submitted" && d.completion !== "marked" ? `<p class="field-error">${esc(d.cannotWork)}</p>` : ""}
      ${d.completion === "not_started"
        ? (d.cannotWork ? "" : `<p>${d.questions.length} question${d.questions.length === 1 ? "" : "s"}. Save your answers as you go with “Save progress”, then hand it in.</p>
            <button class="btn btn-primary" type="button" data-start>Start</button>`)
        : `<form class="fill-form" data-work>
            ${d.questions.map((q, i) => learnerQuestionHtml(q, i, answers[q.id] ? { ...answers[q.id], files: answers[q.id].files } : null, editable, marked, seed)).join("")}
            ${editable ? `
              <div class="field-error" data-error hidden></div>
              <div class="lms-actions">
                <button class="btn btn-outline" type="button" data-save>Save progress</button>
                <button class="btn btn-primary" type="submit">Hand in</button>
              </div>
              <p class="field-hint" data-saved>${s?.localSavedAt ? `Saved on this device ${esc(fmtWhen(s.localSavedAt))}` : s?.lastSavedAt ? `Last saved ${esc(fmtWhen(s.lastSavedAt))}` : ""}</p>` : ""}
          </form>`}`;
  }
  render();

  /** The answers currently on the form. */
  function collect() {
    return [...panel.querySelectorAll("[data-qid]")].map((card) => collectAnswer(card, files));
  }
  const showError = (msg) => { const e = panel.querySelector("[data-error]"); if (e) { e.textContent = msg; e.hidden = false; } };

  panel.addEventListener("click", async (e) => {
    const move = e.target.closest("[data-move]");
    if (move) { moveItem(move); return; }
    if (e.target.closest("[data-start]")) {
      e.target.disabled = true;
      try {
        d = await startAssignment(id);
        render(); onChange();
        if (d.queued) toast("Started on this device", "Work on it now — it's sent when you're back online.", "success");
      } catch (err) {
        e.target.disabled = false;
        toast("Couldn't start", friendlyError(err), "error");
      }
    } else if (e.target.closest("[data-save]")) {
      const btn = e.target.closest("[data-save]");
      btn.disabled = true;
      try {
        d = await saveAssignmentAnswers(id, collect());
        render();
        toast("Saved", d.queued ? "Your answers are saved on this device and sent when you're back online." : "Your answers are saved.", "success");
        onChange();
      } catch (err) {
        btn.disabled = false;
        showError(friendlyError(err, "Couldn't save your answers."));
      }
    }
  });

  panel.addEventListener("change", async (e) => {
    const input = e.target.closest("[data-upload]");
    if (!input?.files?.[0]) return;
    const card = input.closest("[data-qid]");
    const qid = card.dataset.qid;
    const file = input.files[0];
    if (file.size > 25 * 1024 * 1024) { toast("That file is too big", "Files can be up to 25 MB.", "error"); return; }
    card.querySelector("[data-files]").innerHTML = `<span class="hint-inline">Uploading ${esc(file.name)}…</span>`;
    try {
      const ref = await uploadAnswerFile(id, qid, file);
      files[qid] = [...(files[qid] || []), ref].slice(-5);
      d = await saveAssignmentAnswers(id, collect());
      render();
      toast(ref.pendingUpload ? "Kept on this device" : "Uploaded",
        ref.pendingUpload ? `${file.name} is uploaded when you're back online.` : `${file.name} is attached to your answer.`, "success");
    } catch (err) {
      toast("Couldn't upload", friendlyError(err), "error");
      render();
    }
  });

  panel.addEventListener("submit", async (e) => {
    if (!e.target.matches("[data-work]")) return;
    e.preventDefault();
    const answers = collect();
    const blank = answers.filter(isBlank).length;
    const ok = await confirmDialog({
      title: "Hand it in?",
      body: `${blank ? `${blank} question${blank === 1 ? " is" : "s are"} still blank. ` : ""}You can't change your answers after handing in.`,
      confirmLabel: "Hand in",
    });
    if (!ok) return;
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      d = await submitAssignment(id, answers);
      render();
      toast("Handed in", d.queued ? "It's on this device and goes to your teacher when you're back online."
        : d.completion === "marked" ? `You scored ${pct(d.submission.percentage)}.` : "Your teacher will mark it.", "success");
      onChange();
    } catch (err) {
      btn.disabled = false;
      showError(friendlyError(err, "Couldn't hand it in."));
    }
  });
}
