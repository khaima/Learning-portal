import { $, esc, initials } from "./util.js";
import { requireRole, signOut } from "./auth.js";
import { FIELD_CONTENT, FIELD_SCHOOLS_BY_COUNTY, VISIT_TYPES } from "./data.js";
import { supabase } from "./supabase.js";

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

  /* Reports live in the real learning_portal.field_reports table now — a
     fresh field officer account starts with none, honestly, rather than
     someone else's demo visits. */
  async function loadReports() {
    const { data, error } = await supabase
      .from("field_reports").select("*").eq("officer_id", user.id).order("created_at", { ascending: false });
    if (error) { console.warn("could not load field reports:", error.message); return []; }
    return data.map((r) => ({
      school: r.school, county: r.county, visitType: r.visit_type,
      detail: new Date(r.created_at).toLocaleDateString(),
    }));
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

    const { error } = await supabase.from("field_reports").insert({
      id: "fr_" + Date.now().toString(36),
      officer_id: user.id,
      school, county, visit_type: visitType,
    });
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit field report";
    if (error) { console.warn("could not save field report:", error.message); return; }

    renderReports(await loadReports());
    e.target.reset();
    schoolSelect.disabled = true;
    schoolSelect.innerHTML = `<option value="" disabled selected>Select a county first</option>`;
  });

  $("#reportList").innerHTML = `<div class="empty-state">Loading…</div>`;
  loadReports().then(renderReports);
}

function doSignOut() {
  signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
