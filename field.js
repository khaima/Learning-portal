import "./nav.js";
import { $, $$, esc, initials, skeleton, emptyState, errorState, friendlyError, toast } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { VISIT_TYPES } from "./data.js";
import {
  getForms, getResponses, addResponse, getFieldReports, addFieldReport, watchSchools,
  myKoboSurveys, markKoboSubmitted,
} from "./store.js";

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
  $("#topSub").textContent = `${user.county || "No county set"} · Term 2, 2026`;

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
    return `<div class="task-row"><div><b>${esc(r.school)}</b><span>${esc(r.county)} · ${esc(r.visitType)} · ${esc(r.detail)}</span></div></div>`;
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
        school: r.school, county: r.county, visitType: r.visitType, createdAt: r.createdAt,
        detail: new Date(r.createdAt).toLocaleDateString(),
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

  function resetWizard() {
    currentVisit = null;
    countySelect.value = "";
    schoolSelect.disabled = true;
    schoolSelect.innerHTML = `<option value="" disabled selected>Select a county first</option>`;
    schoolField.hidden = true;
    visitTypeField.hidden = true;
    visitTypeSelect.value = "";
    startVisitBtn.hidden = true;
    showStage("idle");
  }

  $("#startVisitCta").addEventListener("click", () => showStage("select"));
  $("#cancelSelectBtn").addEventListener("click", resetWizard);
  $("#cancelActiveBtn").addEventListener("click", resetWizard);
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
  });
  schoolSelect.addEventListener("change", () => {
    visitTypeField.hidden = false;
    startVisitBtn.hidden = true;
  });
  visitTypeSelect.addEventListener("change", () => {
    startVisitBtn.hidden = false;
  });

  startVisitBtn.addEventListener("click", () => {
    const school = directory.schools.find((s) => s.id === schoolSelect.value);
    if (!school) return;
    currentVisit = {
      schoolId: school.id, school: `${school.name} (${school.code})`, county: school.county,
      visitType: visitTypeSelect.value, startedAt: new Date(),
    };
    $("#activeVisitSummary").innerHTML =
      `<div><b>${esc(currentVisit.school)}</b><br>${esc(currentVisit.county)} · ${esc(currentVisit.visitType)}<br>` +
      `Started ${currentVisit.startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>`;
    showStage("active");
  });

  $("#completeVisitBtn").addEventListener("click", async (e) => {
    if (!currentVisit) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add("is-saving");
    btn.textContent = "Saving…";
    try {
      await addFieldReport({ schoolId: currentVisit.schoolId, visitType: currentVisit.visitType });
    } catch (err) {
      console.error("could not save field report:", err);
      toast("Couldn't submit this visit", friendlyError(err), "error");
      btn.disabled = false;
      btn.classList.remove("is-saving");
      btn.textContent = "5 · Complete & submit visit report";
      return;
    }
    btn.disabled = false;
    btn.classList.remove("is-saving");
    btn.textContent = "5 · Complete & submit visit report";
    toast("Visit report submitted successfully.", "", "success");
    $("#confirmedSummary").innerHTML =
      `<div><b>Visit report submitted</b><br>${esc(currentVisit.school)} · ${esc(currentVisit.county)} · ${esc(currentVisit.visitType)}</div>`;
    currentVisit = null;
    showStage("confirmed");
    refreshReports();
  });

  resetWizard();

  /* Live list: new or renamed schools/counties from the Education Team
     show up when this tab comes back into view (or within a minute),
     without losing a visit that's half-picked. */
  let directoryLoaded = false;
  function applyDirectory(data) {
    const keep = { county: countySelect.value, school: schoolSelect.value };
    directory = data;
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

  /* Forms the Education Team has sent to field officers — same
     create-once-fill-once loop as the teacher and school-leader
     dashboards. */
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
    forms = forms.filter((f) => f.audience === "field_officer");
    const answeredFormIds = new Set(responses.filter((r) => r.respondentId === user.id).map((r) => r.formId));

    $("#formsList").innerHTML = forms.length
      ? forms.map((f) => {
          const done = answeredFormIds.has(f.id);
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
      btn.addEventListener("click", () => openFormFill(btn.dataset.fillForm, forms, btn))
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
          respondentRole: "field_officer",
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
}
main();

async function doSignOut() {
  await signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
