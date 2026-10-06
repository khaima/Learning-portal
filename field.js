import { mountNavigation } from "./nav.js";
// Staff dashboards always need Supabase Auth: fetched with the page, not after it.
import "./supabase-auth.js";
import { $, $$, esc, initials, skeleton, emptyState, errorState, friendlyError, toast, confirmDialog } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { VISIT_TYPES } from "./data.js";
import {
  getForms, getResponses, getFieldReports, addFieldReport, watchSchools,
  myKoboSurveys, markKoboSubmitted, currentTermLabel,
} from "./store.js";
import { mountFormList, renderVisitForms, unfilledVisitForms, collectVisitResponses, FORM_KIND_LABEL } from "./forms.js";
import { addResponse, getSchools } from "./store.js";
import { openContentPanel, closeViewer } from "./viewer.js";
import { waiting } from "./sync.js";
// The school profile and teachers pages (admin-ui.js) load when first opened.
const adminUi = () => import("./admin-ui.js");
const pageFailed = (el) => (err) => { el.innerHTML = errorState(friendlyError(err, "Couldn't load this page — check your connection.")); };

const ICON = {
  schools: '<path d="M4 21V8l8-5 8 5v13"/><path d="M9 21v-6h6v6"/>',
  counties: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>',
  visits: '<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;

/* Kenya's 3-term school year, client-side mirror of the backend's
   schoolTermOf — just enough to answer "how many visits this term." */
function termOf(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "(not set)";
  const term = d.getMonth() <= 3 ? 1 : d.getMonth() <= 7 ? 2 : 3;
  return `${d.getFullYear()} Term ${term}`;
}

async function main() {
  const user = await requireRole("field_officer");
  if (!user) return;

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `Field Officer · ${user.county || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;

  // The menu (navigation.js), and the pages loaded when first opened. A field
  // officer works only at the schools assigned to them — the server sends
  // only those.
  mountNavigation(user, {
    onPage(page) {
      if (page === "teachers") adminUi().then((m) => m.renderTeachers($("#tchBody"))).catch(pageFailed($("#tchBody")));
      if (page === "school-profiles") showSchoolProfiles();
    },
  });
  async function showSchoolProfiles() {
    const sel = $("#spSchool");
    if (!sel.options.length) {
      let dir;
      try { dir = await getSchools(); } catch (err) { $("#spBody").innerHTML = errorState(friendlyError(err), showSchoolProfiles); return; }
      sel.innerHTML = dir.schools.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} — ${esc(s.county)}</option>`).join("");
      sel.addEventListener("change", () => adminUi().then((m) => m.renderSchoolProfile($("#spBody"), sel.value)).catch(pageFailed($("#spBody"))));
      if (!dir.schools.length) { $("#spBody").innerHTML = emptyState("No schools assigned to you yet", "An administrator assigns your county or schools."); return; }
    }
    adminUi().then((m) => m.renderSchoolProfile($("#spBody"), sel.value)).catch(pageFailed($("#spBody")));
  }
  const countyLine = user.county || "No county set";
  $("#topSub").textContent = countyLine;
  currentTermLabel().then((term) => { if (term) $("#topSub").textContent = `${countyLine} · ${term}`; });

  /* Schools come from the Education Team's school list (the same one every
     County → School picker uses); "visits this term" is the officer's own
     real field reports, counted against the current term. A field officer
     belongs to a county, not a school — they pick the school per visit. */
  let reportsCache = [];
  let directory = { counties: [], schools: [] };

  function renderKpis() {
    const mine = directory.schools.filter((s) => s.county === user.county);
    const thisTerm = termOf(new Date().toISOString());
    const visitsThisTerm = reportsCache.filter((r) => termOf(r.createdAt) === thisTerm).length;
    $("#statRow").innerHTML = `
      <div class="stat-tile"><div class="s-label">${svg(ICON.schools)}Schools in ${esc(user.county || "your county")}</div><div class="s-num">${mine.length}</div><div class="s-sub">${directory.schools.length} listed across all counties</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.visits)}Visits this term</div><div class="s-num">${visitsThisTerm}</div><div class="s-sub">field reports filed</div></div>
      <div class="stat-tile"><div class="s-label">${svg(ICON.counties)}Counties</div><div class="s-num">${directory.counties.length}</div><div class="s-sub">in the programme</div></div>
    `;
  }

  function reportRow(r) {
    const missing = (r.missingForms || []).filter((f) => !waiting(`form:${f.id}:${r.id}`));
    return `<div class="task-row"><div style="flex:1;min-width:0"><b>${esc(r.school)}</b><span>${esc(r.county)} · ${esc(r.visitType)} · ${esc(r.detail)}</span></div>
      ${missing.length ? `<button type="button" class="pill warm" style="border:0;cursor:pointer" data-finish-visit="${esc(r.id)}">${missing.length} form${missing.length === 1 ? "" : "s"} to finish</button>`
        : (r.missingForms || []).length ? `<span class="pill">Waiting to sync</span>` : ""}</div>`;
  }

  /* A visit filed without all its forms: finish them now (offline too —
     they're sent with the next sync). Notifications point here. */
  async function openFinishVisit(id) {
    const r = reportsCache.find((x) => x.id === id);
    if (!r) return;
    const forms = (await getForms().catch(() => [])).filter((f) => (r.missingForms || []).some((m) => m.id === f.id));
    if (!forms.length) { toast("Nothing to finish", "These forms are no longer available."); return; }
    const panel = openContentPanel({
      title: `Finish the visit's forms`,
      html: `<p class="hint" style="margin-top:0"><b>${esc(r.school)}</b> · ${esc(r.visitType)} visit · ${esc(r.detail)}</p>
        <div class="visit-forms-body" data-forms></div>
        <button type="button" class="btn btn-primary btn-block" data-send>Send the forms</button>`,
    });
    renderVisitForms(panel.querySelector("[data-forms]"), forms);
    panel.querySelector("[data-send]").addEventListener("click", async (e) => {
      const box = panel.querySelector("[data-forms]");
      const filled = forms.filter((f) => !unfilledVisitForms(box, [f]).length);
      if (!filled.length) { toast("Fill in at least one form", "", "error"); return; }
      e.target.disabled = true;
      try {
        const responses = await collectVisitResponses(box, filled);
        let queued = 0;
        for (const resp of responses) {
          const res = await addResponse({ ...resp, visitId: r.id, title: forms.find((f) => f.id === resp.formId)?.title });
          if (res?.queued) queued += 1;
        }
        closeViewer();
        toast(queued ? "Saved on this device" : "Forms sent", queued ? "They're sent when you're back online." : `${responses.length} form${responses.length === 1 ? "" : "s"} added to the visit.`, "success");
        refreshReports();
      } catch (err) {
        e.target.disabled = false;
        toast("Couldn't send them", friendlyError(err), "error");
      }
    });
  }
  for (const sel of ["#reportList", "#homeReportList"]) {
    $(sel).addEventListener("click", (e) => {
      const b = e.target.closest("[data-finish-visit]");
      if (b) openFinishVisit(b.dataset.finishVisit);
    });
  }

  let reportsFailed = false;
  function renderReports() {
    if (reportsFailed) {
      const msg = errorState("Couldn't load your visits — check your connection and try again.", refreshReports);
      $("#reportList").innerHTML = msg;
      $("#homeReportList").innerHTML = msg;
      return;
    }
    $("#reportList").innerHTML = reportsCache.length
      ? reportsCache.map(reportRow).join("")
      : `<div class="empty-state">No field reports filed yet.</div>`;
    $("#homeReportList").innerHTML = reportsCache.length
      ? reportsCache.slice(0, 5).map(reportRow).join("")
        + (reportsCache.length > 5 ? `<p class="hint" style="margin-top:.4rem">${reportsCache.length} visits on record — view all.</p>` : "")
      : `<div class="empty-state">No field reports filed yet.</div>`;
  }

  async function refreshReports() {
    $("#reportList").innerHTML = skeleton(3, { avatar: false });
    $("#homeReportList").innerHTML = skeleton(2, { avatar: false });
    try {
      const reports = await getFieldReports();
      reportsCache = reports.map((r) => ({
        id: r.id, school: r.school, county: r.county, visitType: r.visitType, createdAt: r.createdAt,
        detail: new Date(r.createdAt).toLocaleDateString(), missingForms: r.missingForms || [],
      }));
      reportsFailed = false;
    } catch (err) {
      console.error("could not load field reports:", err);
      reportsFailed = true;
      reportsCache = [];
    }
    renderReports();
    renderKpis();
  }

  renderKpis();
  refreshReports();

  // ---- Schools directory — the same county→school list the visit flow uses ----
  function renderDirectory() {
    const { counties, schools } = directory;
    // Their own county first; the rest after.
    const ordered = [...counties].sort((a, b) => (b === user.county) - (a === user.county));
    $("#schoolsDirectory").innerHTML = schools.length
      ? ordered.map((c) => {
          const list = schools.filter((s) => s.county === c);
          return `
            <div class="list-group">
              <div class="list-group-title">${esc(c)}<span class="count">${list.length}</span></div>
              ${list.length
                ? list.map((s) => `<div class="task-row"><div><b>${esc(s.name)}</b><span><span class="code-chip">${esc(s.code)}</span></span></div></div>`).join("")
                : `<div class="empty-state" style="padding:.6rem 0">No schools listed yet.</div>`}
            </div>`;
        }).join("")
      : `<div class="empty-state">No schools listed yet — the Education Team adds them.</div>`;
  }

  /* ---- Start School Visit — the one obvious primary action, walked
     through as a guided flow: county → school → visit type → start →
     complete & submit → confirmation. Recent visits (above) stay visible
     the whole time so a report is never more than a glance away. */
  const stageIdle = $("#visitIdle");
  const stageSelect = $("#visitSelect");
  const stageActive = $("#visitActive");
  const stageConfirmed = $("#visitConfirmed");

  const countySelect = $("#fr_county");
  const schoolSelect = $("#fr_school");
  const visitTypeSelect = $("#fr_visit");
  const schoolField = $("#schoolField");
  const visitTypeField = $("#visitTypeField");
  const startVisitBtn = $("#startVisitBtn");

  visitTypeSelect.innerHTML =
    `<option value="" disabled selected>Select visit type</option>` +
    VISIT_TYPES.map((v) => `<option>${esc(v)}</option>`).join("");

  let currentVisit = null;

  function showStage(stage) {
    stageIdle.hidden = stage !== "idle";
    stageSelect.hidden = stage !== "select";
    stageActive.hidden = stage !== "active";
    stageConfirmed.hidden = stage !== "confirmed";
  }

  function fillCounties() {
    countySelect.innerHTML = `<option value="" disabled selected>Select county</option>` +
      directory.counties.map((c) => `<option>${esc(c)}</option>`).join("");
  }

  /* The Education Team's forms for a kind of visit: field-officer forms
     tagged with this visit type, for this school's county or all. */
  let fieldForms = [];
  const visitForms = (visitType, county) =>
    fieldForms.filter((f) => f.visitType === visitType && (!f.county || f.county === county));

  function renderVisitFormsPreview() {
    const el = $("#visitFormsPreview");
    const school = directory.schools.find((s) => s.id === schoolSelect.value);
    const visitType = visitTypeSelect.value;
    if (!school || !visitType) { el.hidden = true; return; }
    const forms = visitForms(visitType, school.county);
    el.hidden = false;
    el.innerHTML = forms.length
      ? `<div class="visit-forms-head"><b>Forms for ${esc(visitType)} visits</b><span class="count">${forms.length}</span></div>
         <ul class="visit-forms-list">${forms.map((f) =>
           `<li><span class="form-tag">${esc(FORM_KIND_LABEL[f.kind] || "Questions")}</span>${esc(f.title)}</li>`).join("")}</ul>
         <p class="field-hint">You'll fill these in during the visit.</p>`
      : `<p class="field-hint" style="margin:0">No forms for ${esc(visitType)} visits in ${esc(school.county)} yet — you can still log the visit.</p>`;
  }

  function resetWizard() {
    currentVisit = null;
    countySelect.value = "";
    schoolSelect.disabled = true;
    schoolSelect.innerHTML = `<option value="" disabled selected>Select a county first</option>`;
    schoolField.hidden = true;
    visitTypeField.hidden = true;
    visitTypeSelect.value = "";
    startVisitBtn.hidden = true;
    $("#visitFormsPreview").hidden = true;
    $("#visitFormsFill").innerHTML = "";
    showStage("idle");
    showResumeOffer();
  }

  /* ---- the visit draft, saved on this device ----
     Everything filled into a visit is saved in this browser as it's
     typed, so a dropped connection, a closed tab or a flat battery never
     loses a visit: opening the page again offers to resume it. The draft
     carries the visit's own id (clientRef), so sending it more than once —
     a retry, or the automatic send when the connection comes back — files
     one visit, never two. Browsers can't keep chosen files, so after a
     resume the filled copies have to be picked again. */
  const DRAFT_KEY = `hpf_visit_draft_${user.id}`;
  const PENDING_MSG = "Not sent yet — no connection. Saved on this device; it will be sent automatically when you're back online.";
  const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; } };
  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* private mode etc. */ } };
  const newVisitRef = () => crypto.randomUUID
    ? crypto.randomUUID()
    : `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  const setDraftStatus = (msg) => { $("#visitDraftStatus").textContent = msg; };

  function captureAnswers() {
    const out = {};
    $$("#visitFormsFill [data-visit-form]").forEach((box) => {
      const q = {};
      box.querySelectorAll("[data-q]").forEach((el) => { q[el.dataset.q] = el.value; });
      out[box.dataset.visitForm] = {
        q,
        done: !!box.querySelector("[data-f-done]")?.checked,
        file: box.querySelector("[data-f-file]")?.files?.[0]?.name || null,
      };
    });
    return out;
  }

  /* Puts saved answers back; returns the names of files to pick again. A
     form whose filled copy was chosen goes back to "not filled" until the
     file is chosen again (or the box ticked), so it's never sent without it
     by accident. */
  function restoreAnswers(answers = {}) {
    const needFiles = [];
    $$("#visitFormsFill [data-visit-form]").forEach((box) => {
      const a = answers[box.dataset.visitForm];
      if (!a) return;
      box.querySelectorAll("[data-q]").forEach((el) => {
        if (a.q?.[el.dataset.q] != null) el.value = a.q[el.dataset.q];
      });
      const done = box.querySelector("[data-f-done]");
      if (done) done.checked = !!a.done && !a.file;
      if (a.file) needFiles.push(a.file);
    });
    return needFiles;
  }

  function saveDraft(extra = {}) {
    if (!currentVisit) return;
    const draft = {
      ...(loadDraft() || {}), ...extra,
      clientRef: currentVisit.clientRef, schoolId: currentVisit.schoolId, school: currentVisit.school,
      county: currentVisit.county, visitType: currentVisit.visitType,
      startedAt: currentVisit.startedAt.toISOString(), forms: currentVisit.forms,
      answers: captureAnswers(), savedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      setDraftStatus(draft.pending ? PENDING_MSG : "Answers are saved on this device as you go.");
    } catch {
      setDraftStatus("This browser can't save a draft — keep this page open until the visit is sent.");
    }
  }

  function showResumeOffer() {
    const d = loadDraft();
    $("#visitResume").hidden = !d || !!currentVisit;
    if (!d) return;
    const started = new Date(d.startedAt);
    $("#visitResumeText").textContent = `${d.school} · ${d.visitType} · started ${
      started.toLocaleDateString([], { day: "numeric", month: "short" })} ${
      started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${d.pending ? " · not sent yet" : ""}`;
  }

  /* Shows the "visit in progress" stage for a new or resumed visit. */
  function openVisit(visit, answers) {
    currentVisit = visit;
    $("#visitResume").hidden = true;
    $("#activeVisitSummary").innerHTML =
      `<div><b>${esc(visit.school)}</b><br>${esc(visit.county)} · ${esc(visit.visitType)}<br>` +
      `Started ${visit.startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>`;
    const fill = $("#visitFormsFill");
    if (visit.forms.length) {
      fill.innerHTML = `<div class="visit-forms-head"><b>Fill in the visit's forms</b><span class="count">${visit.forms.length}</span></div><div class="visit-forms-body"></div>`;
      renderVisitForms(fill.querySelector(".visit-forms-body"), visit.forms);
    } else {
      fill.innerHTML = "";
    }
    const needFiles = answers ? restoreAnswers(answers) : [];
    showStage("active");
    saveDraft();
    return needFiles;
  }

  $("#visitFormsFill").addEventListener("input", () => saveDraft());
  $("#visitFormsFill").addEventListener("change", () => saveDraft());

  $("#resumeVisitBtn").addEventListener("click", () => {
    const d = loadDraft();
    if (!d) { showResumeOffer(); return; }
    const needFiles = openVisit({
      clientRef: d.clientRef, schoolId: d.schoolId, school: d.school, county: d.county,
      visitType: d.visitType, startedAt: new Date(d.startedAt), forms: d.forms || [],
    }, d.answers);
    if (needFiles.length) {
      toast("Choose the files again", `Browsers can't keep chosen files. Pick the filled copy again for: ${needFiles.join(", ")}.`);
    }
  });
  $("#discardVisitBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Discard the unfinished visit?",
      body: "What was filled in is deleted from this device. This can't be undone.",
      confirmLabel: "Discard visit", danger: true,
    });
    if (!ok) return;
    clearDraft();
    showResumeOffer();
  });

  $("#startVisitCta").addEventListener("click", () => showStage("select"));
  $("#cancelSelectBtn").addEventListener("click", resetWizard);
  $("#cancelActiveBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Cancel this visit?",
      body: "What you've filled in is deleted from this device and nothing is sent.",
      confirmLabel: "Cancel visit", cancelLabel: "Keep filling in", danger: true,
    });
    if (!ok) return;
    clearDraft();
    resetWizard();
  });
  $("#logAnotherBtn").addEventListener("click", resetWizard);

  countySelect.addEventListener("change", () => {
    const schools = directory.schools.filter((s) => s.county === countySelect.value);
    schoolSelect.disabled = schools.length === 0;
    schoolSelect.innerHTML = schools.length
      ? `<option value="" disabled selected>Select a school</option>` +
        schools.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.code)})</option>`).join("")
      : `<option value="" disabled selected>No schools listed for ${esc(countySelect.value)} yet</option>`;
    schoolField.hidden = false;
    visitTypeField.hidden = true;
    startVisitBtn.hidden = true;
    $("#visitFormsPreview").hidden = true;
  });
  schoolSelect.addEventListener("change", () => {
    visitTypeField.hidden = false;
    startVisitBtn.hidden = true;
    renderVisitFormsPreview();
  });
  visitTypeSelect.addEventListener("change", () => {
    startVisitBtn.hidden = false;
    renderVisitFormsPreview();
  });

  startVisitBtn.addEventListener("click", () => {
    const school = directory.schools.find((s) => s.id === schoolSelect.value);
    if (!school) return;
    clearDraft(); // a new visit replaces any draft the officer chose not to resume
    openVisit({
      clientRef: newVisitRef(),
      schoolId: school.id, school: `${school.name} (${school.code})`, county: school.county,
      visitType: visitTypeSelect.value, startedAt: new Date(),
      forms: visitForms(visitTypeSelect.value, school.county),
    });
  });

  const SUBMIT_LABEL = "5 · Complete & submit visit report";
  /* A failure caused by the connection (not a refusal from the server). */
  const isConnectionError = (err) =>
    !navigator.onLine || err instanceof TypeError ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(err?.message || "");

  let submitting = false;
  async function submitVisit({ auto = false } = {}) {
    if (!currentVisit || submitting) return;
    const btn = $("#completeVisitBtn");
    const formsBox = $("#visitFormsFill .visit-forms-body");
    // An automatic resend follows a submit the officer already confirmed.
    if (!auto) {
      const unfilled = formsBox ? unfilledVisitForms(formsBox, currentVisit.forms) : [];
      if (unfilled.length) {
        const ok = await confirmDialog({
          title: `${unfilled.length} form${unfilled.length === 1 ? "" : "s"} not filled in yet`,
          body: `${unfilled.map((f) => f.title).join(", ")}. Submit the visit anyway? Only the filled forms are sent.`,
          confirmLabel: "Submit anyway",
        });
        if (!ok) return;
      }
    }
    submitting = true;
    btn.disabled = true;
    btn.classList.add("is-saving");
    btn.textContent = auto ? "Back online — sending…" : "Saving…";
    const done = () => {
      submitting = false;
      btn.disabled = false;
      btn.classList.remove("is-saving");
      btn.textContent = SUBMIT_LABEL;
    };
    try {
      const responses = formsBox ? await collectVisitResponses(formsBox, currentVisit.forms) : [];
      const res = await addFieldReport({
        schoolId: currentVisit.schoolId, visitType: currentVisit.visitType, responses,
        clientRef: currentVisit.clientRef, label: `Visit: ${currentVisit.school} (${currentVisit.visitType})`,
      });
      currentVisit.formsSent = responses.length;
      // No connection: the visit — filled copies included — waits on this device and goes by itself.
      currentVisit.queued = !!res?.queued;
    } catch (err) {
      console.error("could not save field report:", err);
      done();
      if (isConnectionError(err)) {
        saveDraft({ pending: true });
        toast("No connection — visit saved on this device",
          "It will be sent automatically when you're back online. You can also close the page and resume it later.", "error");
      } else {
        toast("Couldn't submit this visit", friendlyError(err), "error");
      }
      return;
    }
    done();
    clearDraft();
    if (currentVisit.queued) toast("Visit saved on this device", "It's sent automatically when you're back online — you can close the page.", "success");
    else toast("Visit report submitted successfully.", "", "success");
    $("#confirmedSummary").innerHTML =
      `<div><b>${currentVisit.queued ? "Visit saved on this device — waiting to sync" : "Visit report submitted"}</b><br>${esc(currentVisit.school)} · ${esc(currentVisit.county)} · ${esc(currentVisit.visitType)}` +
      `${currentVisit.forms.length ? `<br>${currentVisit.formsSent} of ${currentVisit.forms.length} form${currentVisit.forms.length === 1 ? "" : "s"} sent` : ""}</div>`;
    $("#visitFormsFill").innerHTML = "";
    setDraftStatus("");
    currentVisit = null;
    showStage("confirmed");
    refreshReports();
  }

  $("#completeVisitBtn").addEventListener("click", () => submitVisit());
  // A visit that couldn't be sent goes out by itself when the connection returns.
  window.addEventListener("online", () => {
    if (currentVisit && loadDraft()?.pending) submitVisit({ auto: true });
  });

  resetWizard();

  /* Live list: new or renamed schools/counties from the Education Team
     show up when this tab comes back into view (or within a minute),
     without losing a visit that's half-picked. */
  let directoryLoaded = false;
  function applyDirectory(data) {
    const keep = { county: countySelect.value, school: schoolSelect.value };
    directory = data;
    // Nothing assigned yet: say so, instead of an empty school picker.
    let note = $("#noSchoolsNote");
    if (!note) {
      note = document.createElement("div");
      note.id = "noSchoolsNote";
      note.className = "alert alert-warn";
      note.innerHTML = `<div><b>No schools assigned to you yet</b><span>An administrator assigns the county or schools you support. Until then you can't start a visit.</span></div>`;
      $("#visitIdle")?.prepend(note);
    }
    note.hidden = !!data.schools.length;
    fillCounties();
    const county = directoryLoaded ? keep.county : user.county;
    if (county && directory.counties.includes(county)) {
      countySelect.value = county;
      countySelect.dispatchEvent(new Event("change"));
      if ([...schoolSelect.options].some((o) => o.value === keep.school && o.value)) {
        schoolSelect.value = keep.school;
        schoolSelect.dispatchEvent(new Event("change"));
        if (visitTypeSelect.value) startVisitBtn.hidden = false;
      }
    }
    directoryLoaded = true;
    renderDirectory();
    renderKpis();
  }
  $("#schoolsDirectory").innerHTML = skeleton(3, { avatar: false });
  const schoolsWatch = watchSchools(applyDirectory, (err) => {
    console.error("could not load schools:", err);
    $("#schoolsDirectory").innerHTML = errorState(friendlyError(err), () => schoolsWatch.refresh());
  });

  /* ---- Field surveys (KoboToolbox) ----
     The Education Team attaches a deployed Kobo survey; it shows here with
     an Open survey button that launches Kobo's own web form (prefilled
     with this officer's ID, unchanged). Submission goes straight to
     KoboToolbox; the portal detects it on sync (or the manual "I've
     submitted this" fallback), same as before — the only thing new here
     is sorting each survey into Assigned / In progress / Submitted so
     status is obvious at a glance. "In progress" is a real, if
     device-local, signal: this officer has opened it here but the portal
     hasn't yet seen a submission for it. */
  const koboList = $("#koboSurveyList");
  const koboStartedKey = (id) => `kobo_started_${id}`;

  function koboBucket(s) {
    if (s.submitted) return "submitted";
    try { if (localStorage.getItem(koboStartedKey(s.id))) return "in_progress"; } catch { /* private mode etc. */ }
    return "assigned";
  }

  function koboCard(s) {
    const pill = s.submitted
      ? `<span class="pill ok">Submitted${s.submittedAt ? " · " + new Date(s.submittedAt).toLocaleDateString() : ""}</span>`
      : koboBucket(s) === "in_progress"
        ? `<span class="pill warm">In progress</span>`
        : `<span class="pill">Assigned</span>`;
    return `
      <div class="form-card">
        <div class="fc-head"><h3>${esc(s.title)}</h3>${pill}</div>
        ${s.openUrl
          ? `<a class="kobo-open" href="${esc(s.openUrl)}" target="_blank" rel="noopener" data-kobo-open="${esc(s.id)}">
               <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7M21 3l-9 9M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>
               Open survey</a>`
          : `<div class="fc-meta">This survey has no web form link yet.</div>`}
        ${s.submitted
          ? ""
          : `<div style="margin-top:.5rem"><button type="button" data-kobo-done="${esc(s.id)}"
               style="background:none;border:0;color:var(--brand);font-weight:600;cursor:pointer;font-family:inherit;font-size:.8rem;padding:0">I've submitted this</button></div>`}
      </div>`;
  }

  function renderKoboSurveys(data) {
    const surveys = data?.surveys || [];
    if (!surveys.length) {
      koboList.innerHTML = `<div class="empty-state">${
        data && data.configured === false
          ? "Field surveys aren't set up yet."
          : "No field surveys yet."
      }</div>`;
      return;
    }

    const buckets = { assigned: [], in_progress: [], submitted: [] };
    surveys.forEach((s) => buckets[koboBucket(s)].push(s));

    const section = (key, label, emptyMsg) => `
      <div class="list-group">
        <div class="list-group-title">${label}<span class="count">${buckets[key].length}</span></div>
        ${buckets[key].length ? buckets[key].map(koboCard).join("") : `<div class="empty-state">${emptyMsg}</div>`}
      </div>`;

    koboList.innerHTML =
      section("assigned", "Assigned", "Nothing waiting to be started.") +
      section("in_progress", "In progress", "Nothing opened but not yet submitted.") +
      section("submitted", "Submitted", "Nothing submitted yet.");

    $$("[data-kobo-open]").forEach((a) => a.addEventListener("click", () => {
      try { localStorage.setItem(koboStartedKey(a.dataset.koboOpen), "1"); } catch { /* private mode etc. */ }
    }));
    $$("[data-kobo-done]").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await markKoboSubmitted(btn.dataset.koboDone);
        toast("Marked as submitted.", "", "success");
        loadKoboSurveys();
      } catch (err) {
        console.error("could not mark submitted:", err);
        toast("Couldn't update that", friendlyError(err), "error");
        btn.disabled = false;
      }
    }));
  }

  async function loadKoboSurveys() {
    koboList.innerHTML = skeleton(2, { avatar: false });
    try {
      renderKoboSurveys(await myKoboSurveys());
    } catch (err) {
      console.error("could not load field surveys:", err);
      koboList.innerHTML = errorState(friendlyError(err), loadKoboSurveys);
    }
  }

  $("#koboRefresh")?.addEventListener("click", loadKoboSurveys);
  loadKoboSurveys();

  /* Forms the Education Team has sent to field officers. Stand-alone
     ones are listed here; ones tagged with a visit type are filled inside
     a visit of that type (see "Start School Visit" above), so they're
     kept in fieldForms for the visit flow instead. */
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
    fieldForms = forms.filter((f) => f.audience === "field_officer");
    if (!stageSelect.hidden) renderVisitFormsPreview();
    mountFormList($("#formsList"), { forms: fieldForms, responses, userId: user.id, onSubmitted: renderForms });
  }
}
main();

async function doSignOut() {
  if ((await signOut()) === false) return;
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
