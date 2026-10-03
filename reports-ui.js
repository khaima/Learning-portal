/* Export reports: the reports this person may export (the server decides,
   from their permissions — GET /reports), the filters each one takes, and
   Excel / CSV / PDF. Every export is recorded on the server. Mounted by
   nav.js on any page with a [data-export-center] element, the first time
   that page is opened; the file writers (export.js) load on first use. */
import { esc, toast, errorState, friendlyError } from "./util.js";
import { apiGet } from "./api.js";
import { getSchools } from "./store.js";

const GROUPS = [
  ["Registers", ["learner-register", "teacher-register", "school-register"]],
  ["Learning", ["assignment-report", "assessment-report"]],
  ["Field work and data", ["field-visit-report", "kobo-report", "library-usage"]],
  ["Programme", ["me-indicator-report", "term-report", "county-report"]],
];
const STATUS = {
  "learner-register": [["active", "Enrolled now"], ["archived", "Left or archived"], ["all", "Everyone"]],
  "teacher-register": [["active", "Active accounts"], ["all", "All accounts"]],
};
/** These always cover one term or school year. */
const NEEDS_PERIOD = new Set(["me-indicator-report", "term-report"]);
/** A report covering everything can be narrowed to a county or school. */
const NARROWABLE = new Set(["All schools"]);
const LAST_KEY = "hpf_export_last";

const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

export async function mountExportCenter(el) {
  const head = `<div class="panel-head"><h2>Export reports</h2></div>`;
  el.hidden = false;
  el.innerHTML = `${head}<div class="empty-state">Loading…</div>`;
  let cat;
  try {
    cat = await apiGet("/reports");
  } catch (err) {
    el.innerHTML = head + errorState(
      navigator.onLine ? friendlyError(err, "Couldn't load the reports.") : "Exports are made from the latest records, so they need a connection.",
      () => mountExportCenter(el),
    );
    return;
  }
  if (!cat.reports?.length) { el.hidden = true; return; }

  const id = (k) => `${el.id || "xp"}_${k}`;
  const byId = new Map(cat.reports.map((r) => [r.id, r]));
  const grouped = GROUPS.map(([label, ids]) => [label, ids.filter((x) => byId.has(x)).map((x) => byId.get(x))]).filter(([, rs]) => rs.length);
  const options = grouped.length > 1
    ? grouped.map(([label, rs]) => `<optgroup label="${esc(label)}">${rs.map((r) => `<option value="${r.id}">${esc(r.title)}</option>`).join("")}</optgroup>`).join("")
    : cat.reports.map((r) => `<option value="${r.id}">${esc(r.title)}</option>`).join("");
  const field = (k, label, control) => `<div class="field" data-xp="${k}" hidden><label for="${id(k)}">${label}</label>${control}</div>`;
  const periods = cat.periods || [];

  el.innerHTML = `${head}
    <p class="hint" style="margin-top:0">Download as Excel, CSV or PDF. An export holds only what your account is allowed to see, and every export is recorded.</p>
    <div class="filter-bar-row xp-row">
      <div class="field xp-report"><label for="${id("report")}">Report</label><select id="${id("report")}">${options}</select></div>
    </div>
    <p class="chart-meta xp-desc" id="${id("desc")}"></p>
    <div class="filter-bar-row xp-row">
      ${field("county", "County", `<select id="${id("county")}"><option value="">All counties</option></select>`)}
      ${field("school", "School", `<select id="${id("school")}"><option value="">All schools</option></select>`)}
      ${field("period", "Term or school year", `<select id="${id("period")}"></select>`)}
      ${field("from", "From", `<input type="date" id="${id("from")}">`)}
      ${field("to", "To", `<input type="date" id="${id("to")}">`)}
      ${field("programme", "Programme", `<select id="${id("programme")}"><option value="">All active programmes</option>${
        (cat.programmes || []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.active ? "" : " (closed)"}</option>`).join("")}</select>`)}
      ${field("status", "Who", `<select id="${id("status")}"></select>`)}
    </div>
    <div class="xp-actions">
      <button type="button" class="btn btn-primary" data-format="xlsx">Excel</button>
      <button type="button" class="btn btn-outline" data-format="csv">CSV</button>
      <button type="button" class="btn btn-outline" data-format="pdf">PDF</button>
    </div>
    <p class="chart-meta xp-result" id="${id("result")}" aria-live="polite"></p>`;

  const $in = (k) => el.querySelector(`#${id(k)}`);
  const box = (k) => el.querySelector(`[data-xp="${k}"]`);
  const reportSel = $in("report");
  const last = recall(LAST_KEY);
  if (last && byId.has(last)) reportSel.value = last;

  // Counties and schools, only for those who can narrow by place.
  let dir = null;
  const fillSchools = () => {
    const county = $in("county").value;
    const keep = $in("school").value;
    const list = (dir?.schools || []).filter((s) => !county || s.county === county).sort((a, b) => a.name.localeCompare(b.name));
    $in("school").innerHTML = `<option value="">All schools</option>${list.map((s) => `<option>${esc(s.name)}</option>`).join("")}`;
    $in("school").value = list.some((s) => s.name === keep) ? keep : "";
  };
  // A dashboard with its own County / School filter: start from that choice.
  const gCounty = document.getElementById("gfCounty"), gSchool = document.getElementById("gfSchool");
  const follow = () => {
    if (!dir || !gCounty) return;
    $in("county").value = dir.counties.includes(gCounty.value) ? gCounty.value : "";
    fillSchools();
    if ([...$in("school").options].some((o) => o.value === gSchool?.value)) $in("school").value = gSchool.value;
  };
  if (cat.reports.some((r) => NARROWABLE.has(r.scope))) {
    getSchools().then((d) => {
      dir = d;
      $in("county").innerHTML = `<option value="">All counties</option>${d.counties.map((c) => `<option>${esc(c)}</option>`).join("")}`;
      fillSchools();
      follow();
    }).catch(() => {});
  }
  $in("county").addEventListener("change", fillSchools);
  for (const g of [gCounty, gSchool]) g?.addEventListener("change", () => setTimeout(follow));

  const show = () => {
    const r = byId.get(reportSel.value);
    const f = new Set(r.filters);
    el.querySelector(`#${id("desc")}`).innerHTML = `${esc(r.description)} <b>Covers:</b> ${esc(r.scope)}.`;
    const place = f.has("place") && NARROWABLE.has(r.scope);
    box("county").hidden = !place;
    box("school").hidden = !place;
    box("from").hidden = !f.has("dates");
    box("to").hidden = !f.has("dates");
    box("programme").hidden = !f.has("programme");
    box("period").hidden = !f.has("period");
    if (f.has("period")) {
      const keep = $in("period").value;
      const must = NEEDS_PERIOD.has(r.id);
      $in("period").innerHTML = (must ? "" : `<option value="">Any time</option>`) +
        periods.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}${p.current ? " (now)" : ""}</option>`).join("");
      const current = periods.find((p) => p.current) || periods.filter((p) => /-T\d$/.test(p.id)).at(-1);
      $in("period").value = periods.some((p) => p.id === keep) || (!must && keep === "") ? keep : must ? current?.id ?? "" : "";
    }
    box("status").hidden = !STATUS[r.id];
    if (STATUS[r.id]) $in("status").innerHTML = STATUS[r.id].map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    el.querySelector(`#${id("result")}`).textContent = "";
  };
  reportSel.addEventListener("change", () => { remember(LAST_KEY, reportSel.value); show(); });
  show();

  /** The chosen filters: for the request, and in words for the file. */
  const chosen = () => {
    const visible = (k) => !box(k).hidden && $in(k).value;
    const params = {}, words = [];
    const add = (k, label, text) => { if (visible(k)) { params[k] = $in(k).value; words.push(`${label}: ${text ?? $in(k).value}`); } };
    add("county", "County");
    add("school", "School");
    add("period", "Period", $in("period").selectedOptions[0]?.textContent.replace(" (now)", ""));
    add("from", "From");
    add("to", "To");
    add("programme", "Programme", $in("programme").selectedOptions[0]?.textContent);
    add("status", "Who", $in("status").selectedOptions[0]?.textContent);
    return { params, text: words.join(" · ") };
  };

  const buttons = [...el.querySelectorAll("[data-format]")];
  el.querySelector(".xp-actions").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-format]");
    if (!btn) return;
    const format = btn.dataset.format;
    const result = el.querySelector(`#${id("result")}`);
    if (!navigator.onLine) {
      toast("You're offline", "Exports are made from the latest records — connect and try again.", "error");
      return;
    }
    const { params, text } = chosen();
    if (params.from && params.to && params.from > params.to) {
      toast("Check the dates", "“From” is after “To”.", "error");
      return;
    }
    const label = btn.textContent;
    buttons.forEach((b) => { b.disabled = true; });
    btn.textContent = "Preparing…";
    result.textContent = "";
    try {
      const qs = new URLSearchParams({ ...params, format }).toString();
      const [report, writers] = await Promise.all([apiGet(`/reports/${reportSel.value}?${qs}`), import("./export.js")]);
      report.filterText = text;
      const rows = report.sections.reduce((t, s) => t + s.rows.length, 0);
      const saved = await writers.saveReport(report, format);
      result.innerHTML = rows
        ? `Saved <b>${esc(saved.name)}</b> — ${rows.toLocaleString()} row${rows === 1 ? "" : "s"}.`
        : `Saved <b>${esc(saved.name)}</b>. Nothing matched these filters, so it has the column headings only.`;
      toast("Report downloaded", `${report.title} (${writers.FORMATS[format].label})`);
    } catch (err) {
      toast("Couldn't export", friendlyError(err, "Check your connection and try again."), "error");
    } finally {
      btn.textContent = label;
      buttons.forEach((b) => { b.disabled = false; });
    }
  });
}
