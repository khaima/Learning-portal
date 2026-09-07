import { $, $$, esc, initials } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { TEACHER_CONTENT } from "./data.js";
import { getLibrary, getForms, getResponses, addResponse, libraryFilesHtml } from "./store.js";

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
    classes: [], tasks: [], results: [],
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

  /* Content library lives in the real database (education.js writes it).
     Teacher Resources — addressed only to Teachers — never show up on
     the Learner dashboard; the Digital Library below is what's shared
     with Learners too. */
  $("#teacherResourceList").innerHTML = `<div class="empty-state">Loading…</div>`;
  $("#libraryList").innerHTML = `<div class="empty-state">Loading…</div>`;
  getLibrary().then((library) => {
    const resources = library.filter((l) => l.audience === "teacher");
    const shared = library.filter((l) => l.audience === "both" || !l.audience);
    const row = (l) => `
        <div class="task-row"><div><b>${esc(l.title)}</b><span>${esc(l.subject)} · ${esc(l.type)}${l.description ? " — " + esc(l.description) : ""}</span>${libraryFilesHtml(l)}</div></div>`;
    $("#teacherResourceList").innerHTML = resources.length
      ? resources.map(row).join("")
      : `<div class="empty-state">No teacher resources uploaded yet.</div>`;
    $("#libraryList").innerHTML = shared.length
      ? shared.map(row).join("")
      : `<div class="empty-state">Nothing in the library yet.</div>`;
  });

  /* Forms the Education Team has sent to teachers — same
     create-once-fill-once loop as the field officer's report form, just
     addressed at this account instead of built into it. */
  renderForms();
  async function renderForms() {
    $("#formsList").innerHTML = `<div class="empty-state">Loading…</div>`;
    const [forms, responses] = await Promise.all([getForms(), getResponses()]);
    const teacherForms = forms.filter((f) => f.audience === "teacher");
    const answeredFormIds = new Set(responses.filter((r) => r.respondentId === user.id).map((r) => r.formId));

    $("#formsList").innerHTML = teacherForms.length
      ? teacherForms.map((f) => {
          const done = answeredFormIds.has(f.id);
          return `
            <div class="form-card">
              <div class="fc-head"><h3>${esc(f.title)}</h3>${done ? `<span class="pill ok">Submitted</span>` : `<span class="pill warm">Pending</span>`}</div>
              <div class="fc-meta">${f.description ? esc(f.description) : "From " + esc(f.createdBy)}</div>
              ${done ? "" : `<button class="btn btn-outline" type="button" data-fill-form="${esc(f.id)}">Fill out</button>
                <div class="fill-form" id="fill-${esc(f.id)}" hidden></div>`}
            </div>`;
        }).join("")
      : `<div class="empty-state">No forms from the Education Team yet.</div>`;

    $$("[data-fill-form]").forEach((btn) =>
      btn.addEventListener("click", () => openFormFill(btn.dataset.fillForm, teacherForms, btn))
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
      submitBtn.textContent = "Submitting…";
      const answers = form.questions.map((q) => ({
        questionId: q.id,
        value: box.querySelector(`[data-q="${q.id}"]`).value,
      }));
      await addResponse({
        id: "resp_" + Date.now().toString(36),
        formId: form.id,
        respondentId: user.id,
        respondentName: user.fullName,
        respondentRole: "teacher",
        answers,
      });
      renderForms();
    });
  }
}

function doSignOut() {
  signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
