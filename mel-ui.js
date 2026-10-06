/* ============================================================
   HPF Digital Learning Portal — the M&E layer screens.

   PROGRAMME → OUTCOMES → INDICATORS → TARGETS → ACTUALS → EVIDENCE → REPORT

   Results: each indicator's baseline, target, actual (live from the data,
   or recorded and verified), achievement and evidence, for a term or year,
   for the whole programme or a county or school. Framework: programmes,
   outcomes, indicators and where each one's data comes from, and targets.
   Reports: frozen results, printable and downloadable.

   The rules (sources, achievement, verification) live server-side (me.ts).
   ============================================================ */

import { esc, toast, friendlyError, skeleton, errorState, confirmDialog } from "./util.js";
import { openContentPanel, closeViewer } from "./viewer.js";
import {
  melBreakdown, recordMelActual, verifyMelActual, melActual, addMelEvidence, uploadMelEvidence,
  createMelOutcome, updateMelOutcome, createMelIndicator, updateMelIndicator, setMelTarget,
} from "./store.js";
import { fmtValue, ragPill, STATUS } from "./mel-format.js";
export { fmtValue, ragPill };

/** Impact dashboards an indicator can also appear on. */
const DASHBOARD_THEMES = {
  reach: "Reach", learning: "Learning", teacher_development: "Teacher development",
  field_operations: "Field operations", digital_resources: "Digital resources",
};
const SOURCE_LABEL = { verified: "Verified", recorded: "Recorded", live: "Live", none: "—", rejected: "Rejected" };
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");

/** A value in its unit. */
function sourcePill(row) {
  const s = row.valueSource;
  const cls = s === "verified" ? "ok" : s === "recorded" ? "warm" : "";
  return `<span class="pill ${cls}" title="${s === "live" ? "Worked out now from the data — not yet recorded" : ""}">${esc(SOURCE_LABEL[s] || s)}</span>`;
}

/* ------------------------------------------------------------ results */

export function resultsHtml(res) {
  if (!res.outcomes.length) return `<div class="empty-state">This programme has no outcomes or indicators yet — add them on the Framework page.</div>`;
  const s = res.summary;
  return `
    <div class="mel-summary">
      <span class="pill ok">${s.met} met</span><span class="pill warm">${s.close} close</span>
      <span class="pill danger">${s.not_met} not met</span><span class="pill">${s.no_data} without data</span>
      <span class="hint-inline">${esc(res.period.label)} · ${esc(res.scope.label)}</span>
    </div>
    ${res.outcomes.map((o) => `
      <div class="mel-outcome">
        <h3>${o.code ? `<span class="code-chip">${esc(o.code)}</span> ` : ""}${esc(o.title)}</h3>
        ${o.indicators.length ? `<div class="lms-table-wrap"><table class="lms-table intel-table mel-table">
          <thead><tr><th class="lms-name">Indicator</th><th>Baseline</th><th>Target</th><th>Actual</th><th class="lms-name">Achievement</th><th class="lms-name">Data</th><th>Evidence</th></tr></thead>
          <tbody>${o.indicators.map((i) => `
            <tr data-mel-ind="${esc(i.id)}">
              <td class="lms-name"><button type="button" class="intel-link">${i.code ? `${esc(i.code)} ` : ""}${esc(i.name)}</button>
                ${i.evidenceHint ? `<br><small class="hint-inline">Evidence: ${esc(i.evidenceHint)}</small>` : ""}</td>
              <td>${fmtValue(i.baselineValue, i.unit)}</td>
              <td>${i.target ? `${fmtValue(i.target.value, i.unit)}${i.target.from === "programme" && res.scope.type !== "programme" ? "<sup title='The programme-wide target'>*</sup>" : ""}` : "—"}</td>
              <td class="lms-strong">${fmtValue(i.value, i.unit)}</td>
              <td class="lms-name">${ragPill(i.achievement)}</td>
              <td class="lms-name">${sourcePill(i)}</td>
              <td>${i.recorded ? i.recorded.evidence.length : "—"}</td>
            </tr>`).join("")}</tbody>
        </table></div>` : `<p class="field-hint">No indicators yet.</p>`}
      </div>`).join("")}
    <p class="field-hint">Achievement is the actual as a share of the target (the other way round for indicators meant to go down): <b>met</b> at 100%+, <b>close</b> at 80%+. <b>Live</b> values are worked out now from the data; <b>recorded</b> ones are a fixed snapshot with evidence; <b>verified</b> ones were checked by someone else. ${res.scope.type !== "programme" ? "* the programme-wide target, where there's none for this county or school." : ""}</p>`;
}

/** One indicator in the results: working, recorded value, evidence, actions, breakdown. */
export function openIndicatorPanel(row, res, { can, onChange = () => {} }) {
  const panel = openContentPanel({ title: row.name, html: "" });
  const rec = row.recorded;
  const scopeBody = { period: res.period.id, scopeType: res.scope.type, scopeId: res.scope.id };
  const unit = row.unit;
  const sourceText = row.source === "kobo" ? `Validated Kobo submissions — ${row.sourceConfig.questionLabel ? `“${row.sourceConfig.questionLabel}”` : "count"}${row.sourceConfig.choices ? ` = ${row.sourceConfig.choices.join(" / ")}` : ""}`
    : row.source === "portal" ? "A portal measure" : "Entered by hand";
  panel.innerHTML = `
    <p class="hint" style="margin-top:0">${esc(res.programme.name)} · ${esc(res.period.label)} · ${esc(res.scope.label)}</p>
    ${row.definition ? `<p>${esc(row.definition)}</p>` : ""}
    <div class="chart-stats" style="grid-template-columns:repeat(4,1fr)">
      <div><b>${fmtValue(row.baselineValue, unit)}</b><span>Baseline${row.baselinePeriod ? ` (${esc(row.baselinePeriod)})` : ""}</span></div>
      <div><b>${row.target ? fmtValue(row.target.value, unit) : "—"}</b><span>Target${row.target?.from === "programme" && res.scope.type !== "programme" ? " (programme)" : ""}</span></div>
      <div><b>${fmtValue(row.value, unit)}</b><span>Actual · ${esc(SOURCE_LABEL[row.valueSource] || "")}</span></div>
      <div><b>${row.achievement.percent != null ? `${Math.round(row.achievement.percent)}%` : "—"}</b><span>${STATUS[row.achievement.status].label}</span></div>
    </div>
    <dl class="dq-facts">
      <dt>Source</dt><dd>${esc(sourceText)}</dd>
      ${row.live ? `<dt>Live now</dt><dd>${fmtValue(row.live.value, unit)}${row.live.denominator != null ? ` (${row.live.numerator} of ${row.live.denominator})` : ""} — ${esc(row.live.method)}</dd>` : ""}
      ${rec ? `<dt>Recorded</dt><dd>${fmtValue(rec.value, unit)}${rec.denominator != null ? ` (${rec.numerator} of ${rec.denominator})` : ""} by ${esc(rec.recordedBy || "—")} on ${esc(fmtDay(rec.recordedAt))} — ${esc(rec.method)}${rec.note ? `. ${esc(rec.note)}` : ""}</dd>
        <dt>Verification</dt><dd>${rec.status === "verified" ? `Verified by ${esc(rec.verifiedBy || "—")} on ${esc(fmtDay(rec.verifiedAt))}` : rec.status === "rejected" ? `Rejected by ${esc(rec.verifiedBy || "—")}` : "Not verified yet"}${rec.verificationNote ? ` — ${esc(rec.verificationNote)}` : ""}</dd>` : ""}
      ${row.evidenceHint ? `<dt>Evidence expected</dt><dd>${esc(row.evidenceHint)}</dd>` : ""}
    </dl>
    ${rec ? `<h3 style="margin:1rem 0 .3rem">Evidence</h3>${rec.evidence.length ? `<ul class="mel-evidence">${rec.evidence.map((e) => `<li>${evidenceLine(e)}</li>`).join("")}</ul>` : `<p class="field-hint">None yet.</p>`}
      <button type="button" class="intel-link" data-versions>All versions and files →</button>` : ""}
    ${can.record ? `
      <form class="dq-fix" data-record>
        <b>${rec ? "Record again" : "Record the actual"}</b>
        <span class="hint-inline">${row.source === "manual" ? "Enter the value — then add the evidence for it." : "Saves the value as it is now, with how it was worked out and the data behind it. Later changes to the data won't change it."}</span>
        ${row.source === "manual" ? `<div class="lms-grid3">
          <label class="field" style="margin:0"><span>Value</span><input name="value" type="number" step="any" required></label>
          <label class="field" style="margin:0"><span>Numerator <small>(optional)</small></span><input name="numerator" type="number" step="any"></label>
          <label class="field" style="margin:0"><span>Denominator <small>(optional)</small></span><input name="denominator" type="number" step="any"></label></div>` : ""}
        <input type="text" name="note" maxlength="2000" placeholder="Note (optional)">
        <button class="btn btn-primary q-small" type="submit" ${row.source !== "manual" && row.live?.value == null ? "disabled title='No data yet'" : ""}>${row.source === "manual" ? "Record" : `Record ${fmtValue(row.live?.value, unit)}`}</button>
      </form>` : ""}
    ${can.verify && rec?.status === "recorded" && rec.recordedById === can.userId ? `<p class="field-hint">You recorded this value, so someone else verifies it.</p>` : ""}
    ${can.verify && rec?.status === "recorded" && rec.recordedById !== can.userId ? `
      <form class="dq-fix" data-verify>
        <b>Verify</b><span class="hint-inline">Confirm the recorded value against its evidence — or reject it, saying why. You can't verify your own.</span>
        <input type="text" name="note" maxlength="2000" placeholder="What you checked">
        <div class="lms-actions"><button class="btn btn-primary q-small" type="submit" value="verified">Verify</button><button class="btn btn-ghost q-small" type="submit" value="rejected">Reject</button></div>
      </form>` : ""}
    ${can.record && rec ? `
      <form class="dq-fix" data-evidence>
        <b>Add evidence</b>
        <select name="kind"><option value="link">A link (a shared folder, a document)</option><option value="file">A file</option><option value="note">A note</option></select>
        <input type="text" name="title" maxlength="300" placeholder="Title (e.g. Teacher observation forms, Term 2)" required>
        <input type="url" name="url" placeholder="https://…" data-for="link">
        <input type="file" name="file" data-for="file" hidden>
        <textarea name="text" rows="2" maxlength="4000" placeholder="The note" data-for="note" hidden></textarea>
        <button class="btn btn-outline q-small" type="submit">Add</button>
      </form>` : ""}
    <h3 style="margin:1rem 0 .3rem">By county and school</h3>
    <div data-breakdown><button type="button" class="btn btn-outline q-small" data-load-breakdown>Show the breakdown</button></div>`;

  panel.addEventListener("change", (e) => {
    if (e.target.name !== "kind") return;
    const form = e.target.closest("form");
    for (const el of form.querySelectorAll("[data-for]")) el.hidden = el.dataset.for !== e.target.value;
  });
  panel.addEventListener("click", async (e) => {
    if (e.target.closest("[data-versions]")) { openActualHistory(rec.id, unit); return; }
    if (!e.target.closest("[data-load-breakdown]")) return;
    const box = panel.querySelector("[data-breakdown]");
    box.innerHTML = skeleton(4, { avatar: false });
    try {
      const b = await melBreakdown(row.id, res.period.id);
      box.innerHTML = `<div class="lms-table-wrap"><table class="lms-table intel-table">
        <thead><tr><th class="lms-name">Where</th><th>Target</th><th>Actual</th><th class="lms-name">Achievement</th><th class="lms-name">Data</th></tr></thead>
        <tbody>${b.rows.filter((r) => r.value != null || r.target).map((r) => `
          <tr class="mel-scope-${r.scopeType}"><td class="lms-name">${esc(r.label)}</td><td>${r.target ? fmtValue(r.target.value, unit) : "—"}</td>
            <td class="lms-strong">${fmtValue(r.value, unit)}${r.live?.denominator != null && !r.recorded ? ` <small class="hint-inline">(${r.live.numerator}/${r.live.denominator})</small>` : ""}</td>
            <td class="lms-name">${ragPill(r.achievement)}</td><td class="lms-name">${r.recorded ? esc(SOURCE_LABEL[r.recorded.status] || r.recorded.status) : r.live?.value != null ? "Live" : "—"}</td></tr>`).join("")}</tbody>
      </table></div><p class="field-hint">Counties and schools with no data and no target are left out.</p>`;
    } catch (err) {
      box.innerHTML = errorState(friendlyError(err));
    }
  });
  panel.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const get = (n) => form.querySelector(`[name="${n}"]`)?.value?.trim() ?? "";
    const btns = form.querySelectorAll("button");
    btns.forEach((b) => { b.disabled = true; });
    try {
      if (form.matches("[data-record]")) {
        const body = { indicatorId: row.id, ...scopeBody, note: get("note") };
        if (row.source === "manual") Object.assign(body, { value: get("value"), numerator: get("numerator"), denominator: get("denominator") });
        const r = await recordMelActual(body);
        toast("Recorded", `${fmtValue(r.value, unit)} for ${res.scope.label}, ${res.period.label}.`, "success");
      } else if (form.matches("[data-verify]")) {
        await verifyMelActual(rec.id, e.submitter?.value, get("note"));
        toast(e.submitter?.value === "verified" ? "Verified" : "Rejected", "", "success");
      } else if (form.matches("[data-evidence]")) {
        const kind = get("kind");
        if (kind === "file") {
          const file = form.querySelector('[name="file"]').files?.[0];
          if (!file) throw new Error("Choose the file");
          await uploadMelEvidence(rec.id, file, get("title"));
        } else {
          await addMelEvidence(rec.id, { kind, title: get("title"), url: get("url"), text: get("text") });
        }
        toast("Evidence added", "", "success");
      }
      closeViewer();
      onChange(row.id);
    } catch (err) {
      btns.forEach((b) => { b.disabled = false; });
      toast("Couldn't do that", friendlyError(err), "error");
    }
  });
}

function evidenceLine(e) {
  const kind = { kobo_form: "Kobo survey", portal_data: "Portal data", file: "File", link: "Link", note: "Note" }[e.kind] || e.kind;
  const extra = e.kind === "kobo_form" ? ` — ${e.recordCount ?? 0} validated submission${e.recordCount === 1 ? "" : "s"}${e.details?.question ? `, “${esc(e.details.question)}”` : ""}`
    : e.kind === "portal_data" && e.details?.denominator != null ? ` — ${e.details.numerator} of ${e.details.denominator}` : "";
  const title = e.kind === "link" && e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>`
    : e.file?.downloadUrl || e.file?.viewUrl ? `<a href="${esc(e.file.downloadUrl || e.file.viewUrl)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title);
  return `<span class="code-chip">${esc(kind)}</span> ${title}${extra}${e.details?.text ? `<br><small>${esc(e.details.text)}</small>` : ""}`;
}

async function openActualHistory(id, unit) {
  const panel = openContentPanel({ title: "Recorded versions", html: skeleton(4) });
  try {
    const { versions } = await melActual(id);
    panel.innerHTML = `<ol class="dq-history">${versions.map((v) => `
      <li><b>${fmtValue(v.value, unit)}</b> ${v.current ? `<span class="pill ok">Current</span>` : `<span class="pill">Replaced</span>`} <span class="pill ${v.status === "verified" ? "ok" : v.status === "rejected" ? "danger" : "warm"}">${esc(SOURCE_LABEL[v.status] || v.status)}</span>
        <div class="hint-inline">Recorded ${esc(fmtDay(v.recordedAt))} by ${esc(v.recordedBy || "—")}${v.verifiedAt ? ` · ${v.status} ${esc(fmtDay(v.verifiedAt))} by ${esc(v.verifiedBy || "—")}` : ""}</div>
        <div class="hint-inline">${esc(v.method)}${v.denominator != null ? ` (${v.numerator} of ${v.denominator})` : ""}${v.note ? ` · ${esc(v.note)}` : ""}${v.verificationNote ? ` · ${esc(v.verificationNote)}` : ""}</div>
        ${v.evidence.length ? `<ul class="mel-evidence">${v.evidence.map((e) => `<li>${evidenceLine(e)}</li>`).join("")}</ul>` : ""}
      </li>`).join("")}</ol>`;
  } catch (err) {
    panel.innerHTML = errorState(friendlyError(err));
  }
}

/* ------------------------------------------------------------ framework */

export function frameworkHtml(fw, canManage) {
  const p = fw.programme;
  return `
    <div class="mel-prog-head">
      <div><h3 style="margin:0">${p.code ? `${esc(p.code)} · ` : ""}${esc(p.name)}</h3>
        <p class="hint" style="margin:.2rem 0">${esc(p.description || "")}${p.startDate ? ` · ${esc(p.startDate)} – ${esc(p.endDate || "")}` : ""} · ${esc(p.status)}</p></div>
      ${canManage ? `<button type="button" class="btn btn-outline q-small" data-add-outcome>+ Add an outcome</button>` : ""}
    </div>
    ${fw.outcomes.length ? fw.outcomes.map((o) => `
      <div class="mel-outcome" data-outcome="${esc(o.id)}">
        <div class="mel-outcome-head">
          <h3>${o.code ? `<span class="code-chip">${esc(o.code)}</span> ` : ""}${esc(o.title)}</h3>
          ${canManage ? `<span class="roster-actions"><button type="button" data-edit-outcome>Edit</button><button type="button" data-add-indicator>+ Indicator</button><button type="button" class="danger" data-archive-outcome>Archive</button></span>` : ""}
        </div>
        ${o.description ? `<p class="field-hint" style="margin-top:0">${esc(o.description)}</p>` : ""}
        ${o.indicators.length ? o.indicators.map((i) => {
          const targets = fw.targets.filter((t) => t.indicatorId === i.id);
          return `
          <div class="mel-ind" data-indicator="${esc(i.id)}">
            <div><b>${i.code ? `${esc(i.code)} ` : ""}${esc(i.name)}</b>
              <div class="hint-inline">${esc(i.unit)} · ${i.direction === "decrease" ? "lower is better" : "higher is better"} · ${esc(sourceSummary(i, fw))}${i.baselineValue != null ? ` · baseline ${fmtValue(i.baselineValue, i.unit)}${i.baselinePeriod ? ` (${esc(i.baselinePeriod)})` : ""}` : ""}${i.evidenceHint ? ` · evidence: ${esc(i.evidenceHint)}` : ""}${i.dashboardTheme ? ` · <span class="pill">on ${esc(DASHBOARD_THEMES[i.dashboardTheme] || i.dashboardTheme)}</span>` : ""}</div>
              <div class="hint-inline">Targets: ${targets.length ? targets.map((t) => `${esc(periodLabel(fw, t.period))}${t.scopeType !== "programme" ? ` (${esc(scopeLabel(fw, t))})` : ""} ${fmtValue(t.value, i.unit)}`).join(" · ") : "none yet"}</div></div>
            ${canManage ? `<span class="roster-actions"><button type="button" data-edit-indicator>Edit</button><button type="button" data-targets>Targets</button><button type="button" class="danger" data-archive-indicator>Archive</button></span>` : ""}
          </div>`;
        }).join("") : `<p class="field-hint">No indicators yet.</p>`}
      </div>`).join("") : `<div class="empty-state">No outcomes yet.${canManage ? " Add the programme's first outcome." : ""}</div>`}`;
}
const periodLabel = (fw, id) => fw.periods.find((p) => p.id === id)?.label ?? id;
const scopeLabel = (fw, t) => t.scopeType === "county" ? t.scopeId : fw.scopes.schools.find((s) => s.id === t.scopeId)?.name ?? t.scopeId;
function sourceSummary(i, fw) {
  const c = i.sourceConfig || {};
  if (i.source === "portal") return `portal: ${fw.sources.portal.find((m) => m.key === c.metric)?.label ?? c.metric}${c.visitType ? ` (${c.visitType})` : ""}`;
  if (i.source === "kobo") {
    const f = fw.sources.kobo.find((k) => k.id === c.formId);
    const m = { count: "number of submissions", percent_choice: `% answering ${(c.choices || []).join("/")}`, mean: "average", percent_at_least: `% at least ${c.threshold}` }[c.measure];
    return `Kobo: ${f?.title ?? "survey"} — ${m}${c.questionLabel ? ` to “${c.questionLabel}”` : ""}`;
  }
  return "entered by hand";
}

/** Wires the framework editor inside `root`; `reload()` redraws it and
    resolves to the fresh framework. */
export function wireFramework(root, getFw, reload) {
  root.addEventListener("click", async (e) => {
    const fw = getFw();
    if (!fw) return;
    const outcomeEl = e.target.closest("[data-outcome]");
    const indEl = e.target.closest("[data-indicator]");
    const outcome = outcomeEl ? fw.outcomes.find((o) => o.id === outcomeEl.dataset.outcome) : null;
    const ind = indEl ? outcome?.indicators.find((i) => i.id === indEl.dataset.indicator) : null;
    try {
      if (e.target.closest("[data-add-outcome]")) return openOutcomeEditor(fw, null, reload);
      if (e.target.closest("[data-edit-outcome]")) return openOutcomeEditor(fw, outcome, reload);
      if (e.target.closest("[data-add-indicator]")) return openIndicatorEditor(fw, outcome, null, reload);
      if (e.target.closest("[data-edit-indicator]")) return openIndicatorEditor(fw, outcome, ind, reload);
      if (e.target.closest("[data-targets]")) return openTargetsEditor(fw, ind, reload);
      if (e.target.closest("[data-archive-outcome]")) {
        if (!(await confirmDialog({ title: `Archive “${outcome.title}”?`, body: "It and its indicators leave the results and new reports. Recorded actuals and past reports are kept.", confirmLabel: "Archive", danger: true }))) return;
        await updateMelOutcome(outcome.id, { archived: true });
        reload();
      }
      if (e.target.closest("[data-archive-indicator]")) {
        if (!(await confirmDialog({ title: `Archive “${ind.name}”?`, body: "It leaves the results and new reports. Its targets, recorded actuals and past reports are kept.", confirmLabel: "Archive", danger: true }))) return;
        await updateMelIndicator(ind.id, { archived: true });
        reload();
      }
    } catch (err) {
      toast("Couldn't do that", friendlyError(err), "error");
    }
  });
}

function openOutcomeEditor(fw, o, reload) {
  const panel = openContentPanel({
    title: o ? "Edit outcome" : "New outcome",
    html: `<form class="fill-form" data-f>
      <div class="lms-grid3" style="grid-template-columns:8rem 1fr"><div class="field"><label>Code</label><input name="code" maxlength="20" value="${esc(o?.code || "")}" placeholder="1"></div>
        <div class="field"><label>Outcome</label><input name="title" maxlength="300" required value="${esc(o?.title || "")}" placeholder="Teachers use ICT effectively in teaching"></div></div>
      <div class="field"><label>Description <span class="hint-inline">— optional</span></label><textarea name="description" rows="3" maxlength="4000">${esc(o?.description || "")}</textarea></div>
      <button class="btn btn-primary" type="submit">Save</button></form>`,
  });
  panel.querySelector("[data-f]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { code: f.get("code"), title: f.get("title"), description: f.get("description") };
    try {
      if (o) await updateMelOutcome(o.id, body); else await createMelOutcome({ programmeId: fw.programme.id, ...body });
      closeViewer();
      reload();
    } catch (err) { toast("Couldn't save it", friendlyError(err), "error"); }
  });
}

function openIndicatorEditor(fw, outcome, i, reload) {
  const c = i?.sourceConfig || {};
  const src = i?.source || "kobo";
  const panel = openContentPanel({
    title: i ? "Edit indicator" : `New indicator — ${outcome.title}`,
    html: `<form class="fill-form" data-f>
      <div class="lms-grid3" style="grid-template-columns:8rem 1fr"><div class="field"><label>Code</label><input name="code" maxlength="20" value="${esc(i?.code || "")}" placeholder="1.1"></div>
        <div class="field"><label>Indicator</label><input name="name" maxlength="300" required value="${esc(i?.name || "")}" placeholder="% of teachers integrating ICT"></div></div>
      <div class="field"><label>Definition <span class="hint-inline">— how it's counted, in words</span></label><textarea name="definition" rows="2" maxlength="4000">${esc(i?.definition || "")}</textarea></div>
      <div class="lms-grid3">
        <div class="field"><label>Unit</label><select name="unit">${["percent", "count", "number"].map((u) => `<option${(i?.unit || "percent") === u ? " selected" : ""}>${u}</option>`).join("")}</select></div>
        <div class="field"><label>Better when it goes</label><select name="direction"><option value="increase"${i?.direction !== "decrease" ? " selected" : ""}>up</option><option value="decrease"${i?.direction === "decrease" ? " selected" : ""}>down</option></select></div>
        <div class="field"><label>Evidence expected</label><input name="evidenceHint" maxlength="300" value="${esc(i?.evidenceHint || "")}" placeholder="Teacher observation form"></div>
      </div>
      <div class="lms-grid3" style="grid-template-columns:1fr 1fr">
        <div class="field"><label>Baseline</label><input name="baselineValue" type="number" step="any" value="${i?.baselineValue ?? ""}"></div>
        <div class="field"><label>Baseline period</label><input name="baselinePeriod" maxlength="40" value="${esc(i?.baselinePeriod || "")}" placeholder="2026 Term 1"></div>
      </div>
      <div class="field"><label>Also show on <span class="hint-inline">— an impact dashboard, as well as M&amp;E</span></label><select name="dashboardTheme">
        <option value="">Only on M&amp;E</option>${Object.entries(DASHBOARD_THEMES).map(([v, l]) => `<option value="${v}"${i?.dashboardTheme === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
      <fieldset class="mel-source"><legend>Where the actuals come from</legend>
        <label class="q-choice"><input type="radio" name="source" value="kobo"${src === "kobo" ? " checked" : ""}> Validated Kobo survey data</label>
        <label class="q-choice"><input type="radio" name="source" value="portal"${src === "portal" ? " checked" : ""}> A measure the portal already tracks</label>
        <label class="q-choice"><input type="radio" name="source" value="manual"${src === "manual" ? " checked" : ""}> Entered by hand (with evidence)</label>
        <div data-src="kobo">
          <div class="field"><label>Survey</label><select name="formId"><option value="">Choose…</option>${fw.sources.kobo.map((f) => `<option value="${esc(f.id)}"${c.formId === f.id ? " selected" : ""}>${esc(f.title)}${f.synced ? "" : " (not synced yet)"}</option>`).join("")}</select></div>
          <div class="field"><label>Measure</label><select name="measure">
            <option value="percent_choice"${c.measure === "percent_choice" || !c.measure ? " selected" : ""}>% of submissions giving an answer</option>
            <option value="count"${c.measure === "count" ? " selected" : ""}>Number of submissions</option>
            <option value="mean"${c.measure === "mean" ? " selected" : ""}>Average of a number</option>
            <option value="percent_at_least"${c.measure === "percent_at_least" ? " selected" : ""}>% at or above a threshold</option></select></div>
          <div class="field" data-need="question"><label>Question</label><select name="question"></select></div>
          <div class="field" data-need="choices"><label>Answers that count</label><div data-choices class="mel-choices"></div></div>
          <div class="field" data-need="threshold"><label>Threshold</label><input name="threshold" type="number" step="any" value="${c.threshold ?? ""}"></div>
        </div>
        <div data-src="portal">
          <div class="field"><label>Measure</label><select name="metric">${fw.sources.portal.map((m) => `<option value="${esc(m.key)}"${c.metric === m.key ? " selected" : ""}>${esc(m.label)}</option>`).join("")}</select></div>
          <div class="field" data-need="visitType"><label>Visit type <span class="hint-inline">— optional</span></label><select name="visitType"><option value="">Any</option>${fw.sources.visitTypes.map((v) => `<option${c.visitType === v ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
        </div>
      </fieldset>
      <button class="btn btn-primary" type="submit">Save</button></form>`,
  });
  const form = panel.querySelector("[data-f]");
  const val = (n) => form.querySelector(`[name="${n}"]${n === "source" ? ":checked" : ""}`)?.value ?? "";
  function sync() {
    const source = val("source");
    for (const el of form.querySelectorAll("[data-src]")) el.hidden = el.dataset.src !== source;
    const formDef = fw.sources.kobo.find((f) => f.id === val("formId"));
    const measure = val("measure");
    const keepQ = form.querySelector('[name="question"]').value || c.question || "";
    const fields = (formDef?.fields || []).filter((f) => measure === "percent_choice" ? f.choices.length : ["integer", "decimal", "range"].includes(f.type) || measure === "count");
    form.querySelector('[name="question"]').innerHTML = fields.length
      ? fields.map((f) => `<option value="${esc(f.xpath)}"${f.xpath === keepQ ? " selected" : ""}>${esc(f.label)}</option>`).join("")
      : `<option value="">${formDef ? "No suitable question — sync the survey on Kobo Surveys" : "Choose the survey first"}</option>`;
    const q = fields.find((f) => f.xpath === form.querySelector('[name="question"]').value);
    const chosen = new Set(c.choices || []);
    form.querySelector("[data-choices]").innerHTML = (q?.choices || []).map((ch) => `<label class="q-choice"><input type="checkbox" value="${esc(ch.name)}"${chosen.has(ch.name) ? " checked" : ""}> ${esc(ch.label)}</label>`).join("");
    form.querySelector('[data-need="question"]').hidden = measure === "count";
    form.querySelector('[data-need="choices"]').hidden = measure !== "percent_choice";
    form.querySelector('[data-need="threshold"]').hidden = measure !== "percent_at_least";
    form.querySelector('[data-need="visitType"]').hidden = !["schools_visited", "field_visits"].includes(val("metric"));
  }
  form.addEventListener("change", (e) => { if (!e.target.closest("[data-choices]")) sync(); });
  sync();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const source = val("source");
    const sourceConfig = source === "kobo"
      ? { formId: val("formId"), measure: val("measure"), question: val("question"), threshold: val("threshold"),
          choices: [...form.querySelectorAll("[data-choices] input:checked")].map((x) => x.value) }
      : source === "portal" ? { metric: val("metric"), visitType: val("visitType") || undefined } : {};
    const body = {
      code: val("code"), name: val("name"), definition: val("definition"), unit: val("unit"), direction: val("direction"),
      evidenceHint: val("evidenceHint"), baselineValue: val("baselineValue"), baselinePeriod: val("baselinePeriod"), source, sourceConfig,
      dashboardTheme: val("dashboardTheme"),
    };
    try {
      if (i) await updateMelIndicator(i.id, body); else await createMelIndicator({ outcomeId: outcome.id, ...body });
      closeViewer();
      reload();
    } catch (err) { toast("Couldn't save it", friendlyError(err), "error"); }
  });
}

function openTargetsEditor(fw, i, reload) {
  const targets = fw.targets.filter((t) => t.indicatorId === i.id);
  const current = fw.periods.find((p) => p.current)?.id ?? fw.periods[0]?.id ?? "";
  const panel = openContentPanel({
    title: `Targets — ${i.name}`,
    html: `
      ${targets.length ? `<div class="lms-table-wrap"><table class="lms-table intel-table"><thead><tr><th class="lms-name">Period</th><th class="lms-name">For</th><th>Target</th><th></th></tr></thead>
        <tbody>${targets.map((t) => `<tr><td class="lms-name">${esc(periodLabel(fw, t.period))}</td><td class="lms-name">${t.scopeType === "programme" ? "Whole programme" : esc(scopeLabel(fw, t))}</td>
          <td class="lms-strong">${fmtValue(t.value, i.unit)}</td><td><button type="button" class="intel-link" data-clear='${esc(JSON.stringify({ period: t.period, scopeType: t.scopeType, scopeId: t.scopeId }))}'>Clear</button></td></tr>`).join("")}</tbody></table></div>`
      : `<p class="field-hint">No targets yet.</p>`}
      <form class="fill-form dq-fix" data-f style="margin-top:.8rem">
        <b>Set a target</b>
        <div class="lms-grid3">
          <div class="field" style="margin:0"><label>Period</label><select name="period">${fw.periods.map((p) => `<option value="${esc(p.id)}"${p.id === current ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select></div>
          <div class="field" style="margin:0"><label>For</label><select name="scope"><option value="programme|">Whole programme</option>
            <optgroup label="County">${fw.scopes.counties.map((x) => `<option value="county|${esc(x)}">${esc(x)}</option>`).join("")}</optgroup>
            <optgroup label="School">${fw.scopes.schools.map((s) => `<option value="school|${esc(s.id)}">${esc(s.name)} (${esc(s.county)})</option>`).join("")}</optgroup></select></div>
          <div class="field" style="margin:0"><label>Target${i.unit === "percent" ? " (%)" : ""}</label><input name="value" type="number" step="any" required></div>
        </div>
        <input type="text" name="note" maxlength="1000" placeholder="Note (optional) — e.g. agreed in the Term 1 review">
        <button class="btn btn-primary q-small" type="submit">Save target</button>
      </form>
      <p class="field-hint">A county or school without its own target is measured against the programme-wide one. Every change is in the audit log.</p>`,
  });
  // Reopen with the fresh framework, so the table shows the change.
  const done = async () => {
    closeViewer();
    const fresh = await reload();
    const ind = fresh?.outcomes.flatMap((o) => o.indicators).find((x) => x.id === i.id);
    if (ind) openTargetsEditor(fresh, ind, reload);
  };
  panel.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-clear]");
    if (!b) return;
    try { await setMelTarget({ indicatorId: i.id, ...JSON.parse(b.dataset.clear), value: null }); done(); } catch (err) { toast("Couldn't clear it", friendlyError(err), "error"); }
  });
  panel.querySelector("[data-f]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const [scopeType, scopeId] = String(f.get("scope")).split("|");
    try {
      await setMelTarget({ indicatorId: i.id, period: f.get("period"), scopeType, scopeId, value: f.get("value"), note: f.get("note") });
      toast("Target saved", "", "success");
      done();
    } catch (err) { toast("Couldn't save it", friendlyError(err), "error"); }
  });
}

/* ------------------------------------------------------------ reports */

export function reportHtml(r, content) {
  const c = content;
  return `
    <article class="mel-report">
      <header>
        <p class="hint">${r.status === "final" ? `<span class="pill ok">Final</span> ${esc(fmtDay(r.finalizedAt))} by ${esc(r.finalizedBy || "—")}` : `<span class="pill warm">Draft</span>`} · generated ${esc(fmtDay(r.generatedAt))} by ${esc(r.generatedBy || "—")}</p>
        <h2>${esc(r.title)}</h2>
        <p>${esc(c.programme.name)} · ${esc(c.period.label)} (${esc(c.period.from)} – ${esc(c.period.to)}) · ${esc(c.scope.label)}</p>
        ${r.note ? `<p class="field-hint">${esc(r.note)}</p>` : ""}
        <p class="mel-summary"><span class="pill ok">${c.summary.met} met</span><span class="pill warm">${c.summary.close} close</span><span class="pill danger">${c.summary.not_met} not met</span><span class="pill">${c.summary.no_data} without data</span></p>
      </header>
      ${c.outcomes.map((o) => `
        <section>
          <h3>${o.code ? `${esc(o.code)}. ` : ""}${esc(o.title)}</h3>
          <div class="lms-table-wrap"><table class="lms-table intel-table mel-table">
            <thead><tr><th class="lms-name">Indicator</th><th>Baseline</th><th>Target</th><th>Actual</th><th class="lms-name">Achievement</th><th class="lms-name">Data</th><th class="lms-name">Evidence</th></tr></thead>
            <tbody>${o.indicators.map((i) => `<tr>
              <td class="lms-name">${i.code ? `${esc(i.code)} ` : ""}${esc(i.name)}</td><td>${fmtValue(i.baselineValue, i.unit)}</td>
              <td>${i.target ? fmtValue(i.target.value, i.unit) : "—"}</td><td class="lms-strong">${fmtValue(i.value, i.unit)}</td>
              <td class="lms-name">${ragPill(i.achievement)}</td>
              <td class="lms-name">${esc(SOURCE_LABEL[i.valueSource] || i.valueSource)}${i.recorded?.verifiedBy ? ` (${esc(i.recorded.verifiedBy)})` : ""}</td>
              <td class="lms-name">${i.recorded?.evidence?.length ? i.recorded.evidence.map((e) => esc(e.title) + (e.recordCount != null ? ` (${e.recordCount})` : "")).join("; ") : i.evidenceHint ? `<span class="hint-inline">expected: ${esc(i.evidenceHint)}</span>` : "—"}</td>
            </tr>`).join("")}</tbody>
          </table></div>
        </section>`).join("")}
      <p class="field-hint">Live = worked out from the data when the report was made, not yet recorded; Recorded = a fixed snapshot with evidence; Verified = checked by someone other than the person who recorded it.</p>
    </article>`;
}

/** The report as CSV, one row per indicator. */
export function reportCsv(r, c) {
  const head = ["Programme", "Period", "Scope", "Outcome", "Indicator code", "Indicator", "Unit", "Baseline", "Target", "Actual", "Achievement %", "Status", "Data", "Verified by", "Evidence"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = c.outcomes.flatMap((o) => o.indicators.map((i) => [
    c.programme.name, c.period.label, c.scope.label, o.title, i.code, i.name, i.unit, i.baselineValue, i.target?.value, i.value,
    i.achievement.percent, STATUS[i.achievement.status].label, SOURCE_LABEL[i.valueSource] || i.valueSource, i.recorded?.verifiedBy ?? "",
    (i.recorded?.evidence || []).map((e) => e.title).join("; "),
  ]));
  return "﻿" + [head, ...rows].map((r) => r.map(q).join(",")).join("\r\n");
}
