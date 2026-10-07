/* ============================================================
   HPF Digital Learning Portal — the Kobo data pipeline screens.

   KoboToolbox → API → validation → normalization → the portal's own
   records → dashboards. For each attached survey the Education Team sees
   what came in, what passed, and why anything didn't; tells the portal
   which questions hold the school, county, officer and date; teaches it
   school names it couldn't place; and accepts or excludes flagged
   submissions (with a reason). M&E can look but not change anything.

   The rules themselves live server-side (kobo_pipeline.ts).
   ============================================================ */

import { esc, toast, friendlyError, skeleton, errorState, confirmDialog } from "./util.js";
import { openContentPanel } from "./viewer.js";
import {
  koboPipeline, saveKoboMapping, reprocessKobo, koboRecords, koboRecord, reviewKoboRecord,
  saveKoboSchoolAlias, createKoboWebhook, removeKoboWebhook,
} from "./store.js";

const RULE_LABEL = {
  required: "Required answers", type: "Answer types", school: "School code", county: "County",
  officer: "Field officer", duplicate: "Duplicates", date: "Dates",
};
const STATUS_LABEL = { valid: "Valid", invalid: "Failing checks", duplicate: "Duplicate", rejected: "Rejected in Kobo", removed: "Deleted in Kobo" };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

function statusPill(r) {
  if (r.review === "accepted") return `<span class="pill ok">Accepted</span>`;
  if (r.review === "excluded") return `<span class="pill danger">Excluded</span>`;
  const cls = r.status === "valid" ? "ok" : r.status === "rejected" || r.status === "removed" ? "" : "danger";
  return `<span class="pill ${cls}">${esc(STATUS_LABEL[r.status] || r.status)}</span>`;
}
const issueList = (issues) => issues.length
  ? `<ul class="kp-issues">${issues.map((i) => `<li class="${i.severity}"><b>${i.severity === "error" ? "Error" : "Warning"}</b> · ${esc(i.message)}</li>`).join("")}</ul>`
  : "";

/** The review queue filters: what to show. */
const VIEWS = {
  review: { label: "Needs review", params: { status: "needs_review" } },
  duplicate: { label: "Duplicates", params: { status: "duplicate" } },
  rejected: { label: "Rejected in Kobo", params: { status: "rejected" } },
  valid: { label: "Valid", params: { status: "valid" } },
  accepted: { label: "Accepted by a person", params: { review: "accepted" } },
  excluded: { label: "Excluded by a person", params: { review: "excluded" } },
  all: { label: "Everything", params: {} },
};

/** The data pipeline for one survey. `schools` = the portal's school list
    (for placing unmatched names); `onChange` after anything changes. */
/* canManage: change the field mapping (kobo.manage); canRecheck: re-check the
   submissions (kobo.manage or kobo.sync); canReview:
   accept or exclude flagged submissions and match school names (kobo.review). */
export async function openKoboPipeline(formId, { canManage = false, canRecheck = canManage, canReview = canManage, schools = [], onChange = () => {} } = {}) {
  const panel = openContentPanel({ title: "Data pipeline", html: skeleton(5) });
  const state = { view: "review", rule: "", offset: 0 };
  let p;

  async function load() {
    try { p = await koboPipeline(formId); } catch (err) {
      panel.innerHTML = errorState(friendlyError(err), load);
      return;
    }
    render();
    loadQueue();
  }

  function mappingHtml() {
    if (!p.fields.length) return `<p class="field-hint">Sync this survey first, so the portal knows its questions.</p>`;
    const m = p.mapping || {};
    const sel = (key, label, hint) => `
      <div class="field"><label for="km_${key}">${label}</label>
        <select id="km_${key}" ${canManage ? "" : "disabled"}>
          <option value="">— not in this survey —</option>
          ${p.fields.map((f) => `<option value="${esc(f.xpath)}"${m[key] === f.xpath ? " selected" : ""}>${esc(f.label)} (${esc(f.xpath)})</option>`).join("")}
        </select>
        <p class="field-hint">${hint}</p></div>`;
    return `
      <form class="fill-form" data-mapping>
        <div class="lms-grid3" style="grid-template-columns:repeat(2,minmax(0,1fr))">
          ${sel("school", "School", "A school code (NRK-001), a school name, or a choice list of schools.")}
          ${sel("county", "County", "Checked against the school's own county.")}
          ${sel("officer", "Field officer", "The hidden question the portal fills when an officer opens the survey.")}
          ${sel("date", "Visit / observation date", "Otherwise the form's own date, then when Kobo received it.")}
        </div>
        <label class="q-choice"><input type="checkbox" id="km_schoolRequired" ${m.schoolRequired !== false ? "checked" : ""} ${canManage ? "" : "disabled"}> A missing school is an error</label>
        <label class="q-choice"><input type="checkbox" id="km_officerRequired" ${m.officerRequired !== false ? "checked" : ""} ${canManage ? "" : "disabled"}> A missing officer is an error (surveys opened from the portal always have one)</label>
        ${canManage ? `<div class="lms-actions" style="margin-top:.6rem"><button class="btn btn-primary" type="submit">Save and re-check every submission</button></div>` : ""}
      </form>`;
  }

  function unknownSchoolsHtml() {
    if (!p.unknownSchools.length) return "";
    const opts = (selected) => `<option value="">Choose the portal school…</option>${schools.map((s) =>
      `<option value="${esc(s.id)}"${selected === s.id ? " selected" : ""}>${esc(s.name)} (${esc(s.code)})</option>`).join("")}`;
    return `
      <h3 style="margin:1.2rem 0 .3rem">School names it couldn't place</h3>
      <p class="field-hint" style="margin-top:0">Tell the portal which school each one means. It's remembered for every survey, and everything is re-checked.</p>
      ${p.unknownSchools.map((u, i) => `
        <div class="task-row" style="flex-wrap:wrap">
          <div style="flex:1;min-width:12rem"><b>“${esc(u.value)}”</b><span>${u.count} submission${u.count === 1 ? "" : "s"}${u.suggestion ? ` · looks like ${esc(u.suggestion.name)}` : ""}</span></div>
          ${canReview ? `<select data-alias-school="${i}" style="max-width:16rem">${opts(u.suggestion?.id)}</select>
            <div class="roster-actions"><button type="button" data-alias="${i}">Save</button></div>` : ""}
        </div>`).join("")}`;
  }

  function render() {
    const s = p.stats;
    panel.innerHTML = `
      <p class="hint" style="margin-top:0"><b>${esc(p.form.title)}</b> · last synced ${esc(fmt(p.form.syncedAt))} · checked ${esc(fmt(p.form.processedAt))}
        ${canRecheck && p.fields.length ? ` · <button type="button" class="intel-link" data-recheck>Re-check now</button>` : ""}</p>
      <div class="chart-stats" style="grid-template-columns:repeat(5,1fr)">
        <div><b>${s.received}</b><span>Received</span></div>
        <div><b>${s.counted}</b><span>On the dashboards</span></div>
        <div><b>${s.needsReview}</b><span>Need review</span></div>
        <div><b>${s.duplicate}</b><span>Duplicates</span></div>
        <div><b>${s.rejected}</b><span>Rejected in Kobo</span></div>
      </div>
      <p class="field-hint">${s.withWarnings} with warnings (still counted) · ${s.accepted} accepted and ${s.excluded} excluded by a person${s.removed ? ` · ${s.removed} deleted in Kobo since` : ""}.</p>
      <h3 style="margin:1rem 0 .3rem">Checks</h3>
      <div class="kp-rules">${p.issuesByRule.map((r) => `
        <button type="button" class="kp-rule${r.errors ? " has-errors" : r.warnings ? " has-warnings" : ""}" data-rule="${esc(r.rule)}">
          <b>${esc(RULE_LABEL[r.rule] || r.rule)}</b>
          <span>${r.errors ? `${r.errors} failing` : "✓ passing"}${r.warnings ? ` · ${r.warnings} warning${r.warnings === 1 ? "" : "s"}` : ""}</span>
        </button>`).join("")}</div>
      <details class="kp-section" ${p.mapping ? "" : "open"}>
        <summary>Which questions hold the school, county, officer and date</summary>
        ${mappingHtml()}
      </details>
      ${unknownSchoolsHtml()}
      <h3 style="margin:1.2rem 0 .3rem">Submissions</h3>
      <div class="filter-bar-row" style="margin-bottom:.6rem">
        <div class="field"><label for="kq_view">Show</label>
          <select id="kq_view">${Object.entries(VIEWS).map(([k, v]) => `<option value="${k}"${k === state.view ? " selected" : ""}>${esc(v.label)}</option>`).join("")}</select></div>
        <div class="field"><label for="kq_rule">Check</label>
          <select id="kq_rule"><option value="">Any</option>${Object.entries(RULE_LABEL).map(([k, v]) => `<option value="${k}"${k === state.rule ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
      </div>
      <div data-queue>${skeleton(3)}</div>`;
  }

  async function loadQueue() {
    const box = panel.querySelector("[data-queue]");
    if (!box) return;
    box.innerHTML = skeleton(3);
    let res;
    try {
      res = await koboRecords({ formId, ...VIEWS[state.view].params, rule: state.rule, limit: 25, offset: state.offset });
    } catch (err) {
      box.innerHTML = errorState(friendlyError(err), loadQueue);
      return;
    }
    if (!res.records.length) {
      box.innerHTML = `<div class="empty-state">${state.view === "review" ? "Nothing waiting for review. ✓" : "Nothing here."}</div>`;
      return;
    }
    box.innerHTML = res.records.map((r) => `
      <div class="kp-record" data-rec="${esc(r.id)}">
        <div class="kp-record-head">
          <div><b>#${r.koboId}</b> ${statusPill(r)} ${r.counted ? `<span class="pill ok">Counted</span>` : ""}
            <span class="hint-inline">${esc(fmt(r.submittedAt))}${r.observedOn ? ` · visit ${esc(r.observedOn)}` : ""}</span></div>
          <div class="roster-actions">
            <button type="button" data-view>View</button>
            ${canReview && r.status !== "removed" ? `
              ${r.review !== "accepted" && !r.counted ? `<button type="button" data-decide="accepted">Accept</button>` : ""}
              ${r.review !== "excluded" ? `<button type="button" class="danger" data-decide="excluded">Exclude</button>` : ""}
              ${r.review ? `<button type="button" data-clear>Clear decision</button>` : ""}` : ""}
          </div>
        </div>
        <div class="hint-inline">${r.school ? esc(r.school) : r.schoolValue ? `School given: “${esc(r.schoolValue)}”` : "No school"}${r.county ? ` · ${esc(r.county)}` : ""}${r.officer ? ` · ${esc(r.officer)}` : ""}</div>
        ${issueList(r.issues)}
        ${r.review ? `<p class="field-hint" style="margin:.2rem 0 0">${r.review === "accepted" ? "Accepted" : "Excluded"}: ${esc(r.reviewNote || "")}</p>` : ""}
        <div data-decision hidden></div>
      </div>`).join("")
      + (res.total > 25 ? `
        <div class="lms-actions" style="justify-content:space-between;margin-top:.5rem;font-size:.82rem">
          <span>${state.offset + 1}–${Math.min(res.total, state.offset + 25)} of ${res.total}</span>
          <span><button type="button" class="btn btn-outline q-small" data-page="-25" ${state.offset ? "" : "disabled"}>← Newer</button>
          <button type="button" class="btn btn-outline q-small" data-page="25" ${state.offset + 25 < res.total ? "" : "disabled"}>Older →</button></span>
        </div>` : "");
  }

  panel.addEventListener("change", (e) => {
    if (e.target.id === "kq_view") { state.view = e.target.value; state.offset = 0; loadQueue(); }
    if (e.target.id === "kq_rule") { state.rule = e.target.value; state.offset = 0; loadQueue(); }
  });

  panel.addEventListener("click", async (e) => {
    const recheck = e.target.closest("[data-recheck]");
    if (recheck) {
      recheck.disabled = true;
      recheck.textContent = "Re-checking…";
      try {
        p = await reprocessKobo(formId);
        toast("Re-checked", `${p.stats.counted} of ${p.stats.received} submissions count.`, "success");
        onChange();
        render();
        loadQueue();
      } catch (err) {
        toast("Couldn't re-check", friendlyError(err), "error");
        recheck.disabled = false;
        recheck.textContent = "Re-check now";
      }
      return;
    }
    const rule = e.target.closest("[data-rule]");
    if (rule) {
      state.rule = rule.dataset.rule;
      state.view = "all";
      state.offset = 0;
      panel.querySelector("#kq_rule").value = state.rule;
      panel.querySelector("#kq_view").value = "all";
      loadQueue();
      panel.querySelector("[data-queue]").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const page = e.target.closest("[data-page]");
    if (page) { state.offset = Math.max(0, state.offset + Number(page.dataset.page)); loadQueue(); return; }
    const aliasBtn = e.target.closest("[data-alias]");
    if (aliasBtn) {
      const u = p.unknownSchools[Number(aliasBtn.dataset.alias)];
      const schoolId = panel.querySelector(`[data-alias-school="${aliasBtn.dataset.alias}"]`).value;
      if (!schoolId) { toast("Choose the school first", "", "error"); return; }
      aliasBtn.disabled = true;
      try {
        await saveKoboSchoolAlias(u.value, schoolId);
        toast("Saved", `“${u.value}” now means that school, in every survey.`, "success");
        onChange();
        load();
      } catch (err) {
        aliasBtn.disabled = false;
        toast("Couldn't save it", friendlyError(err), "error");
      }
      return;
    }
    const recEl = e.target.closest("[data-rec]");
    if (!recEl) return;
    const id = recEl.dataset.rec;
    if (e.target.closest("[data-view]")) { openKoboRecord(id, () => openKoboPipeline(formId, { canManage, canRecheck, canReview, schools, onChange })); return; }
    if (e.target.closest("[data-clear]")) {
      try { await reviewKoboRecord(id, "clear"); onChange(); load(); } catch (err) { toast("Couldn't do that", friendlyError(err), "error"); }
      return;
    }
    const decide = e.target.closest("[data-decide]");
    if (decide) {
      const box = recEl.querySelector("[data-decision]");
      const accept = decide.dataset.decide === "accepted";
      box.hidden = false;
      box.innerHTML = `
        <form class="kp-decide" data-decide-form="${decide.dataset.decide}">
          <input type="text" maxlength="1000" required placeholder="${accept ? "Why it should count anyway (e.g. checked with the school)" : "Why it should be left out (e.g. a training entry)"}">
          <button class="btn ${accept ? "btn-primary" : "btn-danger"} q-small" type="submit">${accept ? "Accept" : "Exclude"}</button>
          <button class="btn btn-ghost q-small" type="button" data-cancel-decision>Cancel</button>
        </form>`;
      box.querySelector("input").focus();
      return;
    }
    if (e.target.closest("[data-cancel-decision]")) { recEl.querySelector("[data-decision]").hidden = true; }
  });

  panel.addEventListener("submit", async (e) => {
    const decideForm = e.target.closest("[data-decide-form]");
    if (decideForm) {
      e.preventDefault();
      const id = decideForm.closest("[data-rec]").dataset.rec;
      const note = decideForm.querySelector("input").value.trim();
      try {
        await reviewKoboRecord(id, decideForm.dataset.decideForm, note);
        toast(decideForm.dataset.decideForm === "accepted" ? "Accepted — it now counts" : "Excluded from the dashboards", "", "success");
        onChange();
        load();
      } catch (err) {
        toast("Couldn't save that", friendlyError(err), "error");
      }
      return;
    }
    if (e.target.matches("[data-mapping]")) {
      e.preventDefault();
      const val = (k) => panel.querySelector(`#km_${k}`).value || null;
      const btn = e.target.querySelector("[type=submit]");
      btn.disabled = true;
      btn.textContent = "Re-checking…";
      try {
        p = await saveKoboMapping(formId, {
          school: val("school"), county: val("county"), officer: val("officer"), date: val("date"),
          schoolRequired: panel.querySelector("#km_schoolRequired").checked,
          officerRequired: panel.querySelector("#km_officerRequired").checked,
        });
        toast("Saved", `Every submission was re-checked: ${p.stats.counted} of ${p.stats.received} now count.`, "success");
        onChange();
        render();
        loadQueue();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Save and re-check every submission";
        toast("Couldn't save the mapping", friendlyError(err), "error");
      }
    }
  });

  load();
}

/** One submission: its issues, and its answers as normalized. */
export async function openKoboRecord(id, onBack) {
  const panel = openContentPanel({ title: "Submission", html: skeleton(5) });
  let d;
  try { d = await koboRecord(id); } catch (err) {
    panel.innerHTML = errorState(friendlyError(err));
    return;
  }
  const r = d.record;
  panel.innerHTML = `
    ${onBack ? `<button type="button" class="intel-link" data-back style="margin-bottom:.6rem">← Back to the pipeline</button>` : ""}
    <p class="hint" style="margin-top:0"><b>${esc(r.survey)}</b> · #${r.koboId} · received ${esc(fmt(r.submittedAt))}${r.observedOn ? ` · visit ${esc(r.observedOn)}` : ""}</p>
    <p>${statusPill(r)} ${r.counted ? `<span class="pill ok">Counted on the dashboards</span>` : `<span class="pill">Not counted</span>`}
      ${r.duplicateOf ? `<span class="hint-inline">copy of #${r.duplicateOf}</span>` : ""}</p>
    <p class="hint-inline">${r.school ? esc(r.school) : r.schoolValue ? `School given: “${esc(r.schoolValue)}” (not matched)` : "No school"}${r.county ? ` · ${esc(r.county)}` : ""}${r.officer ? ` · ${esc(r.officer)}` : ""}</p>
    ${r.review ? `<p class="field-hint">${r.review === "accepted" ? "Accepted" : "Excluded"} by ${esc(r.reviewedBy || "—")} on ${esc(fmt(r.reviewedAt))}: ${esc(r.reviewNote || "")}</p>` : ""}
    ${d.issues.length ? `<h3 style="margin:1rem 0 .3rem">Checks that flagged it</h3>${issueList(d.issues)}` : `<p class="field-hint">Passed every check.</p>`}
    <h3 style="margin:1rem 0 .3rem">Answers</h3>
    <div class="lms-table-wrap"><table class="lms-table intel-table">
      <thead><tr><th class="lms-name">Question</th><th class="lms-name">Answer</th></tr></thead>
      <tbody>${d.answers.map((a) => {
        const flagged = d.issues.some((i) => i.field === a.xpath);
        return `<tr${flagged ? ' class="kp-flagged"' : ""}><td class="lms-name">${esc(a.label)}<br><small class="hint-inline">${esc(a.xpath)}</small></td><td class="lms-name">${esc(a.value)}</td></tr>`;
      }).join("")}</tbody>
    </table></div>`;
  panel.querySelector("[data-back]")?.addEventListener("click", onBack);
}

/* ------------------------------------------------------------ live push (REST Service) */

export function webhookBoxHtml(cfg, canManage) {
  const w = cfg.webhook || {};
  return `
    <div class="kp-push">
      <b>Live push from KoboToolbox</b>
      <p class="field-hint" style="margin:.2rem 0 .5rem">${w.configured
        ? `On since ${esc(fmt(w.setAt))}. New submissions arrive and are checked the moment they're sent. “Sync now” still catches anything missed, edits, and Kobo's own approvals.`
        : "Off. Submissions arrive when someone presses “Sync now”. Turn on the push to have each one arrive and be checked as soon as it's sent."}</p>
      ${canManage ? `<div class="lms-actions">
        <button type="button" class="btn btn-outline q-small" data-hook-create>${w.configured ? "Create a new password" : "Set up the push"}</button>
        ${w.configured ? `<button type="button" class="btn btn-ghost q-small danger" data-hook-off>Turn off</button>` : ""}
      </div>` : ""}
      <div data-hook-secret></div>
    </div>`;
}

/** Wires the push box inside `root`; `refresh()` (async) re-reads the
    settings and redraws it. */
export function wireWebhookBox(root, refresh) {
  root.addEventListener("click", async (e) => {
    if (e.target.closest("[data-hook-create]")) {
      if (!(await confirmDialog({
        title: "Create the push password?",
        body: "It's shown once. Any password made before stops working, so update KoboToolbox straight after.",
        confirmLabel: "Create",
      }))) return;
      try {
        const h = await createKoboWebhook();
        await refresh(); // the status line now says it's on…
        root.querySelector("[data-hook-secret]").innerHTML = `
          <div class="kp-secret">
            <p><b>In KoboToolbox</b>, open each survey → <b>Settings</b> → <b>REST Services</b> → <b>Register a new service</b>:</p>
            <dl>
              <dt>Endpoint URL</dt><dd><code>${esc(h.url)}</code></dd>
              <dt>Type</dt><dd>JSON</dd>
              <dt>Security</dt><dd>Basic Authorization</dd>
              <dt>Username</dt><dd><code>${esc(h.username)}</code></dd>
              <dt>Password</dt><dd><code>${esc(h.password)}</code> <button type="button" class="intel-link" data-copy="${esc(h.password)}">Copy</button></dd>
            </dl>
            <p class="field-hint">Copy the password now — it isn't shown again. Only surveys attached here are accepted; anything else is ignored.</p>
          </div>`; // …and the password stays on screen until they leave
      } catch (err) {
        toast("Couldn't create it", friendlyError(err), "error");
      }
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); toast("Copied", ""); } catch { toast("Couldn't copy", "Select it and copy by hand.", "error"); }
      return;
    }
    if (e.target.closest("[data-hook-off]")) {
      if (!(await confirmDialog({ title: "Turn off the push?", body: "KoboToolbox's calls will be refused. Remove the REST Service in KoboToolbox too. Sync keeps working.", confirmLabel: "Turn off", danger: true }))) return;
      try { await removeKoboWebhook(); toast("Push turned off", ""); await refresh(); } catch (err) { toast("Couldn't do that", friendlyError(err), "error"); }
    }
  });
}

