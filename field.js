import "./nav.js";
import { $, $$, esc, initials } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { FIELD_CONTENT, FIELD_SCHOOLS_BY_COUNTY, VISIT_TYPES } from "./data.js";
import {
  getForms, getResponses, addResponse, getFieldReports, addFieldReport,
  myKoboSurveys, markKoboSubmitted,
} from "./store.js";

const ICON = {
  schools: '<path d="M4 21V8l8-5 8 5v13"/><path d="M9 21v-6h6v6"/>',
  counties: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>',
  visits: '<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;

async function main() {
  const user = await requireRole("field_officer");
  if (!user) return;
  const seed = FIELD_CONTENT[user.id] || { stats: { schools: 0, counties: 0, visitsThisTerm: 0 }, reports: [] };

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = `Field Officer · ${user.county || "—"}`;
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;
  $("#topSub").textContent = `${user.county || "No county set"} · Term 2, 2026`;

  $("#statRow").innerHTML = `
    <div class="stat-tile"><div class="s-label">${svg(ICON.schools)}Assigned schools</div><div class="s-num">${seed.stats.schools}</div><div class="s-sub">across ${seed.stats.counties} counties</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.visits)}Visits this term</div><div class="s-num">${seed.stats.visitsThisTerm}</div><div class="s-sub">field reports filed</div></div>
    <div class="stat-tile"><div class="s-label">${svg(ICON.counties)}Counties</div><div class="s-num">${seed.stats.counties}</div><div class="s-sub">covered</div></div>
  `;

  /* Reports live in the real learning_portal.field_reports table now — a
     fresh field officer account starts with none, honestly, rather than
     someone else's demo visits. */
  async function loadReports() {
    try {
      const reports = await getFieldReports();
      return reports.map((r) => ({
        school: r.school, county: r.county, visitType: r.visitType,
        detail: new Date(r.createdAt).toLocaleDateString(),
      }));
    } catch (err) {
      console.warn("could not load field reports:", err.message);
      return [];
    }
  }

  function renderReports(reports) {
    $("#reportList").innerHTML = reports.length
      ? reports.map((r) => `
        <div class="task-row"><div><b>${esc(r.school)}</b><span>${esc(r.county)} · ${esc(r.visitType)} · ${esc(r.detail)}</span></div></div>`).join("")
      : `<div class="empty-state">No field reports filed yet.</div>`;
  }

  // ---- county -> school cascade, the real production app's flagship flow ----
  const countySelect = $("#fr_county");
  const schoolSelect = $("#fr_school");
  const visitSelect = $("#fr_visit");

  countySelect.innerHTML =
    `<option value="" disabled selected>Select county</option>` +
    Object.keys(FIELD_SCHOOLS_BY_COUNTY).map((c) => `<option>${esc(c)}</option>`).join("");
  visitSelect.innerHTML =
    `<option value="" disabled selected>Select visit type</option>` +
    VISIT_TYPES.map((v) => `<option>${esc(v)}</option>`).join("");

  countySelect.addEventListener("change", () => {
    const schools = FIELD_SCHOOLS_BY_COUNTY[countySelect.value] || [];
    schoolSelect.disabled = schools.length === 0;
    schoolSelect.innerHTML =
      `<option value="" disabled selected>Select a school</option>` +
      schools.map((s) => `<option>${esc(s)}</option>`).join("");
  });

  $("#reportForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const county = countySelect.value;
    const school = schoolSelect.value;
    const visitType = visitSelect.value;
    if (!county || !school || !visitType) return;

    const submitBtn = e.target.querySelector("[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";

    try {
      await addFieldReport({ school, county, visitType });
    } catch (err) {
      console.warn("could not save field report:", err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit field report";
      return;
    }
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit field report";

    renderReports(await loadReports());
    e.target.reset();
    schoolSelect.disabled = true;
    schoolSelect.innerHTML = `<option value="" disabled selected>Select a county first</option>`;
  });

  $("#reportList").innerHTML = `<div class="empty-state">Loading…</div>`;
  loadReports().then(renderReports);

  /* ---- Field surveys (KoboToolbox) ----
     The Education Team attaches a deployed Kobo survey; it shows here with
     an Open survey button that launches Kobo's own web form (prefilled
     with this officer's ID). Submission goes straight to KoboToolbox; the
     pill flips to "Submitted" once the portal detects it (auto-sync on
     load, or the manual "I've submitted this" fallback). */
  const koboList = $("#koboSurveyList");

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
    koboList.innerHTML = surveys.map((s) => {
      const pill = s.submitted
        ? `<span class="pill ok">Submitted${s.submittedAt ? " · " + new Date(s.submittedAt).toLocaleDateString() : ""}</span>`
        : `<span class="pill warm">Pending</span>`;
      return `
        <div class="form-card">
          <div class="fc-head"><h3>${esc(s.title)}</h3>${pill}</div>
          ${s.openUrl
            ? `<a class="kobo-open" href="${esc(s.openUrl)}" target="_blank" rel="noopener">
                 <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7M21 3l-9 9M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>
                 Open survey</a>`
            : `<div class="fc-meta">This survey has no web form link yet.</div>`}
          ${s.submitted
            ? ""
            : `<div style="margin-top:.5rem"><button type="button" class="btn-link" data-kobo-done="${esc(s.id)}"
                 style="background:none;border:0;color:var(--brand);font-weight:600;cursor:pointer;font-family:inherit;font-size:.8rem;padding:0">I've submitted this</button></div>`}
        </div>`;
    }).join("");

    $$("[data-kobo-done]").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await markKoboSubmitted(btn.dataset.koboDone);
        loadKoboSurveys();
      } catch (err) {
        console.warn("could not mark submitted:", err.message);
        btn.disabled = false;
      }
    }));
  }

  async function loadKoboSurveys() {
    koboList.innerHTML = `<div class="empty-state">Loading…</div>`;
    try {
      renderKoboSurveys(await myKoboSurveys());
    } catch (err) {
      console.warn("could not load field surveys:", err.message);
      koboList.innerHTML = `<div class="empty-state">Couldn't load field surveys.</div>`;
    }
  }

  $("#koboRefresh")?.addEventListener("click", loadKoboSurveys);
  loadKoboSurveys();

  /* Forms the Education Team has sent to field officers — same
     create-once-fill-once loop as the teacher and school-leader
     dashboards. */
  renderForms();
  async function renderForms() {
    $("#formsList").innerHTML = `<div class="empty-state">Loading…</div>`;
    const [allForms, responses] = await Promise.all([getForms(), getResponses()]);
    const forms = allForms.filter((f) => f.audience === "field_officer");
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
      : `<div class="empty-state">No forms from the Education Team yet.</div>`;

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
        respondentRole: "field_officer",
        answers,
      });
      renderForms();
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
