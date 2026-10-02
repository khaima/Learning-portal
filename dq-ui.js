/* ============================================================
   HPF Digital Learning Portal — the Data Quality Center screens.

   Every data problem the portal finds, how serious it is, where it is,
   what's being done about it and by whom. Issues move OPEN → UNDER_REVIEW
   → RESOLVED / IGNORED; some can be corrected right here. Nothing is
   ever deleted, and every step is kept in the issue's history.

   The checks and the rules live server-side (data_quality.ts).
   ============================================================ */

import { esc, toast, friendlyError, skeleton, errorState } from "./util.js";
import { openContentPanel } from "./viewer.js";
import { dqIssue, dqSetStatus, dqFix } from "./store.js";

export const STATUS_LABEL = { OPEN: "Open", UNDER_REVIEW: "Under review", RESOLVED: "Resolved", IGNORED: "Ignored" };
export const SEVERITY_LABEL = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");

export const severityPill = (s) => `<span class="pill dq-sev dq-${esc(String(s).toLowerCase())}">${esc(SEVERITY_LABEL[s] || s)}</span>`;
export function statusPill(s) {
  const cls = s === "RESOLVED" ? "ok" : s === "IGNORED" ? "" : s === "UNDER_REVIEW" ? "warm" : "danger";
  return `<span class="pill ${cls}">${esc(STATUS_LABEL[s] || s)}</span>`;
}

/** A small line chart of the score over the last scans. */
function sparkline(history) {
  const pts = (history || []).filter((h) => h.score != null);
  if (pts.length < 2) return "";
  const w = 160, h = 36;
  const min = Math.min(...pts.map((p) => p.score), 50), max = 100;
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * w, h - ((p.score - min) / (max - min || 1)) * h]);
  return `<svg class="dq-spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Score over the last ${pts.length} scans">
    <polyline fill="none" stroke="var(--brand)" stroke-width="2" points="${xy.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}"/></svg>`;
}

/** Score, counts, and the last scan. */
export function dqTopHtml(s) {
  const t = s.totals;
  const score = s.score;
  const tone = !score ? "" : score.value >= 90 ? "ok" : score.value >= 75 ? "warm" : "danger";
  return `
    <div class="dq-top">
      <div class="dq-score ${tone}">
        <b>${score ? `${score.value}` : "—"}</b>
        <span>Data quality score${score ? ` · ${esc(score.label)}` : ""}</span>
        ${sparkline(s.history)}
      </div>
      <div class="stat-row dq-tiles">
        <div class="stat-tile"><div class="s-label">Open</div><div class="s-num">${t.byStatus.OPEN}</div><div class="s-sub">waiting for someone</div></div>
        <div class="stat-tile"><div class="s-label">Under review</div><div class="s-num">${t.byStatus.UNDER_REVIEW}</div><div class="s-sub">being looked at</div></div>
        <div class="stat-tile"><div class="s-label">Resolved</div><div class="s-num">${t.byStatus.RESOLVED}</div><div class="s-sub">fixed here or at the source</div></div>
        <div class="stat-tile"><div class="s-label">Ignored</div><div class="s-num">${t.byStatus.IGNORED}</div><div class="s-sub">accepted as they are</div></div>
        <div class="stat-tile"><div class="s-label">Affected records</div><div class="s-num">${t.affectedRecords}</div><div class="s-sub">in open issues</div></div>
        <div class="stat-tile"><div class="s-label">Open by severity</div><div class="s-num dq-sevnums">
          <span class="dq-high">${t.bySeverity.HIGH}</span> · <span class="dq-medium">${t.bySeverity.MEDIUM}</span> · <span class="dq-low">${t.bySeverity.LOW}</span></div>
          <div class="s-sub">high · medium · low</div></div>
      </div>
    </div>
    <p class="field-hint">The score is each check's pass rate (records with no open issue), weighted by how serious the check is — for the county / school picked, as of the last scan. Ignored and resolved issues don't count against it.</p>`;
}

/** One row per check. Clicking a row filters the list to it. */
export function dqTypesHtml(s) {
  return `<div class="lms-table-wrap"><table class="lms-table intel-table dq-types">
    <thead><tr><th class="lms-name">Check</th><th class="lms-name">Severity</th><th>Records checked</th><th>Pass rate</th><th>Open</th><th>Under review</th><th>Resolved</th><th>Ignored</th></tr></thead>
    <tbody>${s.byType.map((r) => `
      <tr data-dq-type="${esc(r.type)}" class="${r.OPEN + r.UNDER_REVIEW ? "dq-has-open" : ""}">
        <td class="lms-name"><button type="button" class="intel-link">${esc(r.label)}</button></td>
        <td class="lms-name">${severityPill(r.severity)}</td>
        <td>${r.checked}</td><td class="lms-strong">${r.passRate == null ? "—" : `${r.passRate}%`}</td>
        <td>${r.OPEN}</td><td>${r.UNDER_REVIEW}</td><td>${r.RESOLVED}</td><td>${r.IGNORED}</td>
      </tr>`).join("")}</tbody>
  </table></div>`;
}

/** The issue list (with a checkbox each, for bulk changes). */
export function dqListHtml(issues, selected, canManage) {
  if (!issues.length) return `<div class="empty-state">No issues match. ✓</div>`;
  return issues.map((i) => `
    <div class="dq-row" data-dq-issue="${esc(i.id)}">
      ${canManage ? `<input type="checkbox" data-dq-select="${esc(i.id)}" ${selected.has(i.id) ? "checked" : ""} aria-label="Select">` : ""}
      <div class="dq-row-main">
        <div class="dq-row-head">${severityPill(i.severity)} <b>${esc(i.typeLabel)}</b> ${statusPill(i.status)}${i.reopenedCount ? ` <span class="pill warm">Reopened ×${i.reopenedCount}</span>` : ""}</div>
        <div>${esc(i.summary)}</div>
        <div class="hint-inline">${esc(i.entity.label)}${i.related.length ? ` + ${i.related.length} more` : ""} · ${esc(i.school || "no school")}${i.county ? `, ${esc(i.county)}` : ""} · first found ${esc(fmtDay(i.firstDetectedAt))}${
          i.status === "RESOLVED" ? ` · resolved ${esc(fmtDay(i.resolvedAt))} by ${esc(i.resolvedBy || "—")}` : ""}</div>
      </div>
      <button type="button" class="btn btn-outline q-small" data-dq-open>Open</button>
    </div>`).join("");
}

const ACTION_LABEL = {
  detected: "Found by a scan", reopened: "Reopened", auto_resolved: "Resolved — no longer found",
  status_changed: "Status changed", corrected: "Corrected",
};

/** One issue: what, where, history, and what can be done. */
export async function openDqIssue(id, { onChange = () => {} } = {}) {
  const panel = openContentPanel({ title: "Data quality issue", html: skeleton(5) });
  let d;
  async function load() {
    try { d = await dqIssue(id); } catch (err) {
      panel.innerHTML = errorState(friendlyError(err), load);
      return;
    }
    render();
  }
  function render() {
    const i = d.issue;
    const records = [i.entity, ...i.related];
    const detailRows = Object.entries(d.details || {}).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length));
    panel.innerHTML = `
      <p>${severityPill(i.severity)} <b>${esc(i.typeLabel)}</b> ${statusPill(i.status)}</p>
      <h3 style="margin:.3rem 0 .5rem">${esc(i.summary)}</h3>
      <dl class="dq-facts">
        <dt>Where</dt><dd>${esc(i.school || "No school")}${i.county ? `, ${esc(i.county)}` : ""}</dd>
        <dt>First found</dt><dd>${esc(fmt(i.firstDetectedAt))}</dd>
        <dt>Still there</dt><dd>${i.stillPresent ? "Yes, at the last scan" : "No — the last scan didn't find it"}</dd>
        ${i.status === "RESOLVED" ? `<dt>Resolved</dt><dd>${esc(fmt(i.resolvedAt))} by ${esc(i.resolvedBy || "—")}${i.resolution ? ` — ${esc(i.resolution)}` : ""}</dd>` : ""}
        ${i.statusChangedAt ? `<dt>Last status change</dt><dd>${esc(fmt(i.statusChangedAt))}${i.statusChangedBy ? ` by ${esc(i.statusChangedBy)}` : ""}</dd>` : ""}
        ${i.note ? `<dt>Note</dt><dd>${esc(i.note)}</dd>` : ""}
      </dl>
      <h3 style="margin:1rem 0 .3rem">Affected record${records.length === 1 ? "" : "s"}</h3>
      <ul class="dq-records">${records.map((r) => `<li><span class="code-chip">${esc(r.type.replace("_", " "))}</span> ${esc(r.label)}</li>`).join("")}</ul>
      ${detailRows.length ? `<details class="kp-section"><summary>Details</summary><dl class="dq-facts">${detailRows.map(([k, v]) =>
        `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v))}</dd>`).join("")}</dl></details>` : ""}
      ${d.fixes.length ? `
        <h3 style="margin:1rem 0 .3rem">Correct it</h3>
        <p class="field-hint" style="margin-top:0">Changes the record through the portal's normal edit, records exactly what changed, and resolves the issue. Nothing is deleted.</p>
        ${d.fixes.map((f, n) => `
          <form class="dq-fix" data-fix="${n}">
            <b>${esc(f.label)}</b><span class="hint-inline">${esc(f.description)}</span>
            ${f.params.map((p) => `<label class="field" style="margin:.4rem 0 0"><span>${esc(p.label)}</span>
              <select name="${esc(p.name)}" required><option value="">Choose…</option>${p.options.map((o) =>
                `<option value="${esc(o.value)}"${o.value === p.value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>`).join("")}
            <input type="text" name="note" maxlength="1000" placeholder="Note — what you checked${f.action.startsWith("kobo_") ? " (required)" : " (optional)"}" ${f.action.startsWith("kobo_") ? "required" : ""}>
            <button class="btn btn-primary q-small" type="submit">Apply</button>
          </form>`).join("")}` : ""}
      ${d.moves.length ? `
        <h3 style="margin:1rem 0 .3rem">Status</h3>
        <form class="dq-move" data-move>
          <input type="text" name="note" maxlength="1000" placeholder="Reason — required to resolve or ignore">
          <div class="lms-actions">${d.moves.map((m) => `<button type="submit" class="btn ${m === "IGNORED" ? "btn-ghost" : "btn-outline"} q-small" value="${m}">${
            m === "OPEN" ? "Reopen" : m === "UNDER_REVIEW" ? "Mark under review" : m === "RESOLVED" ? "Mark resolved" : "Ignore"}</button>`).join("")}</div>
          ${d.moves.includes("RESOLVED") && i.stillPresent ? `<p class="field-hint">If the next scan still finds it, it reopens — correct the record, or ignore it if it's right as it is.</p>` : ""}
        </form>` : ""}
      <h3 style="margin:1rem 0 .3rem">History</h3>
      <ol class="dq-history">${d.events.map((e) => `
        <li><b>${esc(ACTION_LABEL[e.action] || e.action)}</b>${e.from || e.to ? ` <span class="hint-inline">${esc(STATUS_LABEL[e.from] || e.from || "")}${e.from && e.to ? " → " : ""}${esc(STATUS_LABEL[e.to] || e.to || "")}</span>` : ""}
          <div class="hint-inline">${esc(fmt(e.at))} · ${esc(e.by)}</div>
          ${e.note ? `<div>${esc(e.note)}</div>` : ""}
          ${e.action === "corrected" && e.details?.before ? `<div class="dq-change"><span>Before: ${esc(JSON.stringify(e.details.before))}</span><span>After: ${esc(JSON.stringify(e.details.after))}</span></div>` : ""}
        </li>`).join("")}</ol>`;
  }

  panel.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const note = form.querySelector('[name="note"]')?.value.trim() || "";
    const buttons = form.querySelectorAll("button");
    try {
      buttons.forEach((b) => { b.disabled = true; });
      if (form.matches("[data-move]")) {
        const to = e.submitter?.value;
        d = await dqSetStatus(id, to, note);
        toast(`Marked ${(STATUS_LABEL[to] || to).toLowerCase()}`, "", "success");
      } else if (form.matches("[data-fix]")) {
        const fix = d.fixes[Number(form.dataset.fix)];
        const body = { action: fix.action, note };
        for (const p of fix.params) body[p.name] = form.querySelector(`[name="${p.name}"]`).value;
        d = await dqFix(id, body);
        toast("Corrected", d.issue.status === "RESOLVED" ? "The record was changed and the issue resolved." : "The record was changed, but the check still finds a problem.", d.issue.status === "RESOLVED" ? "success" : "error");
      }
      render();
      onChange();
    } catch (err) {
      buttons.forEach((b) => { b.disabled = false; });
      toast("Couldn't do that", friendlyError(err), "error");
    }
  });
  load();
}
