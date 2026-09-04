import { $, esc, initials } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { FIELD_CONTENT, FIELD_SCHOOLS_BY_COUNTY, VISIT_TYPES } from "./data.js";

const ICON = {
  schools: '<path d="M4 21V8l8-5 8 5v13"/><path d="M9 21v-6h6v6"/>',
  counties: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>',
  visits: '<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;

const user = requireRole("field_officer");
if (user) {
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

  // Persisted per-user, same pattern as the learner's assignment list: the
  // seed reports are the starting point, every report submitted from this
  // page appends to the saved copy.
  const key = `hpf_learning_portal_reports_${user.id}`;
  function loadReports() {
    try {
      const stored = JSON.parse(localStorage.getItem(key));
      if (Array.isArray(stored)) return stored;
    } catch { /* fall through to seed */ }
    return seed.reports.map((r) => ({ ...r }));
  }
  function saveReports(list) {
    localStorage.setItem(key, JSON.stringify(list));
  }
  let reports = loadReports();

  function renderReports() {
    $("#reportList").innerHTML = reports.length
      ? reports.map((r) => `
        <div class="task-row"><div><b>${esc(r.school)}</b><span>${esc(r.county)} · ${esc(r.visitType)} · ${esc(r.detail)}</span></div></div>`).join("")
      : `<div class="empty-state">No field reports filed yet.</div>`;
  }
  renderReports();

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

  $("#reportForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const county = countySelect.value;
    const school = schoolSelect.value;
    const visitType = visitSelect.value;
    if (!county || !school || !visitType) return;
    reports = [{ school, county, visitType, detail: "just now" }, ...reports];
    saveReports(reports);
    renderReports();
    e.target.reset();
    schoolSelect.disabled = true;
    schoolSelect.innerHTML = `<option value="" disabled selected>Select a county first</option>`;
  });
}

function doSignOut() {
  signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
