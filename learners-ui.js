/* ============================================================
   HPF Digital Learning Portal — learner enrollment, shared screens.

   Used by the teacher, school head and Education Team dashboards:
   status labels, the "archive a learner" dialog (learners are never
   deleted — they leave with a status, a date and a reason), the
   enrollment-history panel, and the transfer dialog. The API decides
   who may do each of these; these are only the screens.
   ============================================================ */

import { esc, friendlyError, toast } from "./util.js";
import { openContentPanel, closeViewer } from "./viewer.js";
import { getLearnerHistory, setLearnerStatus, transferLearner, getClasses } from "./store.js";

export const STATUS_LABEL = {
  ACTIVE: "Active",
  TRANSFERRED: "Transferred",
  DROPPED_OUT: "Dropped out",
  COMPLETED: "Completed",
  INACTIVE: "Inactive",
};

/** A pill for any status other than ACTIVE (active is the normal case). */
export function statusPill(status) {
  if (!status || status === "ACTIVE") return "";
  const cls = status === "COMPLETED" ? "ok" : status === "TRANSFERRED" ? "warm" : "danger";
  return `<span class="pill ${cls}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

/* Archive: why and when the learner left. Resolves to the updated learner,
   or null if cancelled. */
export function openArchiveDialog(learner) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const panel = openContentPanel({
      title: `Archive ${learner.fullName}`,
      html: `
        <form class="fill-form" data-archive style="max-width:30rem">
          <p class="field-hint" style="margin-top:0">They leave the active roster and can no longer sign in. Their record, history and work are kept, and they can be reactivated later.</p>
          <div class="field"><label for="ar_status">Why are they leaving?</label>
            <select id="ar_status">
              <option value="TRANSFERRED">Moved to a school outside the portal</option>
              <option value="DROPPED_OUT">Dropped out</option>
              <option value="COMPLETED">Completed school</option>
              <option value="INACTIVE" selected>Inactive (other reason)</option>
            </select></div>
          <div class="field"><label for="ar_date">Date</label><input id="ar_date" type="date" value="${todayIso()}" max="${todayIso()}"></div>
          <div class="field"><label for="ar_reason">Reason <span class="hint-inline">— optional</span></label><input id="ar_reason" type="text" maxlength="300" placeholder="e.g. Family moved to Nairobi"></div>
          <div class="field-error" data-error hidden></div>
          <div style="display:flex;gap:.6rem">
            <button class="btn btn-primary" type="submit">Archive learner</button>
            <button class="btn btn-ghost" type="button" data-cancel>Cancel</button>
          </div>
        </form>`,
    }, () => finish(null));
    panel.querySelector("[data-cancel]").addEventListener("click", () => { closeViewer(); finish(null); });
    panel.querySelector("[data-archive]").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("[type=submit]");
      const err = panel.querySelector("[data-error]");
      btn.disabled = true;
      try {
        const updated = await setLearnerStatus(learner.id, panel.querySelector("#ar_status").value, {
          reason: panel.querySelector("#ar_reason").value.trim(),
          exitDate: panel.querySelector("#ar_date").value,
        });
        toast("Learner archived", `${learner.fullName} is no longer on the active roster.`, "success");
        finish(updated);
        closeViewer();
      } catch (e2) {
        btn.disabled = false;
        err.textContent = friendlyError(e2, "Couldn't archive the learner.");
        err.hidden = false;
      }
    });
  });
}

/* Every school and class this learner has been in, newest first. */
export async function openHistoryPanel(learnerId, name) {
  const panel = openContentPanel({ title: `${name || "Learner"} — enrollment history`, html: `<div class="empty-state">Loading…</div>` });
  try {
    const { learner, enrollments } = await getLearnerHistory(learnerId);
    panel.innerHTML = `
      <p class="hint" style="margin-top:0">Learner code <b>${esc(learner.learnerCode || "—")}</b> stays the same for life, whichever school they're in.</p>
      ${enrollments.length ? enrollments.map((e) => `
        <div class="task-row">
          <div style="flex:1;min-width:0">
            <b>${esc(e.school || e.schoolId)}${e.className ? ` · ${esc(e.className)}` : ""}</b>
            <span>${esc(e.grade || "")}${e.grade ? " · " : ""}${esc(e.academicYear)}${e.term ? ` ${esc(e.term.replace(/^\d{4}-/, ""))}` : ""}
              · from ${esc(fmtDate(e.enrollmentDate))}${e.exitDate ? ` to ${esc(fmtDate(e.exitDate))}` : ""}${e.teacherName ? ` · ${esc(e.teacherName)}` : ""}
              ${e.exitReason ? `<br>${esc(e.exitReason)}` : ""}</span>
          </div>
          ${e.status === "ACTIVE" ? `<span class="pill ok">Current</span>` : statusPill(e.status)}
        </div>`).join("") : `<div class="empty-state">No enrollment records yet.</div>`}`;
  } catch (err) {
    panel.innerHTML = `<div class="field-error">${esc(friendlyError(err, "Couldn't load the history."))}</div>`;
  }
}

/* Move a learner to another school (administrators and M&E). `schools` is
   the school directory [{ id, name, code, county }]. */
export function openTransferDialog(learner, schools) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const options = schools.filter((s) => s.id !== learner.schoolId)
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.code)}) · ${esc(s.county)}</option>`).join("");
    const panel = openContentPanel({
      title: `Transfer ${learner.fullName}`,
      html: `
        <form class="fill-form" data-transfer style="max-width:32rem">
          <p class="field-hint" style="margin-top:0">Now at <b>${esc(learner.school || "")}</b>${learner.className ? ` · ${esc(learner.className)}` : ""}. Their record there is closed as Transferred and kept; they get a new school code, keep learner code <b>${esc(learner.learnerCode || "")}</b>, and keep their sign-in, work and history.</p>
          <div class="field"><label for="tr_school">Moving to</label><select id="tr_school" required><option value="">Choose a school</option>${options}</select></div>
          <div class="field"><label for="tr_class">Class <span class="hint-inline">— optional</span></label><select id="tr_class" disabled><option value="">Choose the school first</option></select></div>
          <div class="field"><label for="tr_date">Date</label><input id="tr_date" type="date" value="${todayIso()}" max="${todayIso()}"></div>
          <div class="field"><label for="tr_reason">Reason <span class="hint-inline">— optional</span></label><input id="tr_reason" type="text" maxlength="300" placeholder="e.g. Family moved"></div>
          <div class="field-error" data-error hidden></div>
          <div style="display:flex;gap:.6rem">
            <button class="btn btn-primary" type="submit">Transfer learner</button>
            <button class="btn btn-ghost" type="button" data-cancel>Cancel</button>
          </div>
        </form>`,
    }, () => finish(null));
    const schoolSel = panel.querySelector("#tr_school");
    const classSel = panel.querySelector("#tr_class");
    schoolSel.addEventListener("change", async () => {
      classSel.disabled = true;
      classSel.innerHTML = `<option value="">Loading…</option>`;
      if (!schoolSel.value) { classSel.innerHTML = `<option value="">Choose the school first</option>`; return; }
      try {
        const { classes } = await getClasses({ schoolId: schoolSel.value });
        classSel.innerHTML = `<option value="">Not in a class yet</option>${classes.map((c) =>
          `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.grade)})</option>`).join("")}`;
        classSel.disabled = false;
      } catch {
        classSel.innerHTML = `<option value="">Not in a class yet</option>`;
        classSel.disabled = false;
      }
    });
    panel.querySelector("[data-cancel]").addEventListener("click", () => { closeViewer(); finish(null); });
    panel.querySelector("[data-transfer]").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("[type=submit]");
      const err = panel.querySelector("[data-error]");
      btn.disabled = true;
      try {
        const updated = await transferLearner(learner.id, {
          toSchoolId: schoolSel.value, toClassId: classSel.value || undefined,
          reason: panel.querySelector("#tr_reason").value.trim(), effectiveDate: panel.querySelector("#tr_date").value,
        });
        toast("Learner transferred", `${learner.fullName} is now at ${updated.school}.`, "success");
        finish(updated);
        closeViewer();
      } catch (e2) {
        btn.disabled = false;
        err.textContent = friendlyError(e2, "Couldn't transfer the learner.");
        err.hidden = false;
      }
    });
  });
}
