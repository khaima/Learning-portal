import "./nav.js";
import { $, $$, esc, initials, toast } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import {
  CONTENT_TYPES, LIBRARY_SUBJECTS, LIBRARY_AUDIENCES, FORM_AUDIENCES, QUESTION_TYPES, ROLES,
  normalizeLibraryAudience,
} from "./data.js";
import {
  getLibrary, addLibraryItem, getForms, addForm, getResponses, getStats,
  uploadLibraryFiles, libraryFilesHtml,
  koboConfig, saveKoboConfig, koboAssets, koboForms, attachKoboForm,
  removeKoboForm, syncKobo, koboResults,
  getUsers, updateUser, resetUserPassword,
} from "./store.js";

const AUDIENCE_LABEL = Object.fromEntries(FORM_AUDIENCES.map((a) => [a.value, a.label]));
const STAFF_ROLES = ROLES.filter((r) => r.value !== "learner");
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));

const ICON = {
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  forms: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  responses: '<path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M9 13l2 2 4-4"/>',
  progress: '<path d="M12 20V10M18 20V4M6 20v-6"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;

async function main() {
  const user = await requireRole("education_team");
  if (!user) return;

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = "Education Team";
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;

  /* ------------------------------------------------------------ live org-wide stats
     Real aggregation, computed server-side from every account and everything
     they've produced (see the /stats route). A field report filed on the
     Field Officer dashboard, or an assignment marked done by a learner,
     changes these numbers on the next load, from any device. Optionally
     scoped to a county and/or a specific school — see renderImpact(). */
  let impactCounty = "";
  let impactSchool = "";
  let gpTopN = 0; // grade-performance ranking cap; 0 = show every grade

  async function renderStats() {
    $("#statRow").innerHTML = `<div class="empty-state">Loading…</div>`;
    $("#impactBody").innerHTML = `<div class="empty-state">Loading…</div>`;
    let s;
    try {
      s = await getStats({ county: impactCounty, school: impactSchool, topGrades: gpTopN });
    } catch {
      $("#statRow").innerHTML = `<div class="empty-state">Couldn't load stats.</div>`;
      $("#impactBody").innerHTML = `<div class="empty-state">Couldn't load impact data.</div>`;
      return;
    }
    populateFilter($("#impactCounty"), s.counties || [], impactCounty);
    populateFilter($("#impactSchool"), s.schools || [], impactSchool);
    const r = s.byRole || {};
    const scoped = s.school ? ` at ${esc(s.school)}` : s.county ? ` in ${esc(s.county)}` : "";
    $("#statRow").innerHTML = `
      <div class="stat-tile"><div class="s-label">${svg(ICON.progress)}Accounts</div><div class="s-num">${s.accounts}</div>
        <div class="s-sub">${r.teacher || 0} teachers · ${r.learner || 0} learners · ${r.school_leader || 0} leaders · ${r.field_officer || 0} officers${scoped}</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.responses)}Assignments done</div><div class="s-num">${s.assignmentsDone}/${s.assignmentsTotal}</div>
        <div class="s-sub">across all learner accounts${scoped}</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.forms)}Field reports filed</div><div class="s-num">${s.reportsFiled}</div>
        <div class="s-sub">across all field officer accounts${scoped}</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.library)}Forms & responses</div><div class="s-num">${s.formsSent} / ${s.responsesReceived}</div>
        <div class="s-sub">sent / received${scoped ? " · portal-wide" : ""}</div></div>
    `;
    renderImpact(s);
  }

  /* County/school filters — repopulated on every load (the lists can grow
     as new schools come on board) but never fight the visitor's current
     pick. The school list already narrows to the selected county. */
  function populateFilter(sel, options, current) {
    const fallback = sel.id === "impactSchool" ? "All schools" : "All counties";
    sel.innerHTML = `<option value="">${fallback}</option>` +
      options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
    sel.value = current;
  }
  $("#impactCounty").addEventListener("change", (e) => {
    impactCounty = e.target.value;
    impactSchool = ""; // a school from the old county may not exist in the new one
    renderStats();
  });
  $("#impactSchool").addEventListener("change", (e) => {
    impactSchool = e.target.value;
    renderStats();
  });

  /* Top-N control lives inside the grade-performance card itself, which is
     rebuilt on every render — one delegated listener survives that. */
  $("#impactBody").addEventListener("change", (e) => {
    if (e.target.id === "gpTopN") {
      gpTopN = Number(e.target.value) || 0;
      renderStats();
    }
  });

  /* ------------------------------------------------------------ portal impact (Overview charts)
     One chart per data source the portal actually collects, from all
     four operational roles: teacher-created assignments (learner
     completion) and the grades behind them, teacher employment type,
     new-learner intake by term, field officer visit reports (by type
     and, once a county is picked, by school), the forms/feedback loop
     each staff role engages with, the content library the Education
     Team itself has built up, and the account mix overall. All
     server-aggregated in /stats, already scoped to the selected county/
     school where that makes sense — reuses the same bar/donut/legend
     renderers as Survey Results, defined further down this file. */
  function renderImpact(s) {
    const scope = s.school ? ` — ${s.school}` : s.county ? ` — ${s.county}` : "";
    const ROLE_LABELS = { teacher: "Teachers", learner: "Learners", school_leader: "School Leaders", field_officer: "Field Officers" };
    const roleData = Object.entries(ROLE_LABELS).map(([k, label]) => ({ label, value: (s.byRole && s.byRole[k]) || 0 }));
    const doneData = [
      { label: "Completed", value: s.assignmentsDone || 0 },
      { label: "Pending", value: Math.max(0, (s.assignmentsTotal || 0) - (s.assignmentsDone || 0)) },
    ];
    const eng = s.formsEngagement || [];
    const sentData = eng.map((e) => ({ label: e.label, value: e.sent }));
    const respData = eng.map((e) => ({ label: e.label, value: e.responses }));
    const learnerTotal = (s.learnersByGrade || []).reduce((a, d) => a + d.value, 0);
    const libraryTotal = (s.libraryByDestination || []).reduce((a, d) => a + d.value, 0);
    const teacherTypeData = (s.teachersByType || []).map((d) => ({ ...d, label: d.label === "(not set)" ? "Not specified" : d.label }));

    const cards = [
      impactCard(`Accounts by role${scope}`, `${s.accounts || 0} total · teachers, learners, leaders & field officers`,
        sumOf(roleData) ? `<div class="chart-donut-wrap">${donutChart(roleData)}${legend(roleData)}</div>` : miniEmpty()),
      impactCard(`Assignment completion${scope}`, `${s.assignmentsTotal || 0} assigned to learners`,
        sumOf(doneData) ? `<div class="chart-donut-wrap">${donutChart(doneData)}${legend(doneData)}</div>` : miniEmpty()),
      impactCard(`Learners by grade${scope}`, `${learnerTotal} learners`,
        (s.learnersByGrade || []).length ? barChart(s.learnersByGrade) : miniEmpty()),
    ];
    if (s.county && !s.school) {
      cards.push(impactCard(`Learners by school${scope}`, `${learnerTotal} learners`,
        (s.learnersBySchool || []).length ? barChart(s.learnersBySchool) : miniEmpty()));
    }
    cards.push(
      impactCard(`New learners by term${scope}`, `based on when each account was created`,
        (s.newLearnersByTerm || []).length ? barChart(s.newLearnersByTerm) : miniEmpty()),
      impactCard(`Teachers by type${scope}`, `BOM vs TSC · self-declared at sign-up`,
        sumOf(teacherTypeData) ? `<div class="chart-donut-wrap">${donutChart(teacherTypeData)}${legend(teacherTypeData)}</div>` : miniEmpty()),
    );
    cards.push(
      impactCard(`Field visits by type${scope}`, `${s.reportsFiled || 0} reports filed`,
        (s.fieldReportsByVisitType || []).length ? barChart(s.fieldReportsByVisitType) : miniEmpty()),
    );
    cards.push(
      s.county
        ? impactCard(`Field visits by school${scope}`, `${s.reportsFiled || 0} reports filed`,
            (s.fieldReportsBySchool || []).length ? barChart(s.fieldReportsBySchool) : miniEmpty())
        : impactCard("Field visits by county", `${s.reportsFiled || 0} reports filed · pick a county above to drill in`,
            (s.fieldReportsByCounty || []).length ? barChart(s.fieldReportsByCounty) : miniEmpty()),
    );
    cards.push(
      impactCard("Content library", `${libraryTotal} items uploaded · portal-wide`,
        sumOf(s.libraryByDestination) ? `<div class="chart-donut-wrap">${donutChart(s.libraryByDestination)}${legend(s.libraryByDestination)}</div>` : miniEmpty()),
      impactCard("Forms & feedback engagement", `${s.formsSent || 0} sent · ${s.responsesReceived || 0} responses · portal-wide`,
        `<div class="chart-subhead">Sent</div>${sumOf(sentData) ? barChart(sentData) : miniEmpty()}<div class="chart-subhead">Responded</div>${sumOf(respData) ? barChart(respData) : miniEmpty()}`),
    );

    // Grade "performance": the one real, comparable signal the portal
    // records today is assignment completion rate — there's no gradebook/
    // exam-results feature yet, so this isn't an academic score (flagged
    // to Patrick separately). Ranked highest-first, capped by the Top-N
    // picker embedded in the card.
    const gp = s.gradePerformance || [];
    const gpHead = `<div class="chart-card-head"><b>Grade performance${scope}</b>
      <select id="gpTopN" style="font-size:.74rem;padding:.2rem .4rem;border-radius:6px;border:1px solid var(--line);background:var(--paper-raised);color:var(--ink)">
        <option value="0"${gpTopN === 0 ? " selected" : ""}>All grades</option>
        <option value="5"${gpTopN === 5 ? " selected" : ""}>Top 5</option>
        <option value="10"${gpTopN === 10 ? " selected" : ""}>Top 10</option>
      </select></div>`;
    const gpBody = gp.length
      ? barChart(gp.map((g) => ({ label: `${g.label} (${g.total})`, value: g.value })))
      : miniEmpty();
    cards.push(`<div class="chart-card">${gpHead}
      <div class="chart-empty" style="margin:-.3rem 0 .5rem">% of assignments completed, by grade — ranked, not an exam score</div>
      ${gpBody}
    </div>`);

    $("#impactMeta").textContent = `updated ${new Date().toLocaleTimeString()}`;
    $("#impactBody").innerHTML = `<div class="chart-grid">${cards.join("")}</div>`;
  }

  function impactCard(title, meta, body) {
    return `<div class="chart-card">
      <div class="chart-card-head"><b>${esc(title)}</b><span>${esc(meta)}</span></div>
      ${body}
    </div>`;
  }

  /* ------------------------------------------------------------ content library */
  $("#up_subject").innerHTML = LIBRARY_SUBJECTS.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#up_type").innerHTML = CONTENT_TYPES.map((t) => `<option>${esc(t)}</option>`).join("");
  $("#up_audience").innerHTML = LIBRARY_AUDIENCES.map((a) => `<option value="${a.value}">${esc(a.label)}</option>`).join("");

  async function renderLibrary() {
    $("#libraryList").innerHTML = `<div class="empty-state">Loading…</div>`;
    let items = [];
    try { items = await getLibrary(); } catch { /* shown as empty */ }
    $("#libraryList").innerHTML = items.length
      ? items.map((it) => `
        <div class="task-row">
          <span class="task-dot" style="background:var(--brand);margin-top:.55rem"></span>
          <div style="flex:1">
            <b>${esc(it.title)}</b>
            <span>${esc(it.subject)} · ${esc(it.type)}${it.description ? " — " + esc(it.description) : ""}</span>
            ${libraryFilesHtml(it)}
          </div>
          <span class="pill${normalizeLibraryAudience(it.audience) === "staff" ? "" : " ok"}">${
            normalizeLibraryAudience(it.audience) === "staff" ? "Teacher Resources" : "Digital Library"
          }</span>
        </div>`).join("")
      : `<div class="empty-state">Nothing uploaded yet.</div>`;
  }

  /* ---- file / folder picker for "Upload content" ---- */
  const fileInput = $("#up_file");
  const uploadList = $("#uploadList");
  const uploadHint = $("#uploadHint");
  const uploadDrop = $("#uploadDrop");
  let picked = [];

  function setFolderMode(on) {
    // webkitdirectory turns the same input into a folder picker.
    if (on) {
      fileInput.setAttribute("webkitdirectory", "");
      fileInput.setAttribute("directory", "");
    } else {
      fileInput.removeAttribute("webkitdirectory");
      fileInput.removeAttribute("directory");
    }
  }

  function showPicked() {
    if (!picked.length) {
      uploadList.hidden = true;
      uploadList.innerHTML = "";
      uploadHint.hidden = false;
      return;
    }
    uploadHint.hidden = true;
    uploadList.hidden = false;
    const total = picked.reduce((s, f) => s + f.size, 0);
    const kb = total > 1024 * 1024 ? `${(total / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(total / 1024))} KB`;
    const head = picked.length === 1
      ? esc(picked[0].name)
      : `${picked.length} files${picked[0].webkitRelativePath ? ` in <b>${esc(picked[0].webkitRelativePath.split("/")[0])}</b>` : ""}`;
    uploadList.innerHTML = `
      <li class="upload-summary">${head} <span class="lib-size">${kb}</span>
        <button type="button" class="upload-clear" aria-label="Remove selected files">&times;</button></li>`;
    uploadList.querySelector(".upload-clear").addEventListener("click", clearPicked);
  }

  function clearPicked() {
    picked = [];
    fileInput.value = "";
    setFolderMode(false);
    showPicked();
  }

  $("#pickFileBtn").addEventListener("click", () => { setFolderMode(false); fileInput.click(); });
  $("#pickFolderBtn").addEventListener("click", () => { setFolderMode(true); fileInput.click(); });
  fileInput.addEventListener("change", () => {
    picked = [...fileInput.files];
    if (picked.length && !$("#up_title").value.trim()) {
      const base = picked[0].webkitRelativePath
        ? picked[0].webkitRelativePath.split("/")[0]
        : picked[0].name.replace(/\.[^.]+$/, "");
      $("#up_title").value = base;
    }
    showPicked();
  });

  // Drag-and-drop a single file onto the box.
  ["dragover", "dragenter"].forEach((ev) => uploadDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    uploadDrop.classList.add("is-drag");
  }));
  ["dragleave", "drop"].forEach((ev) => uploadDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    uploadDrop.classList.remove("is-drag");
  }));
  uploadDrop.addEventListener("drop", (e) => {
    const dropped = [...(e.dataTransfer?.files || [])];
    if (!dropped.length) return;
    setFolderMode(false);
    picked = dropped;
    if (!$("#up_title").value.trim()) $("#up_title").value = dropped[0].name.replace(/\.[^.]+$/, "");
    showPicked();
  });

  $("#uploadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#up_title").value.trim();
    if (!title) return;
    const submitBtn = e.target.querySelector("[type=submit]");
    submitBtn.disabled = true;

    const meta = {
      title,
      subject: $("#up_subject").value,
      type: $("#up_type").value,
      audience: $("#up_audience").value,
      description: $("#up_desc").value.trim(),
    };

    try {
      if (picked.length) {
        submitBtn.textContent = `Uploading 0/${picked.length}…`;
        await uploadLibraryFiles(meta, picked, (done, n) => {
          submitBtn.textContent = `Uploading ${done}/${n}…`;
        });
        toast("Added to library", `${picked.length} file(s) uploaded`);
      } else {
        await addLibraryItem(meta);
        toast("Added to library", "");
      }
      e.target.reset();
      clearPicked();
      $("#up_subject").value = LIBRARY_SUBJECTS[0];
      $("#up_type").value = CONTENT_TYPES[0];
      $("#up_audience").value = LIBRARY_AUDIENCES[0].value;
      renderLibrary();
    } catch (err) {
      toast("Upload failed", err?.message || "Could not save the content.", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add to library";
    }
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
    try {
      await addForm({
        title,
        description: $("#fb_desc").value.trim(),
        audience: $("#fb_audience").value,
        questions,
      });
      e.target.reset();
      questionRows.innerHTML = "";
      addQuestionRow();
      renderForms();
      renderStats();
    } catch (err) {
      toast("Couldn't send the form", err?.message || "", "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  /* ------------------------------------------------------------ forms & feedback */
  async function renderForms() {
    $("#formsList").innerHTML = `<div class="empty-state">Loading…</div>`;
    let forms = [];
    let responses = [];
    try {
      [forms, responses] = await Promise.all([getForms(), getResponses()]);
    } catch { /* shown as empty */ }
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

  /* ------------------------------------------------------------ field surveys (KoboToolbox) */
  const koboConnectForm = $("#koboConnectForm");
  const koboManage = $("#koboManage");
  const koboSyncBtn = $("#koboSyncBtn");
  const koboAssetSel = $("#kb_asset");
  let koboState = { configured: false };

  function showKoboConnect() {
    koboConnectForm.hidden = false;
    koboManage.hidden = true;
    koboSyncBtn.hidden = true;
  }

  async function renderKobo() {
    try {
      koboState = await koboConfig();
    } catch {
      $("#koboFormList").innerHTML = `<div class="empty-state">Couldn't load KoboToolbox settings.</div>`;
      return;
    }
    $("#kb_url").value = koboState.baseUrl || "https://eu.kobotoolbox.org";
    $("#kb_field").value = koboState.officerField || "officer_ref";
    $("#koboFieldEcho").textContent = koboState.officerField || "officer_ref";

    if (!koboState.configured) { showKoboConnect(); refreshSurveyPicker(); return; }

    koboConnectForm.hidden = true;
    koboManage.hidden = false;
    koboSyncBtn.hidden = false;
    $("#koboServerEcho").textContent = (koboState.baseUrl || "").replace(/^https?:\/\//, "");
    $("#koboFieldEcho2").textContent = koboState.officerField || "officer_ref";

    renderKoboAssets();
    renderKoboForms();
    refreshSurveyPicker();
  }

  async function renderKoboAssets() {
    koboAssetSel.innerHTML = `<option value="">Loading surveys…</option>`;
    let assets = [];
    try { assets = await koboAssets(); } catch (err) {
      koboAssetSel.innerHTML = `<option value="">${esc(err?.message || "Couldn't reach KoboToolbox")}</option>`;
      return;
    }
    const deployed = assets.filter((a) => a.deployed);
    koboAssetSel.innerHTML = deployed.length
      ? `<option value="">Choose a deployed survey…</option>` +
        deployed.map((a) => `<option value="${esc(a.uid)}">${esc(a.name)} (${a.submissionCount} submission${a.submissionCount === 1 ? "" : "s"})</option>`).join("")
      : `<option value="">No deployed surveys in this account</option>`;
  }

  async function renderKoboForms() {
    $("#koboFormList").innerHTML = `<div class="empty-state">Loading…</div>`;
    let forms = [];
    try { forms = await koboForms(); } catch { /* shown as empty */ }
    $("#koboFormList").innerHTML = forms.length
      ? forms.map((f) => `
        <div class="form-card">
          <div class="kobo-row">
            <div>
              <b style="font-size:.92rem">${esc(f.title)}</b>
              <div class="fc-meta" style="margin:.2rem 0 0">${f.officerSubmissions} officer submission${f.officerSubmissions === 1 ? "" : "s"}${
                f.syncedAt ? " · synced " + new Date(f.syncedAt).toLocaleString() : " · not synced yet"
              }</div>
            </div>
            <div class="kobo-actions">
              <button type="button" data-kobo-remove="${esc(f.id)}" class="danger">Remove</button>
            </div>
          </div>
        </div>`).join("")
      : `<div class="empty-state">No surveys attached yet.</div>`;

    $$("[data-kobo-remove]").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await removeKoboForm(btn.dataset.koboRemove);
        renderKoboForms();
        refreshSurveyPicker();
      } catch (err) {
        toast("Couldn't remove it", err?.message || "", "error");
        btn.disabled = false;
      }
    }));
  }

  koboConnectForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    try {
      await saveKoboConfig({
        baseUrl: $("#kb_url").value.trim(),
        apiToken: $("#kb_token").value.trim(),
        officerField: $("#kb_field").value.trim(),
      });
      $("#kb_token").value = "";
      toast("KoboToolbox connected", "");
      renderKobo();
    } catch (err) {
      toast("Couldn't connect", err?.message || "Check the server URL and token.", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  });

  $("#koboReconnect").addEventListener("click", showKoboConnect);

  $("#koboAttachForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const uid = koboAssetSel.value;
    if (!uid) return;
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      await attachKoboForm(uid);
      koboAssetSel.value = "";
      renderKoboForms();
      refreshSurveyPicker();
    } catch (err) {
      toast("Couldn't attach that survey", err?.message || "", "error");
    } finally {
      btn.disabled = false;
    }
  });

  koboSyncBtn.addEventListener("click", async () => {
    koboSyncBtn.disabled = true;
    koboSyncBtn.textContent = "Syncing…";
    try {
      const { matched } = await syncKobo();
      toast("Synced with KoboToolbox", `${matched} officer submission(s) matched.`);
      renderKoboForms();
      refreshSurveyPicker();
    } catch (err) {
      toast("Sync failed", err?.message || "", "error");
    } finally {
      koboSyncBtn.disabled = false;
      koboSyncBtn.textContent = "Sync now";
    }
  });

  /* ------------------------------------------------------------ survey results (live charts)
     Picks one attached Kobo survey and draws a chart per question from
     its live submissions — the API pulls the schema + data from Kobo and
     tallies each answer. Re-runs on survey change, on Refresh, when the
     tab regains focus, and every 45s while the tab is visible. */
  const srPicker = $("#srPicker");
  const srBody = $("#srBody");
  const srMeta = $("#srMeta");
  const srRefresh = $("#srRefresh");
  let srCurrent = "";
  let srBusy = false;
  let srTimer = null;

  function srIdle(message) {
    srPicker.innerHTML = "";
    $("#srPickerField").hidden = true;
    srRefresh.hidden = true;
    srMeta.textContent = "";
    srBody.innerHTML = `<div class="empty-state">${message}</div>`;
    srCurrent = "";
    stopSrPolling();
  }

  async function refreshSurveyPicker() {
    if (!koboState.configured) {
      srIdle("Connect KoboToolbox to see survey results.");
      return;
    }
    let forms = [];
    try { forms = await koboForms(); } catch { /* shown as empty */ }
    if (!forms.length) {
      srIdle("Attach a survey above to see its results here.");
      return;
    }
    $("#srPickerField").hidden = forms.length === 1;
    srRefresh.hidden = false;
    const prev = srCurrent;
    srPicker.innerHTML = forms
      .map((f) => `<option value="${esc(f.id)}">${esc(f.title)} — ${f.submissionCount} submission${f.submissionCount === 1 ? "" : "s"}</option>`)
      .join("");
    srCurrent = forms.some((f) => f.id === prev) ? prev : forms[0].id;
    srPicker.value = srCurrent;
    srBody.dataset.for = "";
    loadSurveyResults();
    startSrPolling();
  }

  async function loadSurveyResults() {
    if (!srCurrent || srBusy) return;
    srBusy = true;
    const wanted = srCurrent;
    const firstView = srBody.dataset.for !== wanted;
    if (firstView) srBody.innerHTML = `<div class="empty-state">Loading…</div>`;
    try {
      const res = await koboResults(wanted);
      if (res.id !== srCurrent) return; // survey switched mid-flight
      srBody.dataset.for = srCurrent;
      renderSurveyResults(res);
    } catch (err) {
      if (firstView) srBody.innerHTML = `<div class="empty-state">${esc(err?.message || "Couldn't load results.")}</div>`;
    } finally {
      srBusy = false;
    }
  }

  function renderSurveyResults(res) {
    const bits = [];
    if (res.submissionCount) bits.push(`${res.submissionCount} submission${res.submissionCount === 1 ? "" : "s"}`);
    if (res.lastSubmission) bits.push(`last ${new Date(res.lastSubmission).toLocaleString()}`);
    bits.push(`updated ${new Date().toLocaleTimeString()}`);
    srMeta.textContent = bits.join(" · ");

    if (!res.submissionCount) {
      srBody.innerHTML = `<div class="empty-state">No submissions yet for “${esc(res.title)}”.</div>`;
      return;
    }
    if (!res.questions.length) {
      srBody.innerHTML = `<div class="empty-state">This survey has no chartable questions.</div>`;
      return;
    }
    srBody.innerHTML = `<div class="chart-grid">${res.questions.map(chartCard).join("")}</div>`;
  }

  const sumOf = (data) => (data || []).reduce((s, d) => s + (d.value || 0), 0);
  const miniEmpty = () => `<div class="chart-empty">No answers yet</div>`;

  function chartCard(q) {
    let body;
    if (q.chart === "list") {
      body = q.data.length
        ? `<div class="chart-list">${q.data.map((a) => `<div class="chart-list-row">${esc(a)}</div>`).join("")}</div>`
        : miniEmpty();
    } else if (q.chart === "number") {
      body = q.data
        ? `<div class="chart-stats">
             <div><b>${q.data.count}</b><span>responses</span></div>
             <div><b>${q.data.mean}</b><span>average</span></div>
             <div><b>${q.data.min}</b><span>lowest</span></div>
             <div><b>${q.data.max}</b><span>highest</span></div>
           </div>${barChart(q.data.histogram)}`
        : miniEmpty();
    } else if (q.chart === "donut") {
      body = sumOf(q.data)
        ? `<div class="chart-donut-wrap">${donutChart(q.data)}${legend(q.data)}</div>`
        : miniEmpty();
    } else {
      body = sumOf(q.data) ? barChart(q.data) : miniEmpty();
    }
    return `<div class="chart-card">
      <div class="chart-card-head"><b>${esc(q.label)}</b><span>${q.answered} answered</span></div>
      ${body}
    </div>`;
  }

  function barChart(data) {
    const rows = data || [];
    const max = Math.max(1, ...rows.map((d) => d.value || 0));
    return `<div class="bar-chart">${rows.map((d) => `
      <div class="bar-row">
        <span class="bar-label" title="${esc(d.label)}">${esc(d.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${((d.value || 0) / max) * 100}%"></span></span>
        <span class="bar-num">${d.value || 0}</span>
      </div>`).join("")}</div>`;
  }

  function donutChart(data) {
    const rows = (data || []).filter((d) => d.value > 0);
    const total = sumOf(rows) || 1;
    let acc = 0;
    const segs = rows.map((d, i) => {
      const pct = (d.value / total) * 100;
      const seg = `<circle class="donut-seg" r="15.915" cx="21" cy="21" fill="none"
        stroke="var(--chart-${(i % 6) + 1})" stroke-width="6" pathLength="100"
        stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}"
        stroke-dashoffset="${(-acc).toFixed(2)}"></circle>`;
      acc += pct;
      return seg;
    }).join("");
    return `<svg class="donut" viewBox="0 0 42 42" role="img" aria-label="Response breakdown">
      <circle r="15.915" cx="21" cy="21" fill="none" stroke="var(--line)" stroke-width="6"></circle>
      ${segs}
      <text x="21" y="21" class="donut-total">${total}</text>
    </svg>`;
  }

  function legend(data) {
    return `<div class="chart-legend">${(data || []).filter((d) => d.value > 0).map((d, i) =>
      `<span><i style="background:var(--chart-${(i % 6) + 1})"></i>${esc(d.label)} · ${d.value}</span>`).join("")}</div>`;
  }

  function startSrPolling() {
    stopSrPolling();
    srTimer = setInterval(() => {
      if (document.visibilityState === "visible" && srCurrent) loadSurveyResults();
    }, 45000);
  }
  function stopSrPolling() {
    if (srTimer) { clearInterval(srTimer); srTimer = null; }
  }

  srPicker.addEventListener("change", () => {
    srCurrent = srPicker.value;
    srBody.dataset.for = "";
    loadSurveyResults();
  });
  srRefresh.addEventListener("click", loadSurveyResults);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && srCurrent) loadSurveyResults();
  });

  /* ------------------------------------------------------------ staff accounts
     Every teacher / school leader / field officer / education team
     sign-in — editable here, grouped under a title per role. Passwords are
     one-way hashed server-side and never come back to the browser, so
     "Reset password" sets a brand-new one instead of ever showing the old
     one. The list is "smart": one search box filters name/email/county/
     school/role live, and a sort control reorders every role group at
     once by name, county, or school — all client-side against the one
     fetch, so it's instant. */
  let allUsers = [];

  function userRow(u) {
    const meta = [
      esc(u.email),
      u.county ? esc(u.county) : "",
      u.school ? esc(u.school) : "",
      u.teacherType ? esc(u.teacherType) : "",
    ].filter(Boolean).join(" · ");
    return `
      <div class="task-row" data-user="${esc(u.id)}"
           data-fullname="${esc(u.fullName || "")}" data-email="${esc(u.email || "")}"
           data-role="${esc(u.role)}" data-county="${esc(u.county || "")}"
           data-school="${esc(u.school || "")}" data-teachertype="${esc(u.teacherType || "")}">
        <div style="flex:1">
          <b>${esc(u.fullName || "(no name)")}</b>
          <span>${meta}</span>
        </div>
        <div class="roster-actions">
          <button type="button" data-act="edit">Edit</button>
          <button type="button" data-act="password">Reset password</button>
        </div>
      </div>`;
  }

  function userMatchesSearch(u, q) {
    if (!q) return true;
    const hay = [u.fullName, u.email, u.county, u.school, u.teacherType, ROLE_LABEL[u.role]]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }

  function sortUsers(list, sortBy) {
    const key = sortBy === "county" ? "county" : sortBy === "school" ? "school" : "fullName";
    return [...list].sort((a, b) => {
      const av = (a[key] || "").trim();
      const bv = (b[key] || "").trim();
      if (!av !== !bv) return av ? -1 : 1; // blank values sort last
      return av.localeCompare(bv) || (a.fullName || "").localeCompare(b.fullName || "");
    });
  }

  function renderUsersList() {
    const list = $("#usersList");
    if (!allUsers.length) {
      list.innerHTML = `<div class="empty-state">No staff accounts yet.</div>`;
      $("#usersMeta").textContent = "";
      return;
    }
    const q = $("#usersSearch").value.trim().toLowerCase();
    const sortBy = $("#usersSort").value;
    const filtered = allUsers.filter((u) => userMatchesSearch(u, q));

    $("#usersMeta").textContent = filtered.length === allUsers.length
      ? `${allUsers.length} account${allUsers.length === 1 ? "" : "s"}`
      : `${filtered.length} of ${allUsers.length} accounts`;

    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state">No accounts match your search.</div>`;
      return;
    }

    list.innerHTML = STAFF_ROLES.map((r) => {
      const rows = sortUsers(filtered.filter((u) => u.role === r.value), sortBy);
      if (!rows.length) return "";
      return `
        <div class="list-group">
          <div class="list-group-title">${esc(r.label)}<span class="count">${rows.length}</span></div>
          ${rows.map(userRow).join("")}
        </div>`;
    }).join("");
  }

  async function renderUsers() {
    $("#usersList").innerHTML = `<div class="empty-state">Loading…</div>`;
    try { allUsers = await getUsers(); } catch { allUsers = []; }
    renderUsersList();
  }

  $("#usersSearch").addEventListener("input", renderUsersList);
  $("#usersSort").addEventListener("change", renderUsersList);

  /* Returns a role value, undefined for an out-of-range pick, or null if
     the admin cancelled — the caller tells those apart. */
  function pickRole(current) {
    const lines = STAFF_ROLES.map((r, i) => `${i + 1}) ${r.label}`).join("\n");
    const defaultIdx = STAFF_ROLES.findIndex((r) => r.value === current);
    const input = prompt(`Role — enter a number:\n${lines}`, String(defaultIdx >= 0 ? defaultIdx + 1 : 1));
    if (input === null) return null;
    const idx = Number(input.trim()) - 1;
    return STAFF_ROLES[idx] ? STAFF_ROLES[idx].value : undefined;
  }

  $("#usersList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const row = btn.closest("[data-user]");
    const id = row.dataset.user;

    try {
      if (btn.dataset.act === "edit") {
        const fullName = prompt("Full name", row.dataset.fullname);
        if (fullName === null) return;
        const email = prompt("Email address", row.dataset.email);
        if (email === null) return;
        const role = pickRole(row.dataset.role);
        if (role === null) return;
        if (role === undefined) {
          toast("Couldn't do that", "Pick a number from the list.", "error");
          return;
        }
        const county = prompt("County", row.dataset.county);
        if (county === null) return;
        const school = prompt("School / institution", row.dataset.school);
        if (school === null) return;
        const patch = {
          fullName: fullName.trim(), email: email.trim(), role,
          county: county.trim(), school: school.trim(),
        };
        if (role === "teacher") {
          const tt = prompt("Employment type — BOM, TSC, or leave blank", row.dataset.teachertype);
          if (tt === null) return;
          patch.teacherType = tt.trim();
        }
        await updateUser(id, patch);
        toast("Account updated", "");
        renderUsers();
      } else if (btn.dataset.act === "password") {
        const password = prompt(`New password for ${row.dataset.email} — at least 8 characters`);
        if (!password) return;
        if (password.trim().length < 8) {
          toast("Couldn't do that", "Password must be at least 8 characters.", "error");
          return;
        }
        await resetUserPassword(id, password.trim());
        toast("Password reset", "Tell them their new password.");
      }
    } catch (err) {
      toast("Couldn't do that", err?.body?.error || err?.message || "", "error");
    }
  });

  renderStats();
  renderLibrary();
  renderForms();
  renderKobo();
  renderUsers();
}
main();

async function doSignOut() {
  await signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
