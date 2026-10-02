import "./nav.js";
import { $, $$, esc, initials, toast, formatDuration, skeleton, errorState, friendlyError, confirmDialog } from "./util.js";
import { requireRole, signOut, sendPasswordResetLink } from "./auth.js";
import {
  CONTENT_TYPES, LIBRARY_SUBJECTS, LIBRARY_AUDIENCES, FORM_AUDIENCES, QUESTION_TYPES, ROLES,
  normalizeLibraryAudience, VISIT_TYPES, PORTAL_ADMIN_ROLES,
} from "./data.js";
import {
  getLibrary, addLibraryItem, setLibraryPublished, deleteLibraryItem, updateLibraryItem, getForms, addForm, deleteForm, archiveForm, restoreForm, getResponses, getStats, getIntelligence,
  dqSummary, dqIssues, dqBulkStatus, dqScan,
  uploadLibraryFiles, libraryFilesHtml, libraryTypeIcon, librarySectionsHtml, getLibraryUsage,
  getLibraryFolders, createLibraryFolder, deleteLibraryFolder, setLibraryFolder,
  koboConfig, saveKoboConfig, koboAssets, koboAssetPreview, koboForms, attachKoboForm,
  removeKoboForm, restoreKoboForm, syncKobo, koboResults,
  getUserDirectory, updateUser, resetUserPassword,
  approveUser, rejectUser, setUserStatus, getInvitations, inviteStaff, revokeInvitation, getAuditLog,
  getLearners, getAcademicYears, createAcademicYear,
  watchSchools, createSchool, renameSchool, deleteSchool, createCounty, deleteCounty, wireSchoolPicker,
} from "./store.js";
import { openIframeViewer } from "./viewer.js";
import { formTagsHtml } from "./forms.js";
import { statusPill, openHistoryPanel, openTransferDialog } from "./learners-ui.js";
import { overviewHtml, learningHtml, implementationHtml, dataCollectionHtml, impactHtml } from "./intelligence-ui.js";
import { openKoboPipeline, webhookBoxHtml, wireWebhookBox } from "./kobo-ui.js";
import { dqTopHtml, dqTypesHtml, dqListHtml, openDqIssue } from "./dq-ui.js";

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
  const user = await requireRole(PORTAL_ADMIN_ROLES);
  if (!user) return;

  /* What this person may do, from the server (GET /me). Used only to
     decide what to show — every action is checked again by the API. */
  const perms = new Set(user.permissions || []);
  const has = (...p) => p.some((x) => perms.has(x));
  const PAGE_NEEDS = {
    overview: ["intelligence.view"],
    learning: ["intelligence.view"],
    implementation: ["intelligence.view"],
    "data-collection": ["intelligence.view"],
    "data-quality": ["data_quality.view"],
    impact: ["intelligence.view"],
    schools: ["stats.view", "schools.manage"],
    users: ["users.view"],
    content: ["library.manage", "library.usage.view"],
    forms: ["forms.manage", "forms.responses.view"],
    kobo: ["kobo.manage", "kobo.results.view"],
    reports: ["stats.view"],
  };
  for (const link of $$(".side-nav .side-link[data-page]")) {
    const needs = PAGE_NEEDS[link.dataset.page];
    if (needs && !has(...needs)) link.hidden = true;
  }
  // A group heading with nothing visible under it goes too.
  for (const g of $$(".side-nav .side-group")) {
    let el = g.nextElementSibling, any = false;
    while (el && !el.classList.contains("side-group")) { if (!el.hidden) any = true; el = el.nextElementSibling; }
    g.hidden = !any;
  }
  const firstVisible = $$(".side-nav .side-link[data-page]").find((l) => !l.hidden);
  const current = $(`.side-nav .side-link[data-page="${(location.hash || "").slice(1)}"]`);
  if (firstVisible && (!current || current.hidden)) location.hash = `#${firstVisible.dataset.page}`;
  // Read-only access (e.g. M&E): hide the editing tools the API would refuse.
  const hideUnless = (el, ...p) => { if (el && !has(...p)) el.hidden = true; };
  hideUnless($("#addSchoolForm"), "schools.manage");
  hideUnless($(".county-manage"), "schools.manage");
  hideUnless($(".upload-panel"), "library.manage");
  hideUnless($("#formBuilder")?.closest(".panel"), "forms.manage");

  $("#sideAvatar").textContent = initials(user.fullName);
  $("#sideName").textContent = user.fullName;
  $("#sideMeta").textContent = ROLE_LABEL[user.role] || "Education Team";
  $("#greeting").textContent = `Habari, ${(user.fullName || "there").split(" ")[0]}`;

  /* ------------------------------------------------------------ global filters
     One filter bar drives every page that has real, scopeable data behind
     it (Overview, Programme Analytics, Schools, Users, Content's usage
     report). Term is just a friendly preset for the same from/to pair the
     date pickers set — see termBounds(). Pages with nothing school/county/
     date-scoped in their data model (Forms, Kobo Surveys, Reports) simply
     don't read this state. */
  const gf = { county: "", school: "", from: "", to: "", role: "" };
  // The live county/school list (see "school list" below) — the one source
  // for every county/school dropdown on this dashboard.
  let schoolDir = { counties: [], countyCodes: {}, schools: [] };
  let userPicker = null; // the County → School picker in an open Users editor
  let invitePicker = null; // the County → School picker in the invite form
  let lastStats = null;
  let formsCache = [];
  let responsesCache = [];
  let koboState = { configured: false };

  // Local calendar date, not toISOString() — that converts through UTC and
  // silently shifts a term boundary by a day in timezones ahead of UTC.
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function termBounds(year, term) {
    const from = new Date(year, (term - 1) * 4, 1);
    const to = new Date(year, (term - 1) * 4 + 4, 0);
    return { from: isoDate(from), to: isoDate(to) };
  }
  function termOptions() {
    const now = new Date();
    const curTerm = now.getMonth() <= 3 ? 1 : now.getMonth() <= 7 ? 2 : 3;
    const opts = [{ value: "", label: "All time" }];
    for (const year of [now.getFullYear(), now.getFullYear() - 1]) {
      for (let term = 3; term >= 1; term--) {
        if (year === now.getFullYear() && term > curTerm) continue;
        const b = termBounds(year, term);
        opts.push({ value: `${b.from}|${b.to}`, label: `${year} Term ${term}` });
      }
    }
    opts.push({ value: "custom", label: "Custom range…" });
    return opts;
  }
  function termLabelFor(from, to) {
    if (!from && !to) return null;
    const now = new Date();
    for (const year of [now.getFullYear(), now.getFullYear() - 1]) {
      for (let term = 1; term <= 3; term++) {
        const b = termBounds(year, term);
        if (b.from === from && b.to === to) return `Term ${term}, ${year}`;
      }
    }
    return null;
  }
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  function dateRangeLabel(from, to) {
    if (from && to) return `${fmtDate(from)} – ${fmtDate(to)}`;
    if (from) return `From ${fmtDate(from)}`;
    if (to) return `Until ${fmtDate(to)}`;
    return "";
  }
  // A filter is active → an emptier, more specific message than the
  // page's usual "nothing here yet" — see the brief: "No data available
  // for this filter."
  function emptyMsg(base) {
    return (gf.county || gf.school || gf.from || gf.to || gf.role) ? "No data available for this filter." : base;
  }

  $("#gfTerm").innerHTML = termOptions().map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
  $("#gfRole").innerHTML = `<option value="">All roles</option>` + ROLES.map((r) => `<option value="${r.value}">${esc(r.label)}</option>`).join("");

  function updateFilterSummary() {
    const parts = [];
    if (gf.county) parts.push(`${gf.county} County`);
    if (gf.school) parts.push(gf.school);
    if (gf.from || gf.to) parts.push(termLabelFor(gf.from, gf.to) || dateRangeLabel(gf.from, gf.to));
    if (gf.role) parts.push(ROLE_LABEL[gf.role] || gf.role);
    const el = $("#gfSummary");
    if (!parts.length) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = `Showing data for: ${parts.join(" / ")}`;
  }

  async function applyFilters() {
    updateFilterSummary();
    await renderStats();
    renderUsersList();
    renderUsage();
  }

  /* County/School filter options come from the live school list (never
     from whatever text is in people's profiles), with the school list
     narrowed to the chosen county. With `clearMissing` (a live-list
     refresh), a pick that no longer exists — a school or county removed
     or renamed — is cleared and true is returned so the caller re-applies
     the filters; otherwise (e.g. drilling into a chart label from an
     older, not-yet-placed account) the pick is kept and shown as-is. */
  function renderGlobalFilterOptions({ clearMissing = false } = {}) {
    let cleared = false;
    if (clearMissing && gf.county && !schoolDir.counties.includes(gf.county)) { gf.county = ""; gf.school = ""; cleared = true; }
    const list = schoolDir.schools.filter((s) => !gf.county || s.county === gf.county);
    const missing = gf.school && !list.some((s) => s.name === gf.school);
    if (clearMissing && missing) { gf.school = ""; cleared = true; }
    const extraCounty = gf.county && !schoolDir.counties.includes(gf.county) ? [gf.county] : [];
    $("#gfCounty").innerHTML = `<option value="">All counties</option>` +
      [...schoolDir.counties, ...extraCounty].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    $("#gfSchool").innerHTML = `<option value="">All schools</option>` +
      list.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (${esc(s.code)})</option>`).join("") +
      (gf.school && !list.some((s) => s.name === gf.school) ? `<option value="${esc(gf.school)}">${esc(gf.school)}</option>` : "");
    $("#gfCounty").value = gf.county;
    $("#gfSchool").value = gf.school;
    return cleared;
  }

  /* Filter to one school from a chart/list click: its county follows
     along so the School dropdown can show it. */
  function pickSchoolFilter(name) {
    gf.school = name;
    const inCounty = schoolDir.schools.find((s) => s.name === name && s.county === gf.county);
    const any = inCounty || schoolDir.schools.find((s) => s.name === name);
    if (any) gf.county = any.county;
    renderGlobalFilterOptions();
  }

  $("#gfCounty").addEventListener("change", (e) => {
    gf.county = e.target.value;
    gf.school = ""; // a school from the old county may not exist in the new one
    renderGlobalFilterOptions();
    applyFilters();
  });
  $("#gfSchool").addEventListener("change", (e) => {
    gf.school = e.target.value;
    applyFilters();
  });
  $("#gfTerm").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === "custom") {
      $("#gfFromField").hidden = false;
      $("#gfToField").hidden = false;
      return; // wait for the actual date pickers
    }
    $("#gfFromField").hidden = true;
    $("#gfToField").hidden = true;
    const [from, to] = v ? v.split("|") : ["", ""];
    gf.from = from; gf.to = to;
    applyFilters();
  });
  $("#gfFrom").addEventListener("change", (e) => { gf.from = e.target.value; applyFilters(); });
  $("#gfTo").addEventListener("change", (e) => { gf.to = e.target.value; applyFilters(); });
  $("#gfRole").addEventListener("change", (e) => { gf.role = e.target.value; applyFilters(); });
  $("#gfClear").addEventListener("click", () => {
    gf.county = ""; gf.school = ""; gf.from = ""; gf.to = ""; gf.role = "";
    renderGlobalFilterOptions();
    $("#gfTerm").value = ""; $("#gfRole").value = "";
    $("#gfFromField").hidden = true; $("#gfToField").hidden = true;
    applyFilters();
  });

  /* ------------------------------------------------------------ live org-wide stats
     Real aggregation, computed server-side from every account and everything
     they've produced (see the /stats route). A field report filed on the
     Field Officer dashboard, or an assignment marked done by a learner,
     changes these numbers on the next load, from any device. Scoped by the
     global filters above — county/school/role throughout, date range only
     where a real date exists (new-learner intake, field visits). */
  async function renderStats() {
    dqOffset = 0;
    renderDq();
    renderIntelligence();
    $("#schoolsBody").innerHTML = skeleton(4);
    let s;
    try {
      s = await getStats({ county: gf.county, school: gf.school, from: gf.from, to: gf.to });
    } catch (err) {
      console.error("could not load stats:", err);
      const msg = errorState(friendlyError(err, "Couldn't load this data."), renderStats);
      $("#schoolsBody").innerHTML = msg;
      return;
    }
    lastStats = s;
    renderSchoolsPage(s);
    renderAttention();
  }

  /* ------------------------------------------------------------ programme intelligence
     One read feeds the Overview and the four areas — Learning,
     Implementation, Data collection, Impact — under the same global
     filters (county / school throughout; the date range on rows that
     carry a real date). Computed server-side: see /intelligence. */
  let lastIntel = null;
  const INTEL_PAGES = ["learning", "implementation", "data-collection", "impact"];
  async function renderIntelligence() {
    if (!has("intelligence.view")) return;
    $("#statRow").innerHTML = skeleton(4, { avatar: false });
    for (const p of INTEL_PAGES) $(`#intel-${p}`).innerHTML = skeleton(4);
    let d;
    try {
      d = await getIntelligence({ county: gf.county, school: gf.school, from: gf.from, to: gf.to });
    } catch (err) {
      console.error("could not load programme intelligence:", err);
      const msg = errorState(friendlyError(err, "Couldn't load this data."), renderIntelligence);
      $("#statRow").innerHTML = msg;
      $("#intelAreas").innerHTML = "";
      for (const p of INTEL_PAGES) $(`#intel-${p}`).innerHTML = msg;
      return;
    }
    lastIntel = d;
    const o = overviewHtml(d);
    $("#statRow").innerHTML = o.tiles + (lastDq?.score ? dqTile(lastDq) : "");
    $("#intelAreas").innerHTML = o.areas;
    $("#intel-learning").innerHTML = learningHtml(d);
    $("#intel-implementation").innerHTML = implementationHtml(d);
    $("#intel-data-collection").innerHTML = dataCollectionHtml(d);
    $("#intel-impact").innerHTML = impactHtml(d);
    const scope = d.scope.school || d.scope.county || "every school";
    for (const m of $$("[data-intel-meta]")) m.textContent = `${scope} · updated ${new Date(d.generatedAt).toLocaleTimeString()}`;
    if (d.currentTerm) $("#topSub").textContent = `Live across every account · ${d.currentTerm}`;
    renderAttention();
  }
  /* ------------------------------------------------------------ Data Quality Center
     Issues found by scans, their status and history, and corrections.
     Scans run when the page (or the Overview) is opened and the last one
     is over 15 minutes old, and on "Scan now". */
  let lastDq = null;
  let dqOffset = 0;
  const dqSelected = new Set();
  const DQ_PAGE = 40;
  const dqTile = (s) => `<a class="stat-tile dq-tile-link" href="#data-quality"><div class="s-label">Data quality</div><div class="s-num">${s.score.value}</div><div class="s-sub">${esc(s.score.label)} · ${s.totals.byStatus.OPEN + s.totals.byStatus.UNDER_REVIEW} open issue${s.totals.byStatus.OPEN + s.totals.byStatus.UNDER_REVIEW === 1 ? "" : "s"}</div></a>`;
  const dqFilters = (withList = false) => ({
    county: gf.county, school: gf.school, from: gf.from, to: gf.to,
    ...(withList ? { type: $("#dq_type").value, severity: $("#dq_severity").value, status: $("#dq_status").value, q: $("#dq_q").value.trim() } : {}),
  });
  $("#dq_type").innerHTML = `<option value="">All types</option>${[
    ["duplicate_learner", "Duplicate learner records"], ["duplicate_staff", "Duplicate staff records"], ["missing_school", "Missing school"],
    ["missing_county", "Missing county"], ["school_county_mismatch", "Invalid school / county combination"], ["missing_grade", "Missing grade"],
    ["invalid_grade", "Invalid grade"], ["duplicate_kobo_submission", "Duplicate Kobo submissions"], ["unmatched_kobo_officer", "Unmatched Kobo officer references"],
    ["missing_kobo_required", "Missing required Kobo fields"], ["orphaned_record", "Orphaned records"], ["invalid_date", "Invalid dates"],
    ["inactive_user_active_assignment", "Inactive users with active assignments"], ["learner_without_class", "Learners without a class"],
    ["staff_without_school", "Teachers / school heads without a school"],
  ].map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}`;

  /** The score, counts and checks — scanning first when the last scan is
      stale (or on "Scan now"). Also feeds the Overview tile and "Needs attention". */
  async function renderDq({ scan = false } = {}) {
    if (!has("data_quality.view")) return;
    $("#dqTop").innerHTML = skeleton(3, { avatar: false });
    let s;
    try {
      if (scan) await dqScan();
      s = await dqSummary(dqFilters());
      if (!scan && s.stale) {
        await dqScan({ auto: true });
        s = await dqSummary(dqFilters());
      }
    } catch (err) {
      $("#dqTop").innerHTML = errorState(friendlyError(err), () => renderDq());
      return;
    }
    lastDq = s;
    $("#dqMeta").textContent = s.lastScan ? `last scan ${new Date(s.lastScan.at).toLocaleString()}` : "not scanned yet";
    $("#dqTop").innerHTML = dqTopHtml(s);
    $("#dqTypes").innerHTML = dqTypesHtml(s);
    if (lastIntel && s.score && !$("#statRow .dq-tile-link")) $("#statRow").insertAdjacentHTML("beforeend", dqTile(s));
    renderAttention();
    renderDqList();
  }

  async function renderDqList() {
    $("#dqList").innerHTML = skeleton(4);
    let res;
    try {
      res = await dqIssues({ ...dqFilters(true), limit: DQ_PAGE, offset: dqOffset });
    } catch (err) {
      $("#dqList").innerHTML = errorState(friendlyError(err), renderDqList);
      return;
    }
    const canManage = has("data_quality.manage");
    $("#dqCount").textContent = `${res.total} issue${res.total === 1 ? "" : "s"}`;
    $("#dqList").innerHTML = dqListHtml(res.issues, dqSelected, canManage);
    $("#dqPager").innerHTML = res.total > DQ_PAGE ? `
      <span>${dqOffset + 1}–${Math.min(res.total, dqOffset + DQ_PAGE)} of ${res.total}</span>
      <span><button type="button" class="btn btn-outline q-small" data-dq-page="-1" ${dqOffset ? "" : "disabled"}>← Previous</button>
      <button type="button" class="btn btn-outline q-small" data-dq-page="1" ${dqOffset + DQ_PAGE < res.total ? "" : "disabled"}>Next →</button></span>` : "";
    syncDqBulk();
  }
  function syncDqBulk() {
    $("#dqBulk").hidden = !dqSelected.size;
    $("#dqBulkCount").textContent = `${dqSelected.size} selected`;
  }
  const dqRefresh = () => { renderDq(); renderAttention(); };

  for (const id of ["#dq_type", "#dq_severity", "#dq_status"]) {
    $(id).addEventListener("change", () => { dqOffset = 0; dqSelected.clear(); renderDqList(); });
  }
  let dqSearchTimer = null;
  $("#dq_q").addEventListener("input", () => {
    clearTimeout(dqSearchTimer);
    dqSearchTimer = setTimeout(() => { dqOffset = 0; renderDqList(); }, 300);
  });
  $("#dqScanBtn").addEventListener("click", async () => {
    const btn = $("#dqScanBtn");
    btn.disabled = true;
    btn.textContent = "Scanning…";
    try {
      const r = await dqScan();
      toast("Scan finished", `${r.found} issue(s) found: ${r.opened} new, ${r.reopened} reopened, ${r.autoResolved} resolved at the source. Score ${r.score}.`, "success");
      await renderDq();
    } catch (err) {
      toast("Couldn't scan", friendlyError(err), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Scan now";
    }
  });
  $("#dqTypes").addEventListener("click", (e) => {
    const row = e.target.closest("[data-dq-type]");
    if (!row) return;
    $("#dq_type").value = row.dataset.dqType;
    $("#dq_status").value = "active";
    dqOffset = 0;
    renderDqList();
    $("#dqList").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#dqList").addEventListener("change", (e) => {
    const box = e.target.closest("[data-dq-select]");
    if (!box) return;
    if (box.checked) dqSelected.add(box.dataset.dqSelect); else dqSelected.delete(box.dataset.dqSelect);
    syncDqBulk();
  });
  $("#dqList").addEventListener("click", (e) => {
    if (!e.target.closest("[data-dq-open]")) return;
    openDqIssue(e.target.closest("[data-dq-issue]").dataset.dqIssue, { onChange: dqRefresh });
  });
  $("#dqPager").addEventListener("click", (e) => {
    const b = e.target.closest("[data-dq-page]");
    if (!b) return;
    dqOffset = Math.max(0, dqOffset + Number(b.dataset.dqPage) * DQ_PAGE);
    renderDqList();
  });
  $("#dqBulk").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-bulk]");
    if (!b) return;
    if (b.dataset.bulk === "clear") { dqSelected.clear(); renderDqList(); return; }
    const note = $("#dqBulkNote").value.trim();
    try {
      const r = await dqBulkStatus([...dqSelected], b.dataset.bulk, note);
      toast(`${r.changed} issue(s) updated`, r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped[0]}` : "", r.skipped.length ? "error" : "success");
      dqSelected.clear();
      $("#dqBulkNote").value = "";
      dqRefresh();
    } catch (err) {
      toast("Couldn't update them", friendlyError(err), "error");
    }
  });

  // A school name anywhere on these pages narrows everything to it.
  for (const p of INTEL_PAGES) {
    $(`#intel-${p}`).addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pick-school]");
      if (!btn) return;
      pickSchoolFilter(btn.dataset.pickSchool);
      applyFilters();
    });
  }

  /* "Needs attention" — the one actionable panel on the otherwise-light
     Overview page. Every item here is a real, already-fetched signal
     (never a manufactured "task"): forms nobody has responded to yet,
     KoboToolbox not connected, schools with no field visit on record.
     Called again as each of those three sources resolves, so it's
     correct as soon as all three are in, regardless of load order. */
  function renderAttention() {
    if (!lastStats) return;
    const s = lastStats;
    const items = [];
    for (const f of formsCache.filter((f) => !f.archivedAt && !responsesCache.some((r) => r.formId === f.id)).slice(0, 5)) {
      items.push({ tone: "warn", title: "Form with no responses yet", detail: `"${f.title}" (sent to ${AUDIENCE_LABEL[f.audience] || f.audience}) has no responses yet.` });
    }
    // Data problems: from the Data Quality Center (open and under review).
    const sevRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    for (const t of (lastDq?.byType || []).filter((t) => t.OPEN + t.UNDER_REVIEW).sort((a, b) => sevRank[a.severity] - sevRank[b.severity]).slice(0, 6)) {
      items.push({ tone: t.severity === "HIGH" ? "warn" : "info", title: t.label, detail: `${t.OPEN + t.UNDER_REVIEW} open — see Data quality.` });
    }
    if (!koboState.configured) {
      items.push({ tone: "info", title: "KoboToolbox not connected", detail: "Connect a KoboToolbox account to attach field surveys — see Kobo Surveys." });
    }
    if (!s.school) {
      const visited = new Set((s.fieldReportsBySchool || []).map((d) => d.label));
      for (const name of (s.schools || []).filter((n) => !visited.has(n)).slice(0, 5)) {
        items.push({ tone: "warn", title: "No field visits recorded", detail: `${name} has no field visit on record${s.county ? " in " + esc(s.county) : ""}.` });
      }
    }
    // Details are plain text (form titles and school names come from users)
    // — escaped here, once, so nothing in them can run as HTML.
    $("#attentionList").innerHTML = items.length
      ? items.map((it) => `<div class="alert alert-${it.tone}"><div><b>${esc(it.title)}</b>${esc(it.detail)}</div></div>`).join("")
      : `<div class="empty-state">${emptyMsg("Nothing needs attention right now.")}</div>`;
  }

  /* ------------------------------------------------------------ Schools
     Drill from summary → school → relevant records: no school picked shows
     the directory (every school in the current county/date scope); picking
     one shows that school's real numbers, reusing the same /stats call
     already made for Overview/Analytics — no extra fetch — plus a link to
     that school's staff on the Users page (permissions allow education
     team to see staff records; individual learners stay off this
     dashboard, same as everywhere else here). */
  function renderSchoolsPage(s) {
    const heading = $("#schoolsHeading");
    const body = $("#schoolsBody");

    if (!s.school) {
      heading.textContent = s.county ? `Schools — ${s.county}` : "Schools";
      const schools = s.schools || [];
      body.innerHTML = schools.length
        ? schools.map((name) => `
            <div class="task-row">
              <div style="flex:1"><b>${esc(name)}</b></div>
              <button type="button" class="pill" style="border:0;cursor:pointer" data-view-school="${esc(name)}">View school</button>
            </div>`).join("")
        : `<div class="empty-state">${emptyMsg("No schools recorded yet.")}</div>`;
      return;
    }

    heading.textContent = s.school;
    const r = s.byRole || {};
    const learnerTotal = (s.learnersByGrade || []).reduce((a, d) => a + d.value, 0);
    const pct = s.assignmentsTotal ? Math.round((s.assignmentsDone / s.assignmentsTotal) * 100) : null;
    body.innerHTML = `
      <button type="button" id="schoolsBack" style="background:none;border:0;padding:0;color:var(--brand);font-weight:600;cursor:pointer;font-family:inherit;font-size:.82rem;margin-bottom:.7rem">← All schools</button>
      <p class="hint" style="margin-top:0">${esc(s.school)}${s.county ? " · " + esc(s.county) : ""}</p>
      <div class="chart-stats" style="grid-template-columns:repeat(5,1fr)">
        <div><b>${r.teacher || 0}</b><span>Teachers</span></div>
        <div><b>${learnerTotal}</b><span>Learners</span></div>
        <div><b>${pct != null ? pct + "%" : "—"}</b><span>Work handed in</span></div>
        <div><b>${s.achievement?.averagePercent != null ? Math.round(s.achievement.averagePercent) + "%" : "—"}</b><span>Average mark</span></div>
        <div><b>${s.reportsFiled || 0}</b><span>Field visits</span></div>
      </div>
      <div style="margin-top:1rem"><button type="button" class="btn btn-outline" id="schoolViewStaff">View staff at this school →</button></div>
    `;
  }

  $("#schoolsBody").addEventListener("click", (e) => {
    const viewBtn = e.target.closest("[data-view-school]");
    if (viewBtn) {
      pickSchoolFilter(viewBtn.dataset.viewSchool);
      updateFilterSummary();
      renderStats();
      renderUsersList();
      renderUsage();
      return;
    }
    if (e.target.id === "schoolsBack") {
      gf.school = "";
      renderGlobalFilterOptions();
      updateFilterSummary();
      renderStats();
      renderUsersList();
      renderUsage();
      return;
    }
    if (e.target.id === "schoolViewStaff") {
      $("#usersSearch").value = gf.school;
      location.hash = "#users";
      renderUsersList();
    }
  });

  /* ------------------------------------------------------------ content library */
  $("#up_subject").innerHTML = LIBRARY_SUBJECTS.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#up_type").innerHTML = CONTENT_TYPES.map((t) => `<option>${esc(t)}</option>`).join("");
  // Short names in the picker ("Digital Library"); the "who sees it"
  // half of each label shows as a hint underneath instead of being
  // clipped inside a narrow select.
  const audienceName = (a) => a.label.split(" — ")[0];
  const audienceWho = (a) => {
    const who = a.label.split(" — ")[1] || "";
    return who.charAt(0).toUpperCase() + who.slice(1);
  };
  $("#up_audience").innerHTML = LIBRARY_AUDIENCES.map((a) => `<option value="${a.value}">${esc(audienceName(a))}</option>`).join("");
  function refreshAudienceHint() {
    const a = LIBRARY_AUDIENCES.find((x) => x.value === $("#up_audience").value);
    $("#up_audience_hint").textContent = a ? audienceWho(a) : "";
  }
  $("#up_audience").addEventListener("change", refreshAudienceHint);
  refreshAudienceHint();

  const AUDIENCE_PILL = {
    staff: { cls: "", label: "Teacher Resources" },
    school_leader: { cls: " warm", label: "For School Head" },
    library: { cls: " ok", label: "Digital Library" },
  };

  /* Organizational folders (library_folders) — separate from the
     upload form's own file/folder picker above (many files as one
     item). Cached here so the upload form's inline folder picker, each
     row's "Move to folder" control, and each row's edit form all stay
     in sync without three separate fetches. */
  let allFolders = [];
  // The library list itself, cached alongside — lets entering/leaving
  // edit mode just re-render from memory instead of refetching, so
  // typing a correction never fights a network round-trip.
  let cachedItems = [];
  let editingItemId = null;

  function foldersFor(audience) {
    return allFolders.filter((f) => f.audience === audience);
  }

  // The upload form's folder choices depend on whichever destination is
  // currently selected — a folder can only ever hold items that share
  // its own audience (the API enforces this too). A trailing "+ Create
  // new folder…" option is how the inline creator below gets opened.
  function refreshUploadFolderOptions() {
    const sel = $("#up_folder");
    const keep = sel.value === "__new__" ? "" : sel.value;
    const opts = foldersFor($("#up_audience").value);
    sel.innerHTML = `<option value="">No folder</option>${
      opts.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")
    }<option value="__new__">+ Create new folder…</option>`;
    if (opts.some((f) => f.id === keep)) sel.value = keep;
  }

  // The "Manage folders" chip row, scoped to whichever destination is
  // currently selected — only shown when that destination actually has
  // folders, so the upload form stays uncluttered until it's useful.
  function refreshFolderChips() {
    const opts = foldersFor($("#up_audience").value);
    const toggle = $("#up_folder_manage_toggle");
    const chips = $("#up_folder_manage");
    toggle.hidden = !opts.length;
    if (!opts.length) { chips.hidden = true; chips.innerHTML = ""; return; }
    chips.innerHTML = opts.map((f) => `
      <span class="folder-chip" data-folder-id="${esc(f.id)}" data-folder-name="${esc(f.name)}">
        ${esc(f.name)} (${f.itemCount})
        <button type="button" data-act="delete-folder" aria-label="Delete folder ${esc(f.name)}">&times;</button>
      </span>`).join("");
  }

  function refreshFolderUI() {
    refreshUploadFolderOptions();
    refreshFolderChips();
  }
  $("#up_audience").addEventListener("change", refreshFolderUI);

  /* ---- inline "+ Create new folder…" in the upload form itself ---- */
  const upFolderSel = $("#up_folder");
  const folderNewRow = $("#up_folder_new");
  const folderNewName = $("#up_folder_new_name");

  upFolderSel.addEventListener("change", () => {
    if (upFolderSel.value === "__new__") {
      folderNewRow.hidden = false;
      folderNewName.focus();
    }
  });
  $("#up_folder_new_cancel").addEventListener("click", () => {
    folderNewRow.hidden = true;
    folderNewName.value = "";
    upFolderSel.value = "";
  });
  $("#up_folder_new_add").addEventListener("click", async () => {
    const name = folderNewName.value.trim();
    if (!name) { folderNewName.focus(); return; }
    const addBtn = $("#up_folder_new_add");
    addBtn.disabled = true;
    try {
      const folder = await createLibraryFolder(name, $("#up_audience").value);
      allFolders.push(folder);
      toast("Folder created.", `"${name}" is ready to use.`, "success");
      folderNewRow.hidden = true;
      folderNewName.value = "";
      refreshFolderUI();
      upFolderSel.value = folder.id;
    } catch (err) {
      toast("Couldn't create that folder", friendlyError(err), "error");
    } finally {
      addBtn.disabled = false;
    }
  });
  $("#up_folder_manage_toggle").addEventListener("click", () => {
    $("#up_folder_manage").hidden = !$("#up_folder_manage").hidden;
  });
  $("#up_folder_manage").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act='delete-folder']");
    if (!btn) return;
    const chip = btn.closest("[data-folder-id]");
    const id = chip.dataset.folderId;
    const name = chip.dataset.folderName;
    const ok = await confirmDialog({
      title: `Delete "${name}"?`,
      body: "Content inside stays — it just becomes unfiled. This can't be undone.",
      confirmLabel: "Delete", danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await deleteLibraryFolder(id);
      toast("Folder deleted.", "", "success");
      renderLibrary();
    } catch (err) {
      console.error("could not delete folder:", err);
      toast("Couldn't delete that folder", friendlyError(err), "error");
      btn.disabled = false;
    }
  });

  /* Inline editor for one item — same fields as upload, pre-filled, so
     "picked Mathematics instead of English" is a two-click fix instead
     of a delete-and-reupload (which would lose the published state and
     leave a gap while the replacement gets republished). Changing the
     destination without also picking a new folder auto-unfiles on save
     (the API's own rule) rather than blocking the edit. */
  function editRow(it) {
    const currentAudience = normalizeLibraryAudience(it.audience);
    const subjOpts = LIBRARY_SUBJECTS.map((s) => `<option${s === it.subject ? " selected" : ""}>${esc(s)}</option>`).join("");
    const typeOpts = CONTENT_TYPES.map((t) => `<option${t === it.type ? " selected" : ""}>${esc(t)}</option>`).join("");
    const audOpts = LIBRARY_AUDIENCES.map((a) => `<option value="${a.value}"${a.value === currentAudience ? " selected" : ""}>${esc(audienceName(a))}</option>`).join("");
    const folderSelectOpts = (audience, selectedId) => `<option value="">No folder</option>${
      foldersFor(audience).map((f) => `<option value="${esc(f.id)}"${f.id === selectedId ? " selected" : ""}>${esc(f.name)}</option>`).join("")}`;
    return `
      <div class="task-row lib-edit-row" data-lib-id="${esc(it.id)}">
        <div style="flex:1">
          <div class="field"><label>Title</label><input class="e-title" type="text" value="${esc(it.title)}"></div>
          <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">
            <div class="field"><label>Subject</label><select class="e-subject">${subjOpts}</select></div>
            <div class="field"><label>Type</label><select class="e-type">${typeOpts}</select></div>
          </div>
          <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">
            <div class="field"><label>Destination</label><select class="e-audience">${audOpts}</select></div>
            <div class="field"><label>Folder</label><select class="e-folder">${folderSelectOpts(currentAudience, it.folderId)}</select></div>
          </div>
          <div class="field"><label>Description</label><input class="e-desc" type="text" value="${esc(it.description || "")}"></div>
          ${it.externalUrl ? `<div class="field"><label>Link</label><input class="e-link" type="url" value="${esc(it.externalUrl)}"></div>` : ""}
          <div class="edit-actions">
            <button type="button" class="btn btn-primary" data-act="save-edit">Save changes</button>
            <button type="button" class="btn btn-outline" data-act="cancel-edit">Cancel</button>
          </div>
        </div>
      </div>`;
  }

  /* Publish/Edit/Delete/Move live here (Content Library management)
     only — a draft is real the instant it's uploaded, but invisible to
     every other dashboard until published; deleting removes the row
     and any uploaded files behind it, immediately and for good; moving
     assigns or clears which folder the item sits in. Editing updates
     this SAME row — never a new one, so the published state and every
     other dashboard's copy stay put. */
  function libraryRow(it) {
    if (it.id === editingItemId) return editRow(it);
    const audience = normalizeLibraryAudience(it.audience);
    const dest = AUDIENCE_PILL[audience];
    const folderOpts = foldersFor(audience);
    return `
      <article class="lib-card" data-lib-id="${esc(it.id)}">
        <div class="lib-card-top">
          ${libraryTypeIcon(it.type)}
          <span class="pill ${it.published ? "ok" : "warm"}">${it.published ? "Published" : "Draft"}</span>
        </div>
        <b class="lib-card-title" title="${esc(it.title)}">${esc(it.title)}</b>
        <span class="lib-card-meta">${esc(it.subject)} · ${esc(it.type || "Other")}</span>
        <span class="lib-dest${dest.cls}">${dest.label}</span>
        ${it.description ? `<p class="lib-card-desc">${esc(it.description)}</p>` : ""}
        <div class="lib-card-foot">
          ${libraryFilesHtml(it)}
          <div class="lib-card-actions">
            <button type="button" data-act="publish">${it.published ? "Unpublish" : "Publish"}</button>
            <button type="button" data-act="edit">Edit</button>
            <button type="button" data-act="delete" class="danger">Delete</button>
          </div>
          ${folderOpts.length ? `
            <select class="inline-select lib-card-move" data-act="move" aria-label="Move to folder">
              <option value="">Unfiled</option>
              ${folderOpts.map((f) => `<option value="${esc(f.id)}"${f.id === it.folderId ? " selected" : ""}>${esc(f.name)}</option>`).join("")}
            </select>` : ""}
        </div>
      </article>`;
  }

  $("#libraryList").addEventListener("click", async (e) => {
    if (e.target.closest("#libClearFilters")) {
      $("#libSearch").value = "";
      $("#libFilterDest").value = "";
      $("#libFilterStatus").value = "";
      renderLibraryDom();
      return;
    }
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const row = btn.closest("[data-lib-id]");
    if (!row) return;
    const id = row.dataset.libId;
    const title = row.querySelector("b")?.textContent || "this item";

    if (btn.dataset.act === "publish") {
      const publishing = btn.textContent.trim() === "Publish";
      btn.disabled = true;
      try {
        await setLibraryPublished(id, publishing);
        toast(publishing ? "Published successfully." : "Unpublished.", publishing ? `"${title}" is now visible on dashboards.` : `"${title}" is hidden from dashboards again.`, "success");
        renderLibrary();
      } catch (err) {
        console.error("could not update publish state:", err);
        toast("Couldn't do that", friendlyError(err), "error");
        btn.disabled = false;
      }
    } else if (btn.dataset.act === "edit") {
      editingItemId = id;
      renderLibraryDom();
    } else if (btn.dataset.act === "cancel-edit") {
      editingItemId = null;
      renderLibraryDom();
    } else if (btn.dataset.act === "save-edit") {
      const newTitle = row.querySelector(".e-title").value.trim();
      if (!newTitle) {
        toast("Title is required", "Give this item a title before saving.", "error");
        return;
      }
      const patch = {
        title: newTitle,
        subject: row.querySelector(".e-subject").value,
        type: row.querySelector(".e-type").value,
        audience: row.querySelector(".e-audience").value,
        description: row.querySelector(".e-desc").value.trim(),
        folderId: row.querySelector(".e-folder").value || null,
      };
      const linkInput = row.querySelector(".e-link");
      if (linkInput) patch.externalUrl = linkInput.value.trim();
      btn.disabled = true;
      try {
        await updateLibraryItem(id, patch);
        toast("Saved.", `"${newTitle}" was updated.`, "success");
        editingItemId = null;
        renderLibrary();
      } catch (err) {
        console.error("could not update library item:", err);
        toast("Couldn't save that", friendlyError(err), "error");
        btn.disabled = false;
      }
    } else if (btn.dataset.act === "delete") {
      const ok = await confirmDialog({
        title: `Delete "${title}"?`,
        body: "This removes it — and any uploaded files — for good. This can't be undone.",
        confirmLabel: "Delete", danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        await deleteLibraryItem(id);
        toast("Deleted successfully.", "", "success");
        renderLibrary();
      } catch (err) {
        console.error("could not delete library item:", err);
        toast("Couldn't delete that", friendlyError(err), "error");
        btn.disabled = false;
      }
    }
  });

  $("#libraryList").addEventListener("change", async (e) => {
    if (e.target.matches(".e-audience")) {
      const row = e.target.closest("[data-lib-id]");
      const folderSel = row.querySelector(".e-folder");
      const opts = foldersFor(e.target.value);
      folderSel.innerHTML = `<option value="">No folder</option>${
        opts.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}`;
      return;
    }
    const sel = e.target.closest("select[data-act='move']");
    if (!sel) return;
    const row = sel.closest("[data-lib-id]");
    const id = row.dataset.libId;
    const title = row.querySelector("b")?.textContent || "this item";
    const folderId = sel.value || null;
    sel.disabled = true;
    try {
      await setLibraryFolder(id, folderId);
      toast("Moved.", folderId ? `"${title}" is now in that folder.` : `"${title}" is unfiled.`, "success");
      renderLibrary();
    } catch (err) {
      console.error("could not move library item:", err);
      toast("Couldn't move that", friendlyError(err), "error");
      sel.disabled = false;
    }
  });

  // Re-renders the list from cachedItems/allFolders with no network
  // call — used for entering/leaving edit mode, where a refetch would
  // be wasteful and would blow away whatever's mid-edit elsewhere.
  function renderLibraryDom() {
    refreshFolderUI();
    const published = cachedItems.filter((it) => it.published).length;
    $("#libStats").innerHTML = cachedItems.length ? `
      <span class="lib-stat"><b>${cachedItems.length}</b> item${cachedItems.length === 1 ? "" : "s"}</span>
      <span class="lib-stat ok"><b>${published}</b> published</span>
      <span class="lib-stat warm"><b>${cachedItems.length - published}</b> draft${cachedItems.length - published === 1 ? "" : "s"}</span>` : "";

    if (!cachedItems.length) {
      $("#libraryList").innerHTML = `<div class="empty-state">Nothing uploaded yet — use <b>+ New upload</b> above to add the first item.</div>`;
      return;
    }

    const q = $("#libSearch").value.trim().toLowerCase();
    const dest = $("#libFilterDest").value;
    const status = $("#libFilterStatus").value;
    const shown = cachedItems.filter((it) =>
      (!q || [it.title, it.subject, it.type, it.description].some((v) => (v || "").toLowerCase().includes(q))) &&
      (!dest || normalizeLibraryAudience(it.audience) === dest) &&
      (!status || (status === "published") === !!it.published));

    if (!shown.length) {
      $("#libraryList").innerHTML = `<div class="empty-state">No content matches these filters. <button type="button" class="link-btn" id="libClearFilters">Clear filters</button></div>`;
      return;
    }

    const folderById = new Map(allFolders.map((f) => [f.id, f]));
    $("#libraryList").innerHTML = librarySectionsHtml(shown, allFolders, {
      rowFn: libraryRow,
      folderMeta: (id) => AUDIENCE_PILL[folderById.get(id)?.audience]?.label,
    });
  }

  $("#libFilterDest").innerHTML = `<option value="">All destinations</option>${
    LIBRARY_AUDIENCES.map((a) => `<option value="${a.value}">${esc(AUDIENCE_PILL[a.value].label)}</option>`).join("")}`;
  $("#libSearch").addEventListener("input", renderLibraryDom);
  $("#libFilterDest").addEventListener("change", renderLibraryDom);
  $("#libFilterStatus").addEventListener("change", renderLibraryDom);

  async function renderLibrary() {
    $("#libraryList").innerHTML = skeleton(4);
    try {
      [cachedItems, allFolders] = await Promise.all([getLibrary(), getLibraryFolders()]);
    } catch (err) {
      console.error("could not load library:", err);
      $("#libraryList").innerHTML = errorState(friendlyError(err), renderLibrary);
      return;
    }
    editingItemId = null;
    renderLibraryDom();
  }

  function impactCard(title, meta, body) {
    return `<div class="chart-card">
      <div class="chart-card-head"><b>${esc(title)}</b><span>${esc(meta)}</span></div>
      ${body}
    </div>`;
  }

  /* ------------------------------------------------------------ content usage report
     Every "Open to read" click is timed (see nav.js) and rolls up here —
     scoped to one school or every school combined, same county/school
     filter pattern as the Portal impact dashboard above. */
  function durationBarChart(rows) {
    const max = Math.max(1, ...rows.map((d) => d.seconds || 0));
    return `<div class="bar-chart">${rows.map((d) => `
      <div class="bar-row">
        <span class="bar-label" title="${esc(d.label)}">${esc(d.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${((d.seconds || 0) / max) * 100}%"></span></span>
        <span class="bar-num">${formatDuration(d.seconds)}</span>
      </div>`).join("")}</div>`;
  }

  function schoolUsageRows(rows) {
    return rows.map((r) => `
      <div class="task-row">
        <div style="flex:1"><b>${esc(r.school)}</b><span>${r.users} user${r.users === 1 ? "" : "s"} · ${r.sessions} session${r.sessions === 1 ? "" : "s"}</span></div>
        <span class="bar-num">${formatDuration(r.totalSeconds)}</span>
      </div>`).join("");
  }

  async function renderUsage() {
    $("#usageBody").innerHTML = skeleton(3);
    let u;
    try {
      u = await getLibraryUsage({ school: gf.school });
    } catch (err) {
      console.error("could not load usage report:", err);
      $("#usageBody").innerHTML = errorState(friendlyError(err, "Couldn't load the usage report."), renderUsage);
      return;
    }
    $("#usageMeta").textContent = u.school ? `Scoped to ${u.school}` : "All schools";

    const topResources = (u.byResource || []).slice(0, 8).map((r) => ({ label: r.title, seconds: r.totalSeconds }));

    $("#usageBody").innerHTML = `
      <div class="chart-stats">
        <div><b>${formatDuration(u.totals.totalSeconds)}</b><span>Time spent</span></div>
        <div><b>${u.totals.sessions}</b><span>Resources opened</span></div>
        <div><b>${u.totals.completedSessions}</b><span>Timed sessions</span></div>
        <div><b>${u.totals.users}</b><span>Active users</span></div>
      </div>
      <div class="chart-grid">
        ${impactCard("Most-visited resources", `${(u.byResource || []).length} resources`,
          topResources.length ? durationBarChart(topResources) : `<div class="chart-empty">${emptyMsg("Nothing opened yet.")}</div>`)}
        ${impactCard("By school", u.school ? "1 school (filtered)" : `${(u.bySchool || []).length} schools`,
          (u.bySchool || []).length ? schoolUsageRows(u.bySchool) : `<div class="chart-empty">${emptyMsg("Nothing tracked yet.")}</div>`)}
      </div>
    `;
  }

  /* ---- file / folder picker for "Upload content" ---- */
  const fileInput = $("#up_file");
  const uploadList = $("#uploadList");
  const uploadHint = $("#uploadHint");
  const uploadDrop = $("#uploadDrop");
  const linkInput = $("#up_link");
  const fileField = $("#up_file_field");
  const linkField = $("#up_link_field");
  const uploadForm = $("#uploadForm");
  const uploadToggle = $("#uploadToggle");
  let picked = [];

  // A file and a link are mutually exclusive, so it's one switch rather
  // than two stacked inputs; switching clears whatever the other side had.
  function setSource(src) {
    $$(".source-toggle [data-source]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.source === src)));
    fileField.hidden = src !== "file";
    linkField.hidden = src !== "link";
    linkInput.required = src === "link";
    if (src === "file") linkInput.value = "";
    else clearPicked();
  }
  $$(".source-toggle [data-source]").forEach((b) => b.addEventListener("click", () => setSource(b.dataset.source)));

  // The upload form stays folded into a one-line bar until it's needed,
  // so the library below gets the page.
  function setUploadOpen(open) {
    uploadForm.hidden = !open;
    uploadToggle.setAttribute("aria-expanded", String(open));
    uploadToggle.textContent = open ? "Close" : "+ New upload";
    uploadToggle.classList.toggle("btn-primary", !open);
    uploadToggle.classList.toggle("btn-outline", open);
    if (open) $("#up_title").focus();
  }
  function resetUploadForm() {
    uploadForm.reset();
    clearPicked();
    setSource("file");
    folderNewRow.hidden = true;
    $("#up_subject").value = LIBRARY_SUBJECTS[0];
    $("#up_type").value = CONTENT_TYPES[0];
    $("#up_audience").value = LIBRARY_AUDIENCES[0].value;
    refreshAudienceHint();
    refreshFolderUI();
  }
  uploadToggle.addEventListener("click", () => setUploadOpen(uploadForm.hidden));
  $("#uploadCancel").addEventListener("click", () => { resetUploadForm(); setUploadOpen(false); });

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

    const link = linkInput.value.trim();
    const meta = {
      title,
      subject: $("#up_subject").value,
      type: $("#up_type").value,
      audience: $("#up_audience").value,
      description: $("#up_desc").value.trim(),
      externalUrl: link || undefined,
      folderId: $("#up_folder").value || null,
    };

    submitBtn.classList.add("is-saving");
    try {
      if (link) {
        await addLibraryItem(meta);
        toast("Added to library successfully.", "Link added.", "success");
      } else if (picked.length) {
        submitBtn.textContent = `Uploading 0/${picked.length}…`;
        await uploadLibraryFiles(meta, picked, (done, n) => {
          submitBtn.textContent = `Uploading ${done}/${n}…`;
        });
        toast("Added to library successfully.", `${picked.length} file(s) uploaded`, "success");
      } else {
        await addLibraryItem(meta);
        toast("Added to library successfully.", "", "success");
      }
      resetUploadForm();
      setUploadOpen(false);
      renderLibrary();
    } catch (err) {
      toast("Upload failed", friendlyError(err, "Could not save the content. Check your connection and try again."), "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove("is-saving");
      submitBtn.textContent = "Add to library";
    }
  });

  /* ------------------------------------------------------------ form builder
     Three kinds of form — built here (questions), an uploaded file, or a
     link to another site — each addressed to a role, a county (or all)
     and, for field officers, optionally a visit type. The "Goes to" line
     spells out exactly who'll get it before it's sent; recipients see it
     automatically (the API filters by role, county and visit type). */
  $("#fb_audience").innerHTML = FORM_AUDIENCES.map((a) => `<option value="${a.value}">${esc(a.label)}</option>`).join("");
  $("#fb_visit").innerHTML = `<option value="">Not tied to a visit — a stand-alone form</option>` +
    VISIT_TYPES.map((v) => `<option value="${esc(v)}">${esc(v)} visits</option>`).join("");
  let fbKind = "questions";

  function refreshFormCountyOptions() {
    const sel = $("#fb_county");
    const keep = sel.value;
    sel.innerHTML = `<option value="">All counties</option>` +
      schoolDir.counties.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    sel.value = schoolDir.counties.includes(keep) ? keep : "";
    syncFormBuilder();
  }

  function syncFormBuilder() {
    const audience = $("#fb_audience").value;
    const isField = audience === "field_officer";
    $("#fb_visit_field").hidden = !isField;
    if (!isField) $("#fb_visit").value = "";
    $("#fb_questions_field").hidden = fbKind !== "questions";
    $("#fb_file_field").hidden = fbKind !== "file";
    $("#fb_link_field").hidden = fbKind !== "link";
    $$("[data-fb-kind]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.fbKind === fbKind)));
    const who = (FORM_AUDIENCES.find((a) => a.value === audience)?.label || "").toLowerCase();
    const county = $("#fb_county").value;
    const visit = $("#fb_visit").value;
    $("#fb_reach").innerHTML = `<b>Goes to:</b> ${esc(who)} in ${county ? `${esc(county)} County` : "every county"}${
      visit ? `, filled in during every <b>${esc(visit)}</b> visit` : ""}.`;
  }
  $$("[data-fb-kind]").forEach((b) => b.addEventListener("click", () => { fbKind = b.dataset.fbKind; syncFormBuilder(); }));
  ["#fb_audience", "#fb_county", "#fb_visit"].forEach((s) => $(s).addEventListener("change", syncFormBuilder));
  syncFormBuilder();

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
    const file = $("#fb_file").files[0];
    const link = $("#fb_link").value.trim();
    if (fbKind === "questions" && !questions.length) {
      toast("Add a question", "Write at least one question for this form.", "error");
      return;
    }
    if (fbKind === "file" && !file) {
      toast("Choose the form file", "Pick the file recipients should fill in.", "error");
      return;
    }
    if (fbKind === "link" && !/^https?:\/\//i.test(link)) {
      toast("Add the form's link", "It must start with http:// or https://.", "error");
      return;
    }

    const submitBtn = e.target.querySelector("[type=submit]");
    submitBtn.disabled = true;
    submitBtn.classList.add("is-saving");
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = fbKind === "file" ? "Uploading…" : "Saving…";
    try {
      await addForm({
        title,
        description: $("#fb_desc").value.trim(),
        audience: $("#fb_audience").value,
        kind: fbKind,
        county: $("#fb_county").value || null,
        visitType: $("#fb_visit").value || null,
        questions,
        externalUrl: link,
        file,
      });
      toast("Form sent successfully.", $("#fb_reach").textContent, "success");
      e.target.reset();
      questionRows.innerHTML = "";
      addQuestionRow();
      fbKind = "questions";
      syncFormBuilder();
      renderForms();
      renderStats();
    } catch (err) {
      toast("Couldn't send the form", friendlyError(err), "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove("is-saving");
      submitBtn.textContent = originalLabel;
    }
  });

  /* ------------------------------------------------------------ forms & feedback */
  async function renderForms() {
    $("#formsList").innerHTML = skeleton(3, { avatar: false });
    try {
      [formsCache, responsesCache] = await Promise.all([getForms(), getResponses()]);
    } catch (err) {
      console.error("could not load forms:", err);
      formsCache = []; responsesCache = [];
      $("#formsList").innerHTML = errorState(friendlyError(err), renderForms);
      return;
    }
    const forms = formsCache;
    const responses = responsesCache;
    renderAttention();
    const none = `<span style="color:var(--ink-soft);font-size:.82rem">No responses yet</span>`;
    const when = (d) => d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
    // Who answered — plus the school, for forms filled in during a visit.
    const who = (r) => `${esc(r.respondentName)}${r.school ? ` · ${esc(r.school)}` : ""}`;
    const formCard = (f) => {
          const answers = responses.filter((r) => r.formId === f.id);
          let body;
          if (f.kind === "questions") {
            body = f.questions.map((q) => {
              const qAnswers = answers
                .map((r) => ({ r, a: r.answers.find((a) => a.questionId === q.id) }))
                .filter((x) => x.a);
              if (q.type === "rating") {
                const nums = qAnswers.map((x) => Number(x.a.value)).filter((n) => !Number.isNaN(n));
                const avg = nums.length ? (nums.reduce((s, n) => s + n, 0) / nums.length).toFixed(1) : null;
                return `<div class="fc-q"><b>${esc(q.prompt)}</b>${
                  avg ? `<span class="fc-avg">${avg}</span> / 5 avg · ${nums.length} response(s)` : none
                }</div>`;
              }
              return `<div class="fc-q"><b>${esc(q.prompt)}</b>${
                qAnswers.length
                  ? qAnswers.map(({ r, a }) => `<div class="fc-answer"><b>${who(r)}</b>${esc(a.value)}</div>`).join("")
                  : none
              }</div>`;
            }).join("");
          } else {
            // File and link forms: who has filled it, when, and any filled copy they sent back.
            const blank = f.kind === "file" && f.files[0]
              ? `<a class="form-open" href="${esc(f.files[0].viewUrl)}" target="_blank" rel="noopener">View blank form</a>`
              : f.kind === "link" && f.externalUrl
                ? `<a class="form-open" href="${esc(f.externalUrl)}" target="_blank" rel="noopener">Open form ↗</a>`
                : "";
            body = `<div class="fc-q">${blank}${
              answers.length
                ? answers.map((r) => `<div class="fc-answer"><b>${who(r)}</b>${
                    r.files.length
                      ? r.files.map((file) => `<a href="${esc(file.downloadUrl || file.viewUrl)}" target="_blank" rel="noopener">${esc(file.name)}</a>`).join(", ")
                      : "Marked as filled"
                  } · ${when(r.submittedAt)}</div>`).join("")
                : none
            }</div>`;
          }
          // A form with responses can only be archived — its responses are
          // programme records. Delete is offered only while nobody has answered.
          const action = f.archivedAt
            ? `<button type="button" class="btn btn-ghost" data-form-act="restore" data-form-id="${esc(f.id)}">Restore form</button>`
            : answers.length
              ? `<button type="button" class="btn btn-ghost" data-form-act="archive" data-form-id="${esc(f.id)}">Archive form</button>`
              : `<button type="button" class="btn btn-ghost" data-form-act="delete" data-form-id="${esc(f.id)}">Delete form</button>`;
          return `
            <div class="form-card">
              <div class="fc-head"><h3>${esc(f.title)}</h3><span class="pill">${f.archivedAt ? "Archived" : esc(AUDIENCE_LABEL[f.audience] || f.audience)}</span></div>
              <div class="form-tags">${formTagsHtml(f)}</div>
              <div class="fc-meta">${answers.length} response(s)${f.description ? " · " + esc(f.description) : ""}</div>
              ${body}
              <div class="fc-actions">${action}</div>
            </div>`;
    };
    const active = forms.filter((f) => !f.archivedAt);
    const archived = forms.filter((f) => f.archivedAt);
    $("#formsList").innerHTML =
      (active.length ? active.map(formCard).join("") : `<div class="empty-state">No forms created yet.</div>`) +
      (archived.length
        ? `<div class="list-group" style="margin-top:1rem">
             <div class="list-group-title">Archived<span class="count">${archived.length}</span></div>
             <p class="field-hint" style="margin:0 0 .5rem">No longer sent to anyone. Every response is kept; restore a form to send it out again.</p>
             ${archived.map(formCard).join("")}
           </div>`
        : "");
  }

  $("#formsList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-form-act]");
    if (!btn) return;
    const form = formsCache.find((f) => f.id === btn.dataset.formId);
    if (!form) return;
    const act = btn.dataset.formAct;
    const n = responsesCache.filter((r) => r.formId === form.id).length;
    const dialog = {
      delete: {
        title: `Delete "${form.title}"?`,
        body: "Nobody has answered it yet. It disappears from every dashboard. This can't be undone.",
        confirmLabel: "Delete form", danger: true,
      },
      archive: {
        title: `Archive "${form.title}"?`,
        body: `It stops being sent and can't be answered any more. Its ${n} response(s) are kept, and you can restore it later.`,
        confirmLabel: "Archive form",
      },
      restore: {
        title: `Restore "${form.title}"?`,
        body: "It's sent to its audience again and can be answered.",
        confirmLabel: "Restore form",
      },
    }[act];
    if (!dialog || !(await confirmDialog(dialog))) return;
    btn.disabled = true;
    try {
      if (act === "delete") await deleteForm(form.id);
      else if (act === "archive") await archiveForm(form.id);
      else await restoreForm(form.id);
      toast(act === "delete" ? "Form deleted." : act === "archive" ? "Form archived." : "Form restored.", "", "success");
      renderForms();
      renderStats();
    } catch (err) {
      btn.disabled = false;
      toast(`Couldn't ${act} the form`, friendlyError(err), "error");
    }
  });

  /* ------------------------------------------------------------ field surveys (KoboToolbox) */
  const koboConnectForm = $("#koboConnectForm");
  const koboManage = $("#koboManage");
  const koboSyncBtn = $("#koboSyncBtn");
  const koboAssetSel = $("#kb_asset");

  function showKoboConnect() {
    koboConnectForm.hidden = false;
    koboManage.hidden = true;
    koboSyncBtn.hidden = true;
  }

  async function renderKobo() {
    try {
      koboState = await koboConfig();
    } catch (err) {
      console.error("could not load KoboToolbox settings:", err);
      $("#koboFormList").innerHTML = errorState(friendlyError(err, "Couldn't load KoboToolbox settings."), renderKobo);
      return;
    }
    $("#kb_url").value = koboState.baseUrl || "https://eu.kobotoolbox.org";
    $("#kb_field").value = koboState.officerField || "officer_ref";
    $("#koboFieldEcho").textContent = koboState.officerField || "officer_ref";
    renderAttention();

    // Viewing only (M&E): the surveys and their data pipeline, read-only —
    // no connection, attach, sync or push controls.
    if (!has("kobo.manage")) {
      koboConnectForm.hidden = true;
      koboManage.hidden = !koboState.configured;
      $("#koboAttachForm").hidden = true;
      if (koboState.configured) renderKoboForms();
      refreshSurveyPicker();
      return;
    }
    if (!koboState.configured) { showKoboConnect(); refreshSurveyPicker(); return; }

    koboConnectForm.hidden = true;
    koboManage.hidden = false;
    koboSyncBtn.hidden = false;
    $("#koboServerEcho").textContent = (koboState.baseUrl || "").replace(/^https?:\/\//, "");
    $("#koboFieldEcho2").textContent = koboState.officerField || "officer_ref";

    renderKoboPush();
    renderKoboAssets();
    renderKoboForms();
    refreshSurveyPicker();
  }

  /* Kobo's live push (REST Service): set up / replace / turn off. */
  function renderKoboPush() {
    $("#koboPush").innerHTML = webhookBoxHtml(koboState, has("kobo.manage"));
  }
  wireWebhookBox($("#koboPush"), async () => {
    try { koboState = await koboConfig(); } catch { /* keep the old state */ }
    renderKoboPush();
  });

  async function renderKoboAssets() {
    koboAssetSel.innerHTML = `<option value="">Loading surveys…</option>`;
    let assets = [];
    try { assets = await koboAssets(); } catch (err) {
      koboAssetSel.innerHTML = `<option value="">${esc(friendlyError(err, "Couldn't reach KoboToolbox"))}</option>`;
      return;
    }
    const deployed = assets.filter((a) => a.deployed);
    koboAssetSel.innerHTML = deployed.length
      ? `<option value="">Choose a deployed survey…</option>` +
        deployed.map((a) => `<option value="${esc(a.uid)}">${esc(a.name)} (${a.submissionCount} submission${a.submissionCount === 1 ? "" : "s"})</option>`).join("")
      : `<option value="">No deployed surveys in this account</option>`;
  }

  async function renderKoboForms() {
    $("#koboFormList").innerHTML = skeleton(2, { avatar: false });
    let forms;
    try {
      forms = await koboForms();
    } catch (err) {
      console.error("could not load attached Kobo forms:", err);
      $("#koboFormList").innerHTML = errorState(friendlyError(err), renderKoboForms);
      return;
    }
    const koboCard = (f) => `
        <div class="form-card">
          <div class="kobo-row">
            <div>
              <b style="font-size:.92rem">${esc(f.title)}</b>
              <div class="fc-meta" style="margin:.2rem 0 0">${f.processed
                ? `${f.pipeline.received} received · <b>${f.pipeline.counted} counted</b>${f.pipeline.needsReview ? ` · <span class="kp-warn">${f.pipeline.needsReview} need review</span>` : ""}`
                : "not checked yet — press Sync now"}${
                f.syncedAt ? " · synced " + new Date(f.syncedAt).toLocaleString() : ""
              } · ${f.officerSubmissions} officer${f.officerSubmissions === 1 ? "" : "s"} done</div>
            </div>
            <div class="kobo-actions">
              <button type="button" data-kobo-pipeline="${esc(f.id)}">Data pipeline</button>
              ${!has("kobo.manage") ? "" : f.active
                ? `<button type="button" data-kobo-archive="${esc(f.id)}" class="danger">Archive</button>`
                : `<button type="button" data-kobo-restore="${esc(f.id)}">Restore</button>`}
            </div>
          </div>
        </div>`;
    const activeSurveys = forms.filter((f) => f.active);
    const archivedSurveys = forms.filter((f) => !f.active);
    $("#koboFormList").innerHTML =
      (activeSurveys.length ? activeSurveys.map(koboCard).join("") : `<div class="empty-state">No surveys attached yet.</div>`) +
      (archivedSurveys.length
        ? `<div class="list-group" style="margin-top:1rem">
             <div class="list-group-title">Archived<span class="count">${archivedSurveys.length}</span></div>
             <p class="field-hint" style="margin:0 0 .5rem">Hidden from field officers and skipped by sync. Who submitted is kept.</p>
             ${archivedSurveys.map(koboCard).join("")}
           </div>`
        : "");

    $$("[data-kobo-pipeline]").forEach((btn) => btn.addEventListener("click", async () => {
      if (!schoolDir.schools.length) await renderSchoolList().catch(() => {});
      openKoboPipeline(btn.dataset.koboPipeline, {
        canManage: has("kobo.manage"), schools: schoolDir.schools,
        onChange: () => { renderKoboForms(); loadSurveyResults(); renderIntelligence(); },
      });
    }));
    $$("[data-kobo-archive]").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await removeKoboForm(btn.dataset.koboArchive);
        toast("Survey archived.", "Field officers no longer see it. Its submission record is kept.", "success");
        renderKoboForms();
        refreshSurveyPicker();
      } catch (err) {
        toast("Couldn't archive it", friendlyError(err), "error");
        btn.disabled = false;
      }
    }));
    $$("[data-kobo-restore]").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await restoreKoboForm(btn.dataset.koboRestore);
        toast("Survey restored.", "Field officers can open it again.", "success");
        renderKoboForms();
        refreshSurveyPicker();
      } catch (err) {
        toast("Couldn't restore it", friendlyError(err), "error");
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
      toast("Couldn't connect", friendlyError(err, "Check the server URL and token."), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  });

  $("#koboReconnect").addEventListener("click", showKoboConnect);

  /* Opens the survey inline, in the portal's own viewer — a look at the
     actual questions before deciding to send it out. Not KoboToolbox's
     web app (that needs a separate Kobo login and refuses to be framed
     anyway); not the field officer's fillable link either, so viewing
     never reaches, notifies, or counts as anything for a field officer —
     nobody's dashboard changes until "Attach" is used. */
  $("#koboViewBtn").addEventListener("click", async () => {
    const uid = koboAssetSel.value;
    if (!uid) {
      toast("Pick a survey first", "Choose one from the list, then View.", "error");
      return;
    }
    const btn = $("#koboViewBtn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      const { previewUrl, title } = await koboAssetPreview(uid);
      openIframeViewer({ title, url: previewUrl });
    } catch (err) {
      toast("Couldn't load the preview", friendlyError(err), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

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
      toast("Couldn't attach that survey", friendlyError(err), "error");
    } finally {
      btn.disabled = false;
    }
  });

  koboSyncBtn.addEventListener("click", async () => {
    koboSyncBtn.disabled = true;
    koboSyncBtn.textContent = "Syncing…";
    try {
      const { forms = [], failed = [] } = await syncKobo();
      const sum = (k) => forms.reduce((t, f) => t + (f[k] || 0), 0);
      const review = sum("invalid") + sum("duplicate");
      toast(
        failed.length ? "Synced, with problems" : "Synced with KoboToolbox",
        `${sum("received")} submission(s) checked: ${sum("valid")} valid${review ? `, ${review} need review` : ""}${sum("rejected") ? `, ${sum("rejected")} rejected in Kobo` : ""}.`
          + (failed.length ? ` Couldn't reach: ${failed.join(", ")}.` : ""),
        failed.length ? "error" : "success",
      );
      renderKoboForms();
      refreshSurveyPicker();
      renderIntelligence();
    } catch (err) {
      toast("Sync failed", friendlyError(err), "error");
    } finally {
      koboSyncBtn.disabled = false;
      koboSyncBtn.textContent = "Sync now";
    }
  });

  /* ------------------------------------------------------------ survey results (charts)
     Picks one attached Kobo survey and draws a chart per question from the
     portal's own validated records (Postgres, not a live Kobo call): only
     submissions that pass the checks, or that someone accepted. Narrowed by
     the county / school filters. Re-runs on survey change, Refresh, focus,
     and every couple of minutes while the tab is visible. */
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
      .map((f) => `<option value="${esc(f.id)}">${esc(f.title)}${f.active ? "" : " (archived)"} — ${f.pipeline.counted} counted</option>`)
      .join("");
    srCurrent = forms.some((f) => f.id === prev) ? prev : forms[0].id;
    srPicker.value = srCurrent;
    srBody.dataset.for = "";
    loadSurveyResults();
    startSrPolling();
  }

  async function loadSurveyResults({ fresh = false } = {}) {
    if (!srCurrent || srBusy) return;
    srBusy = true;
    const wanted = srCurrent;
    const firstView = srBody.dataset.for !== wanted;
    if (firstView) srBody.innerHTML = skeleton(3);
    try {
      const res = await koboResults(wanted, { county: gf.county, school: gf.school });
      if (res.id !== srCurrent) return; // survey switched mid-flight
      srBody.dataset.for = srCurrent;
      renderSurveyResults(res);
    } catch (err) {
      console.error("could not load survey results:", err);
      if (firstView) srBody.innerHTML = errorState(friendlyError(err, "Couldn't load results."), loadSurveyResults);
    } finally {
      srBusy = false;
    }
  }

  function renderSurveyResults(res) {
    const bits = [];
    if (res.needsSync) {
      srMeta.textContent = "";
      srBody.innerHTML = `<div class="empty-state">“${esc(res.title)}” hasn't been checked yet — press “Sync now” on Kobo Surveys.</div>`;
      return;
    }
    bits.push(`${res.submissionCount} of ${res.received} submission${res.received === 1 ? "" : "s"} counted${res.filtered ? " (filtered)" : ""}`);
    const x = res.excluded || {};
    const left = [
      x.invalid ? `${x.invalid} failing checks` : "", x.duplicate ? `${x.duplicate} duplicate${x.duplicate === 1 ? "" : "s"}` : "",
      x.rejected ? `${x.rejected} rejected in Kobo` : "", x.byReview ? `${x.byReview} excluded by a person` : "",
    ].filter(Boolean);
    if (left.length) bits.push(`left out: ${left.join(", ")}`);
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
  const miniEmpty = () => `<div class="chart-empty">${emptyMsg("No answers yet.")}</div>`;

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

  function barChart(data, opts = {}) {
    const rows = data || [];
    const max = Math.max(1, ...rows.map((d) => d.value || 0));
    return `<div class="bar-chart">${rows.map((d) => `
      <div class="bar-row">
        <span class="bar-label" title="${esc(d.label)}">${opts.drillSchool
          ? `<button type="button" data-drill-school="${esc(d.label)}"
               style="background:none;border:0;padding:0;color:var(--brand);font-weight:600;cursor:pointer;font-family:inherit;font-size:inherit;text-align:left">${esc(d.label)}</button>`
          : esc(d.label)}</span>
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
    // Every 2 minutes: each refresh can mean a full download from Kobo.
    srTimer = setInterval(() => {
      if (document.visibilityState === "visible" && srCurrent) loadSurveyResults();
    }, 120000);
  }
  function stopSrPolling() {
    if (srTimer) { clearInterval(srTimer); srTimer = null; }
  }

  srPicker.addEventListener("change", () => {
    srCurrent = srPicker.value;
    srBody.dataset.for = "";
    loadSurveyResults();
  });
  srRefresh.addEventListener("click", async () => {
    srRefresh.disabled = true;
    srRefresh.textContent = "Refreshing…";
    await loadSurveyResults({ fresh: true });
    srRefresh.disabled = false;
    srRefresh.textContent = "Refresh";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && srCurrent) loadSurveyResults();
  });

  /* ------------------------------------------------------------ school list
     Counties and the schools in each are managed here and feed every
     county/school dropdown in the portal — sign-up, "Choose your school",
     field visits, the Users editor and this dashboard's own filters. The
     API gives each new school its code (NRK-001…) from its county's code;
     renaming never changes a code, a school can only be removed once
     nobody is in it, and a county only once it has no schools or field
     officers. Every change here refreshes every dropdown on this page at
     once; other people's open pages pick it up via watchSchools(). */
  let renamingSchoolId = null;
  const PIN_ICON = '<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>';
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function schoolItem(s) {
    if (s.id === renamingSchoolId) return `
      <div class="school-item" data-school-id="${esc(s.id)}">
        <span class="code-chip">${esc(s.code)}</span>
        <input class="school-rename-input" type="text" value="${esc(s.name)}" maxlength="80" aria-label="New name for ${esc(s.name)}">
        <div class="school-item-actions">
          <button type="button" data-act="save-rename">Save</button>
          <button type="button" data-act="cancel-rename">Cancel</button>
        </div>
      </div>`;
    const people = (s.teachers || 0) + (s.heads || 0) + (s.learners || 0);
    return `
      <div class="school-item" data-school-id="${esc(s.id)}" data-people="${people}" data-name="${esc(s.name)}">
        <span class="code-chip">${esc(s.code)}</span>
        <div class="school-item-main">
          <b>${esc(s.name)}</b>
          <span>${plural(s.teachers || 0, "teacher")} · ${plural(s.heads || 0, "head")} · ${plural(s.learners || 0, "learner")}</span>
        </div>
        <div class="school-item-actions">
          <button type="button" data-act="rename">Rename</button>
          <button type="button" data-act="remove" class="danger">Remove</button>
        </div>
      </div>`;
  }

  function renderSchoolListDom() {
    const { counties, countyCodes, schools } = schoolDir;
    $("#schoolListCount").textContent =
      `${counties.length} ${counties.length === 1 ? "county" : "counties"} · ${plural(schools.length, "school")}`;
    $("#schoolList").innerHTML = counties.map((c) => {
      const list = schools.filter((s) => s.county === c);
      return `
        <details class="lib-section" open>
          <summary class="lib-section-head">
            <span class="lib-section-ic">${svg(PIN_ICON)}</span>
            <span class="lib-section-name">${esc(c)}</span>
            <span class="code-chip">${esc(countyCodes[c] || "")}</span>
            ${list.length ? "" : `<button type="button" class="county-remove" data-remove-county="${esc(c)}">Remove county</button>`}
            <span class="count">${list.length}</span>
          </summary>
          <div class="lib-section-body school-list-body">${list.length
            ? list.map(schoolItem).join("")
            : `<div class="empty-state">No schools in ${esc(c)} yet — add one above.</div>`}</div>
        </details>`;
    }).join("") || `<div class="empty-state">No counties yet — add one under "Manage counties".</div>`;
  }

  /* One fresh copy of the list, applied to every dropdown on this page. */
  function applySchoolDir(data) {
    schoolDir = data;
    const keep = $("#as_county").value;
    $("#as_county").innerHTML = `<option value="">County</option>${
      schoolDir.counties.map((c) => `<option>${esc(c)}</option>`).join("")}`;
    $("#as_county").value = schoolDir.counties.includes(keep) ? keep : "";
    // Don't re-render under someone mid-rename (they'd lose their typing).
    if (!renamingSchoolId) renderSchoolListDom();
    if (renderGlobalFilterOptions({ clearMissing: true })) applyFilters();
    userPicker?.update(schoolDir);
    invitePicker?.update(schoolDir);
    fillFinderSchools();
    refreshFormCountyOptions();
  }

  $("#schoolList").innerHTML = skeleton(3, { avatar: false });
  const schoolsWatch = watchSchools(applySchoolDir, (err) => {
    console.error("could not load schools:", err);
    $("#schoolList").innerHTML = errorState(friendlyError(err), () => schoolsWatch.refresh());
  });
  const renderSchoolList = async () => {
    renamingSchoolId = null;
    await schoolsWatch.refresh();
  };

  // ---- counties ----
  $("#ac_name").addEventListener("input", () => {
    const code = $("#ac_code");
    if (code.dataset.touched) return;
    code.value = $("#ac_name").value.replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase();
  });
  $("#ac_code").addEventListener("input", (e) => {
    e.target.dataset.touched = "1";
    e.target.value = e.target.value.replace(/[^a-z]/gi, "").toUpperCase();
  });
  $("#addCountyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#ac_name").value.trim();
    const code = $("#ac_code").value.trim();
    if (!name || !code) return;
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const county = await createCounty(name, code);
      toast("County added", `${county.name} (${county.code}) — its schools will be ${county.code}-001, ${county.code}-002…`, "success");
      e.target.reset();
      delete $("#ac_code").dataset.touched;
      await renderSchoolList();
    } catch (err) {
      toast("Couldn't add that county", friendlyError(err), "error");
    } finally {
      btn.disabled = false;
    }
  });
  $("#schoolList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-remove-county]");
    if (!btn) return;
    e.preventDefault(); // it sits inside the section's <summary> — don't toggle it
    const name = btn.dataset.removeCounty;
    const ok = await confirmDialog({
      title: `Remove ${name} county?`,
      body: "It disappears from every county dropdown. It has no schools, so no one is affected.",
      confirmLabel: "Remove", danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await deleteCounty(name);
      toast("County removed", "", "success");
      await renderSchoolList();
    } catch (err) {
      toast("Couldn't remove that county", friendlyError(err), "error");
      btn.disabled = false;
    }
  });

  $("#addSchoolForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const county = $("#as_county").value;
    const name = $("#as_name").value.trim();
    if (!county || !name) return;
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const school = await createSchool(name, county);
      toast("School added", `${school.name} is ${school.code}.`, "success");
      $("#as_name").value = "";
      await renderSchoolList();
    } catch (err) {
      toast("Couldn't add that school", friendlyError(err), "error");
    } finally {
      btn.disabled = false;
    }
  });

  $("#schoolList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const item = btn.closest("[data-school-id]");
    const id = item.dataset.schoolId;
    const act = btn.dataset.act;
    if (act === "rename") {
      renamingSchoolId = id;
      renderSchoolListDom();
      $(`[data-school-id="${id}"] .school-rename-input`)?.select();
    } else if (act === "cancel-rename") {
      renamingSchoolId = null;
      renderSchoolListDom();
    } else if (act === "save-rename") {
      const name = item.querySelector(".school-rename-input").value.trim();
      if (!name) return;
      btn.disabled = true;
      try {
        await renameSchool(id, name);
        toast("School renamed", "Its code — and everyone's code in it — stays the same.", "success");
        await renderSchoolList();
      } catch (err) {
        toast("Couldn't rename that school", friendlyError(err), "error");
        btn.disabled = false;
      }
    } else if (act === "remove") {
      const people = Number(item.dataset.people || 0);
      if (people > 0) {
        toast("Can't remove this school yet",
          `${item.dataset.name} still has ${people === 1 ? "1 person" : `${people} people`} in it. Move them to another school on the Users page first.`, "error");
        return;
      }
      const ok = await confirmDialog({
        title: `Remove ${item.dataset.name}?`,
        body: "It disappears from every County → School dropdown. Nobody is placed in it, so no one is affected.",
        confirmLabel: "Remove", danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        await deleteSchool(id);
        toast("School removed", "", "success");
        await renderSchoolList();
      } catch (err) {
        toast("Couldn't remove that school", friendlyError(err), "error");
        btn.disabled = false;
      }
    }
  });
  $("#schoolList").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches(".school-rename-input")) {
      e.preventDefault();
      e.target.closest("[data-school-id]").querySelector('[data-act="save-rename"]').click();
    }
  });

  /* ------------------------------------------------------------ staff accounts
     Every staff sign-in, grouped under a title per role, with accounts
     waiting for approval first. What each row offers follows two things
     the server sends: this person's permissions (users.*) and, per account,
     `canManage` (never your own account, never one at or above your level).
     The API checks both again on every action. Passwords are one-way
     hashed server-side and never come back to the browser, so "Set new
     password" sets a brand-new one instead of ever showing the old one.
     Search, status and sort all work client-side against the one fetch. */
  let allUsers = [];
  let grantable = []; // [{ value, label }] roles this administrator may give
  let editingUserId = null;
  let historyUserId = null;
  const historyCache = new Map();

  const STATUS_PILL = {
    pending: ["warm", "Waiting for approval"],
    suspended: ["danger", "Suspended"],
    deactivated: ["danger", "Deactivated"],
    rejected: ["danger", "Not approved"],
  };
  const schoolLabel = (id) => {
    if (!id) return "no school";
    const s = schoolDir.schools.find((x) => x.id === id);
    return s ? `${s.name} (${s.code})` : id;
  };

  /* Inline editor for one account. Where it sits follows the role:
     teachers and heads pick County → School from the school list (a new
     school, or a new role letter, gives them a new code — and a teacher's
     learners move with them); field officers pick a county; everyone else
     neither. Only the roles this administrator may give are offered. */
  function userEditRow(u) {
    const roles = grantable.some((r) => r.value === u.role) ? grantable : [{ value: u.role, label: ROLE_LABEL[u.role] || u.role }, ...grantable];
    const canDetails = has("users.edit");
    const canRole = has("users.roles.assign");
    const canPlace = has("users.placement.assign");
    return `
      <div class="task-row lib-edit-row" data-user="${esc(u.id)}" data-email="${esc(u.email || "")}">
        <div style="flex:1">
          <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">
            <div class="field"><label>Full name</label><input class="ue-name" type="text" value="${esc(u.fullName || "")}"${canDetails ? "" : " disabled"}></div>
            <div class="field"><label>Email</label><input class="ue-email" type="email" value="${esc(u.email || "")}"${canDetails ? "" : " disabled"}></div>
          </div>
          <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.6rem">
            <div class="field"><label>Role</label><select class="ue-role"${canRole ? "" : " disabled"}>${roles.map((r) =>
              `<option value="${esc(r.value)}"${r.value === u.role ? " selected" : ""}>${esc(r.label)}</option>`).join("")}</select></div>
            <div class="field ue-county-field"><label>County</label><select class="ue-county"${canPlace ? "" : " disabled"}></select></div>
            <div class="field ue-school-field"><label>School</label><select class="ue-school"${canPlace ? "" : " disabled"}></select></div>
          </div>
          <div class="field ue-tt-field"><label>Employment type</label>
            <select class="ue-tt"${canDetails ? "" : " disabled"}>${["", "BOM", "TSC"].map((t) =>
              `<option value="${t}"${t === (u.teacherType || "") ? " selected" : ""}>${t || "Not specified"}</option>`).join("")}</select></div>
          <p class="field-hint ue-note"></p>
          <div class="edit-actions">
            <button type="button" class="btn btn-primary" data-act="save-user">Save changes</button>
            <button type="button" class="btn btn-outline" data-act="cancel-user">Cancel</button>
          </div>
        </div>
      </div>`;
  }

  function wireUserEditor(u) {
    const row = $(`#usersList .lib-edit-row[data-user="${u.id}"]`);
    if (!row) return;
    userPicker = wireSchoolPicker(row.querySelector(".ue-county"), row.querySelector(".ue-school"), schoolDir,
      { schoolId: u.schoolId, countyId: schoolDir.counties.includes(u.county) ? u.county : "", onChange: syncUserEditor });
    row.querySelector(".ue-role").addEventListener("change", syncUserEditor);
    function syncUserEditor() {
      const role = row.querySelector(".ue-role").value;
      const inSchool = role === "teacher" || role === "school_leader";
      row.querySelector(".ue-county-field").hidden = !(inSchool || role === "field_officer");
      row.querySelector(".ue-school-field").hidden = !inSchool;
      row.querySelector(".ue-tt-field").hidden = role !== "teacher";
      const school = userPicker.current();
      const moving = inSchool && school && (school.id !== u.schoolId || role !== u.role);
      row.querySelector(".ue-note").textContent = !inSchool
        ? (role === "field_officer" ? "Field officers belong to a county, not a school — they pick the school per visit." : "This role works across every school and county.")
        : moving
          ? `They'll get a new code under ${school.code}${role === "teacher" ? ", and their learners move to this school with new codes too" : ""}.`
          : u.userCode ? `Code stays ${u.userCode}.` : "";
    }
    syncUserEditor();
  }

  /* The buttons one account gets, from permissions + authority over it. */
  function userActions(u) {
    const acts = [];
    const status = u.status || "active";
    if (u.canManage) {
      if (has("users.approve") && (status === "pending" || status === "rejected")) acts.push(["approve", "Approve"]);
      if (has("users.approve") && status === "pending") acts.push(["reject", "Reject", "danger"]);
      if (has("users.edit", "users.roles.assign", "users.placement.assign")) acts.push(["edit", "Edit"]);
      if (has("users.password.reset") && status === "active") {
        acts.push(["resetlink", "Send reset link"], ["password", "Set new password"]);
      }
      if (has("users.status.manage")) {
        if (status === "active") acts.push(["suspend", "Suspend"], ["deactivate", "Deactivate", "danger"]);
        if (status === "suspended") acts.push(["reactivate", "Reactivate"], ["deactivate", "Deactivate", "danger"]);
        if (status === "deactivated") acts.push(["reactivate", "Reactivate"]);
      }
    }
    if (has("audit.view")) acts.push(["history", historyUserId === u.id ? "Hide history" : "History"]);
    return acts.map(([act, label, cls]) =>
      `<button type="button" data-act="${act}"${cls ? ` class="${cls}"` : ""}>${esc(label)}</button>`).join("");
  }

  function userRow(u) {
    if (u.id === editingUserId) return userEditRow(u);
    const pill = STATUS_PILL[u.status];
    const meta = [
      pill ? `<span class="pill ${pill[0]}">${esc(pill[1])}</span>` : "",
      u.status === "pending" && u.requestedRole ? `asked for ${esc(ROLE_LABEL[u.requestedRole] || u.requestedRole)}` : "",
      u.userCode ? `<span class="code-chip">${esc(u.userCode)}</span>` : "",
      esc(u.email),
      u.county ? esc(u.county) : "",
      u.school ? esc(u.school) : "",
      u.teacherType ? esc(u.teacherType) : "",
      u.statusReason && u.status !== "active" ? `Reason: ${esc(u.statusReason)}` : "",
    ].filter(Boolean).join(" · ");
    const history = historyUserId === u.id
      ? `<div class="user-history" style="flex-basis:100%;margin-top:.5rem">${historyHtml(historyCache.get(u.id))}</div>`
      : "";
    return `
      <div class="task-row" data-user="${esc(u.id)}" style="flex-wrap:wrap"
           data-fullname="${esc(u.fullName || "")}" data-email="${esc(u.email || "")}"
           data-role="${esc(u.role)}" data-county="${esc(u.county || "")}"
           data-school="${esc(u.school || "")}" data-teachertype="${esc(u.teacherType || "")}">
        <div style="flex:1;min-width:0">
          <b>${esc(u.fullName || "(no name)")}</b>
          <span>${meta}</span>
        </div>
        <div class="roster-actions">${userActions(u)}</div>
        ${history}
      </div>`;
  }

  function userMatchesSearch(u, q) {
    if (!q) return true;
    const hay = [u.fullName, u.email, u.county, u.school, u.userCode, u.teacherType, ROLE_LABEL[u.role]]
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
    if (usersFailed) {
      list.innerHTML = errorState("Couldn't load staff accounts — check your connection and try again.", renderUsers);
      $("#usersMeta").textContent = "";
      return;
    }
    if (!allUsers.length) {
      list.innerHTML = `<div class="empty-state">No staff accounts yet.</div>`;
      $("#usersMeta").textContent = "";
      return;
    }
    if (gf.role === "learner") {
      list.innerHTML = `<div class="empty-state">Learner accounts aren't staff sign-ins — see Schools for learner counts by grade.</div>`;
      $("#usersMeta").textContent = "";
      return;
    }
    const q = $("#usersSearch").value.trim().toLowerCase();
    const sortBy = $("#usersSort").value;
    const status = $("#usersStatus").value;
    let filtered = allUsers.filter((u) => userMatchesSearch(u, q));
    if (status) filtered = filtered.filter((u) => (u.status || "active") === status);
    if (gf.county) filtered = filtered.filter((u) => (u.county || "") === gf.county);
    if (gf.school) filtered = filtered.filter((u) => (u.school || "") === gf.school);
    if (gf.role) filtered = filtered.filter((u) => u.role === gf.role);

    const pendingCount = allUsers.filter((u) => u.status === "pending").length;
    $("#usersMeta").textContent = (filtered.length === allUsers.length
      ? `${allUsers.length} account${allUsers.length === 1 ? "" : "s"}`
      : `${filtered.length} of ${allUsers.length} accounts`) + (pendingCount ? ` · ${pendingCount} waiting for approval` : "");

    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state">${emptyMsg("No accounts match your search.")}</div>`;
      return;
    }

    const group = (title, rows) => rows.length ? `
        <div class="list-group">
          <div class="list-group-title">${esc(title)}<span class="count">${rows.length}</span></div>
          ${rows.map(userRow).join("")}
        </div>` : "";
    const pending = sortUsers(filtered.filter((u) => u.status === "pending"), sortBy);
    list.innerHTML = group("Waiting for approval", pending) + STAFF_ROLES.map((r) =>
      group(r.label, sortUsers(filtered.filter((u) => u.role === r.value && u.status !== "pending"), sortBy))).join("");
    const editing = allUsers.find((u) => u.id === editingUserId);
    if (editing) wireUserEditor(editing);
  }

  let usersFailed = false;
  async function renderUsers() {
    $("#usersList").innerHTML = skeleton(4);
    try {
      ({ users: allUsers, grantableRoles: grantable } = await getUserDirectory());
      usersFailed = false;
    } catch (err) {
      console.error("could not load staff accounts:", err);
      usersFailed = true;
      allUsers = [];
    }
    renderUsersList();
  }

  $("#usersSearch").addEventListener("input", renderUsersList);
  $("#usersSort").addEventListener("change", renderUsersList);
  $("#usersStatus").addEventListener("change", renderUsersList);

  /* Status changes and approvals: what each one says before it happens. */
  const STATUS_DIALOG = {
    suspend: (n) => ({ title: `Suspend ${n}?`, body: "They're signed out of everything and can't sign in until reactivated. Nothing they made is deleted.", confirmLabel: "Suspend", danger: true }),
    deactivate: (n) => ({ title: `Deactivate ${n}?`, body: "Use this when someone has left. They can't sign in; their records stay. You can reactivate the account later.", confirmLabel: "Deactivate", danger: true }),
    reactivate: (n) => ({ title: `Reactivate ${n}?`, body: "They can sign in again with their current password.", confirmLabel: "Reactivate" }),
  };

  $("#usersList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const row = btn.closest("[data-user]");
    const id = row.dataset.user;
    const u = allUsers.find((x) => x.id === id);
    const name = u?.fullName || u?.email || "this account";
    const act = btn.dataset.act;

    try {
      if (act === "edit") {
        if (!schoolDir.counties.length) await renderSchoolList();
        editingUserId = id;
        renderUsersList();
      } else if (act === "cancel-user") {
        editingUserId = null;
        userPicker = null;
        renderUsersList();
      } else if (act === "save-user") {
        const role = row.querySelector(".ue-role").value;
        const inSchool = role === "teacher" || role === "school_leader";
        const school = userPicker?.current();
        const county = userPicker?.county() || "";
        if (inSchool && !school) {
          toast("Choose a school", "Teachers and school heads must be placed in a school from the list.", "error");
          return;
        }
        if (role === "field_officer" && !county) {
          toast("Choose a county", "Field officers belong to a county.", "error");
          return;
        }
        const patch = {};
        if (has("users.edit")) {
          patch.fullName = row.querySelector(".ue-name").value.trim();
          const email = row.querySelector(".ue-email").value.trim();
          if (email.toLowerCase() !== (row.dataset.email || "").toLowerCase()) patch.email = email;
          if (role === "teacher") patch.teacherType = row.querySelector(".ue-tt").value;
        }
        if (role !== u.role) patch.role = role;
        if (has("users.placement.assign")) {
          if (inSchool && school.id !== u.schoolId) patch.schoolId = school.id;
          if (role === "field_officer" && county !== (u.county || "")) patch.county = county;
          if (patch.role && inSchool) patch.schoolId = school.id;
          if (patch.role && role === "field_officer") patch.county = county;
        }
        btn.disabled = true;
        const updated = await updateUser(id, patch);
        toast("Account updated", updated.userCode ? `${updated.fullName} is ${updated.userCode}.` : "", "success");
        editingUserId = null;
        userPicker = null;
        historyCache.delete(id);
        renderUsers();
        renderSchoolList();
        renderAuditPanel();
      } else if (act === "approve") {
        const asked = ROLE_LABEL[u.requestedRole || u.role] || u.role;
        const where = u.school ? ` at ${u.school}` : u.county ? ` in ${u.county}` : "";
        const ok = await confirmDialog({
          title: `Approve ${name}?`,
          body: `They asked to join as ${asked}${where}. They'll be able to sign in straight away with that role. To give a different role or school, approve and then use Edit.`,
          confirmLabel: "Approve",
        });
        if (!ok) return;
        btn.disabled = true;
        await approveUser(id);
        toast("Account approved", `${name} can now use the portal.`, "success");
        historyCache.delete(id);
        renderUsers();
        renderAuditPanel();
      } else if (act === "reject") {
        const ok = await confirmDialog({
          title: `Reject ${name}?`,
          body: "They won't be able to use the portal. The request stays on record, and you can still approve it later.",
          confirmLabel: "Reject", danger: true,
        });
        if (!ok) return;
        btn.disabled = true;
        await rejectUser(id);
        toast("Request rejected", "", "success");
        historyCache.delete(id);
        renderUsers();
        renderAuditPanel();
      } else if (STATUS_DIALOG[act]) {
        if (!(await confirmDialog(STATUS_DIALOG[act](name)))) return;
        btn.disabled = true;
        await setUserStatus(id, act);
        toast(act === "reactivate" ? "Account reactivated" : act === "suspend" ? "Account suspended" : "Account deactivated", "", "success");
        historyCache.delete(id);
        renderUsers();
        renderAuditPanel();
      } else if (act === "history") {
        historyUserId = historyUserId === id ? null : id;
        if (historyUserId && !historyCache.has(id)) {
          historyCache.set(id, null); // loading
          renderUsersList();
          try {
            historyCache.set(id, (await getAuditLog({ targetId: id })).entries || []);
          } catch (err) {
            historyCache.delete(id);
            toast("Couldn't load the history", friendlyError(err), "error");
          }
        }
        renderUsersList();
      } else if (act === "resetlink") {
        if (!confirm(`Email a "set a new password" link to ${row.dataset.email}?`)) return;
        await sendPasswordResetLink(row.dataset.email);
        toast("Reset link sent successfully.", `${row.dataset.email} can follow it to set their own new password.`, "success");
      } else if (act === "password") {
        const password = prompt(`New password for ${row.dataset.email} — at least 8 characters`);
        if (!password) return;
        if (password.trim().length < 8) {
          toast("Couldn't do that", "Password must be at least 8 characters.", "error");
          return;
        }
        await resetUserPassword(id, password.trim());
        toast("Password reset successfully.", "Tell them their new password.", "success");
        historyCache.delete(id);
        renderAuditPanel();
      }
    } catch (err) {
      toast("Couldn't do that", friendlyError(err), "error");
      btn.disabled = false;
    }
  });

  /* ---- account history (audit log) ---- */
  const AUDIT_ACTION = {
    "account.created": "created the account",
    "account.approved": "approved the account",
    "account.rejected": "didn't approve the account",
    "account.suspended": "suspended the account",
    "account.deactivated": "deactivated the account",
    "account.reactivated": "reactivated the account",
    "account.updated": "edited the account",
    "role.changed": "changed the role",
    "school.changed": "changed the school",
    "county.changed": "changed the county",
    "email.changed": "changed the email",
    "password.reset": "set a new password",
    "learner.created": "added a learner",
    "learner.deleted": "removed a learner",
    "learner.updated": "edited a learner",
    "learner.pin_reset": "reset a learner's PIN",
    "learner.unlocked": "unlocked a learner",
    "invitation.created": "created an invitation",
    "invitation.revoked": "revoked an invitation",
    "invitation.accepted": "accepted an invitation",
  };
  const roleName = (r) => ROLE_LABEL[r] || r || "—";
  function auditDetail(e) {
    const d = e.details || {};
    switch (e.action) {
      case "role.changed": return `${roleName(d.from)} → ${roleName(d.to)}`;
      case "school.changed": return `${schoolLabel(d.from)} → ${schoolLabel(d.to)}`;
      case "county.changed": return `${d.from || "none"} → ${d.to || "none"}`;
      case "email.changed": return `${d.from || ""} → ${d.to || ""}`;
      case "account.created": return d.via === "invitation" ? `joined by invitation as ${roleName(d.role)}` : `asked to join as ${roleName(d.requestedRole)}`;
      case "account.approved": return `as ${roleName(d.role)}`;
      case "account.updated": return (d.fields || []).join(", ");
      case "invitation.created": case "invitation.revoked": case "invitation.accepted":
        return `${d.email || ""}${d.role ? ` as ${roleName(d.role)}` : ""}`;
      default:
        if (e.action.startsWith("learner.") && d.fullName) return `${d.fullName}${d.username ? ` (@${d.username})` : ""}`;
        return d.reason ? `Reason: ${d.reason}` : "";
    }
  }
  function auditRow(e, { withTarget = true } = {}) {
    const who = e.actorName || (e.actorKind === "system" ? "System" : "Someone");
    const target = withTarget && e.targetName && e.targetId !== e.actorId ? ` — ${e.targetName}` : "";
    const detail = auditDetail(e);
    return `<div class="result-row" style="align-items:flex-start">
        <span><b>${esc(who)}</b> ${esc(AUDIT_ACTION[e.action] || e.action)}${esc(target)}${detail ? `<br><span class="hint-inline">${esc(detail)}</span>` : ""}</span>
        <span class="hint-inline" style="white-space:nowrap">${esc(new Date(e.at).toLocaleString())}</span>
      </div>`;
  }
  function historyHtml(entries) {
    if (entries === null || entries === undefined) return skeleton(2, { avatar: false });
    return entries.length
      ? entries.map((e) => auditRow(e, { withTarget: false })).join("")
      : `<div class="empty-state">No recorded changes for this account yet.</div>`;
  }

  let auditBefore = null;
  async function renderAuditPanel({ more = false } = {}) {
    if (!has("audit.view")) return;
    $("#auditPanel").hidden = false;
    if (!more) { auditBefore = null; $("#auditList").innerHTML = skeleton(3, { avatar: false }); }
    try {
      const res = await getAuditLog({ before: more ? auditBefore : undefined });
      const html = (res.entries || []).map((e) => auditRow(e)).join("");
      if (more) $("#auditList").insertAdjacentHTML("beforeend", html);
      else $("#auditList").innerHTML = html || `<div class="empty-state">No account changes recorded yet.</div>`;
      auditBefore = res.nextBefore;
      $("#auditMore").hidden = !auditBefore;
    } catch (err) {
      $("#auditList").innerHTML = errorState(friendlyError(err), () => renderAuditPanel());
    }
  }
  $("#auditMore").addEventListener("click", () => renderAuditPanel({ more: true }));

  /* ---- invitations ---- */
  function syncInviteFields() {
    const role = $("#inv_role").value;
    const inSchool = role === "teacher" || role === "school_leader";
    $("#inv_county_field").hidden = !(inSchool || role === "field_officer");
    $("#inv_school_field").hidden = !inSchool;
  }
  async function renderInvitations() {
    try {
      const open = (await getInvitations()).filter((i) => i.status === "open");
      $("#invitationsList").innerHTML = open.length
        ? `<div class="list-group"><div class="list-group-title">Open invitations<span class="count">${open.length}</span></div>${
          open.map((i) => `<div class="task-row" data-invitation="${esc(i.id)}"><div style="flex:1;min-width:0"><b>${esc(i.email)}</b>
            <span>${esc(i.roleLabel)}${i.schoolId ? ` · ${esc(schoolLabel(i.schoolId))}` : i.county ? ` · ${esc(i.county)}` : ""} · expires ${esc(new Date(i.expiresAt).toLocaleDateString())}</span></div>
            <div class="roster-actions"><button type="button" class="danger" data-revoke="${esc(i.id)}">Revoke</button></div></div>`).join("")}</div>`
        : "";
    } catch (err) {
      $("#invitationsList").innerHTML = errorState(friendlyError(err), renderInvitations);
    }
  }
  if (has("users.invite")) {
    $("#invitePanel").hidden = false;
    $("#inviteToggle").addEventListener("click", async () => {
      const open = $("#inviteForm").hidden;
      $("#inviteForm").hidden = !open;
      $("#inviteToggle").setAttribute("aria-expanded", String(open));
      if (!open) return;
      $("#inviteResult").hidden = true;
      if (!grantable.length) await renderUsers();
      $("#inv_role").innerHTML = grantable.map((r) => `<option value="${esc(r.value)}">${esc(r.label)}</option>`).join("");
      $("#inv_role").value = grantable.some((r) => r.value === "teacher") ? "teacher" : grantable[0]?.value || "";
      if (!schoolDir.counties.length) await renderSchoolList();
      if (!invitePicker) invitePicker = wireSchoolPicker($("#inv_county"), $("#inv_school"), schoolDir);
      syncInviteFields();
    });
    $("#inv_role").addEventListener("change", syncInviteFields);
    $("#inviteCancel").addEventListener("click", () => {
      $("#inviteForm").hidden = true;
      $("#inviteToggle").setAttribute("aria-expanded", "false");
    });
    $("#inviteForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const role = $("#inv_role").value;
      const inSchool = role === "teacher" || role === "school_leader";
      const school = invitePicker?.current();
      const county = invitePicker?.county() || "";
      if (inSchool && !school) { toast("Choose a school", "Teachers and school heads are invited into a school.", "error"); return; }
      if (role === "field_officer" && !county) { toast("Choose a county", "Field officers belong to a county.", "error"); return; }
      const btn = e.target.querySelector("[type=submit]");
      btn.disabled = true;
      try {
        const { invitation, token } = await inviteStaff({
          email: $("#inv_email").value.trim(), role,
          schoolId: inSchool ? school.id : undefined,
          county: role === "field_officer" ? county : undefined,
        });
        const link = new URL(`index.html?invite=${encodeURIComponent(token)}`, location.href).href;
        $("#inviteResult").innerHTML = `
          <div><b>Invitation link for ${esc(invitation.email)} (${esc(invitation.roleLabel)})</b>
          Send this to them — it's shown only now, works once and expires on ${esc(new Date(invitation.expiresAt).toLocaleDateString())}.</div>
          <div style="display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap">
            <input id="inviteLink" type="text" readonly value="${esc(link)}" style="flex:1;min-width:12rem">
            <button type="button" class="btn btn-outline" id="inviteCopy">Copy link</button>
          </div>`;
        $("#inviteResult").hidden = false;
        $("#inviteCopy").addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(link); toast("Link copied", ""); }
          catch { $("#inviteLink").select(); }
        });
        $("#inviteForm").reset();
        $("#inviteForm").hidden = true;
        $("#inviteToggle").setAttribute("aria-expanded", "false");
        renderInvitations();
        renderAuditPanel();
      } catch (err) {
        toast("Couldn't create the invitation", friendlyError(err), "error");
      } finally {
        btn.disabled = false;
      }
    });
    $("#invitationsList").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-revoke]");
      if (!btn) return;
      const ok = await confirmDialog({ title: "Revoke this invitation?", body: "The link stops working straight away.", confirmLabel: "Revoke", danger: true });
      if (!ok) return;
      btn.disabled = true;
      try {
        await revokeInvitation(btn.dataset.revoke);
        toast("Invitation revoked", "", "success");
        renderInvitations();
        renderAuditPanel();
      } catch (err) {
        btn.disabled = false;
        toast("Couldn't revoke it", friendlyError(err), "error");
      }
    });
    renderInvitations();
  }
  renderAuditPanel();

  /* ------------------------------------------------------------ learners across schools
     Administrators and M&E find any learner, see every school and class
     they've been in, and (with learners.transfer) move them to another
     school. Classes and day-to-day rosters belong to each school head. */
  let finderResults = [];
  function fillFinderSchools() {
    const keep = $("#lf_school").value;
    $("#lf_school").innerHTML = `<option value="">All schools</option>${
      schoolDir.schools.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.code)})</option>`).join("")}`;
    $("#lf_school").value = schoolDir.schools.some((s) => s.id === keep) ? keep : "";
  }
  function renderFinder() {
    const canTransfer = has("learners.transfer");
    $("#lfMeta").textContent = `${finderResults.length} found`;
    $("#learnerFinderResults").innerHTML = finderResults.length
      ? finderResults.map((l) => `
        <div class="task-row" data-learner="${esc(l.id)}" style="flex-wrap:wrap">
          <div style="flex:1;min-width:12rem"><b>${esc(l.fullName)}</b>
            <span>${statusPill(l.status)} <span class="code-chip">${esc(l.learnerCode || l.userCode || "")}</span> ${esc(l.school || "")}${l.className ? ` · ${esc(l.className)}` : l.grade ? ` · ${esc(l.grade)}` : ""}</span></div>
          <div class="roster-actions">
            <button type="button" data-lf-history="${esc(l.id)}">History</button>
            ${canTransfer ? `<button type="button" data-lf-transfer="${esc(l.id)}">Transfer</button>` : ""}
          </div>
        </div>`).join("")
      : `<div class="empty-state">No learners match.</div>`;
  }
  if (has("learners.view.all")) {
    $("#learnerFinderPanel").hidden = false;
    $("#learnerFinder").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("#lf_q").value.trim();
      const schoolId = $("#lf_school").value;
      if (!q && !schoolId) { toast("Search for someone", "Type a name or code, or pick a school.", "error"); return; }
      $("#learnerFinderResults").innerHTML = skeleton(3);
      try {
        finderResults = await getLearners({ q, schoolId, status: $("#lf_archived").checked ? "all" : "active" });
        renderFinder();
      } catch (err) {
        $("#learnerFinderResults").innerHTML = errorState(friendlyError(err));
      }
    });
    $("#learnerFinderResults").addEventListener("click", async (e) => {
      const h = e.target.closest("[data-lf-history]");
      if (h) { const l = finderResults.find((x) => x.id === h.dataset.lfHistory); openHistoryPanel(l.id, l.fullName); return; }
      const t = e.target.closest("[data-lf-transfer]");
      if (!t) return;
      const l = finderResults.find((x) => x.id === t.dataset.lfTransfer);
      if (!schoolDir.schools.length) await renderSchoolList();
      const updated = await openTransferDialog(l, schoolDir.schools);
      if (updated) {
        finderResults = finderResults.map((x) => (x.id === updated.id ? updated : x));
        renderFinder();
        renderStats();
      }
    });
  }

  /* ---- academic year ---- */
  async function renderCalendar() {
    if (!has("calendar.manage")) return;
    $("#calendarPanel").hidden = false;
    try {
      const { years, currentYear, currentTerm } = await getAcademicYears();
      const next = String(Number(currentYear || new Date().getFullYear()) + 1);
      const hasNext = years.some((y) => y.id === next);
      $("#calendarText").textContent = currentYear
        ? `The portal is in the ${currentYear} school year${currentTerm ? `, Term ${String(currentTerm).replace(/^\d{4}-T/, "")}` : ""}. New classes and enrollments use this year. Start ${next} when the new school year begins — then school heads add the new year's classes and promote learners into them.`
        : "No school year is set yet.";
      $("#startNextYear").textContent = hasNext ? `Switch the portal to ${next}` : `Start the ${next} school year`;
      $("#startNextYear").hidden = false;
      $("#startNextYear").onclick = async () => {
        const ok = await confirmDialog({
          title: `Start ${next}?`,
          body: `The portal moves to the ${next} school year (terms Jan–Apr, May–Aug, Sep–Dec). Existing classes and records stay under ${currentYear}.`,
          confirmLabel: `Start ${next}`,
        });
        if (!ok) return;
        try {
          await createAcademicYear(next, { makeCurrent: true });
          toast(`Now in ${next}`, "School heads can add this year's classes.", "success");
          renderCalendar();
        } catch (err) {
          toast("Couldn't start the new year", friendlyError(err), "error");
        }
      };
    } catch (err) {
      $("#calendarText").textContent = friendlyError(err, "Couldn't load the school year.");
    }
  }
  renderCalendar();

  renderStats();
  renderLibrary();
  renderUsage();
  renderForms();
  renderKobo();
  if (has("users.view")) renderUsers();
}
main();

async function doSignOut() {
  await signOut();
  location.href = "index.html";
}
$("#signOutBtn")?.addEventListener("click", doSignOut);
$("#signOutBtn2")?.addEventListener("click", doSignOut);
