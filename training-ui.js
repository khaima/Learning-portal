/* ============================================================
   HPF Digital Learning Portal — the training register.

   Teacher development sessions (workshops, cluster meetings, coaching,
   online courses) and the teachers who attended, for the Teacher
   development dashboard. Nothing is deleted: a session is archived, and
   taking a teacher off the list keeps them on record as not attended.
   ============================================================ */

import { esc, toast, friendlyError, skeleton, errorState, confirmDialog } from "./util.js";
import { openContentPanel, closeViewer } from "./viewer.js";
import { getTraining, createTraining, updateTraining, trainingTeachers } from "./store.js";

const KINDS = [
  ["workshop", "Workshop"], ["cluster", "Cluster meeting"], ["coaching", "Coaching"], ["online", "Online course"], ["other", "Other"],
];
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

/**
 * Opens a session (id), or a blank one to record (id = null).
 * ctx: { canManage, schools: [{ id, name, code, county }], counties: [name], onChange }
 */
export async function openTrainingPanel(id, ctx) {
  const panel = openContentPanel({ title: id ? "Training session" : "Record a training session", html: skeleton(5) });
  let t = null, teachers = [];
  try {
    [t, teachers] = await Promise.all([
      id ? getTraining(id) : null,
      ctx.canManage ? trainingTeachers() : [],
    ]);
  } catch (err) {
    panel.innerHTML = errorState(friendlyError(err), () => openTrainingPanel(id, ctx));
    return;
  }
  if (!ctx.canManage) { panel.innerHTML = readOnlyHtml(t); return; }

  const was = new Set((t?.attendance || []).filter((a) => a.attended).map((a) => a.teacherId));
  const chosen = new Set(was);
  // Former accounts still on the list stay pickable (so they can be taken off).
  const known = new Map(teachers.map((x) => [x.id, x]));
  for (const a of t?.attendance || []) if (!known.has(a.teacherId)) known.set(a.teacherId, { id: a.teacherId, name: a.name, school: a.school, county: a.county });
  const people = [...known.values()];

  panel.innerHTML = `
    <form class="fill-form" data-f>
      <div class="field"><label for="tr_title">Title</label><input id="tr_title" name="title" maxlength="200" required value="${esc(t?.title || "")}" placeholder="ICT integration workshop"></div>
      <div class="lms-grid3">
        <div class="field"><label for="tr_kind">Kind</label><select id="tr_kind" name="kind">${KINDS.map(([v, l]) => `<option value="${v}"${(t?.kind || "workshop") === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label for="tr_held">Held on</label><input id="tr_held" name="heldOn" type="date" required value="${esc(t?.heldOn || "")}"></div>
        <div class="field"><label for="tr_ends">Last day <span class="hint-inline">— if longer</span></label><input id="tr_ends" name="endsOn" type="date" value="${esc(t?.endsOn || "")}"></div>
      </div>
      <div class="lms-grid3" style="grid-template-columns:1fr 1fr">
        <div class="field"><label for="tr_county">County</label><select id="tr_county" name="county"><option value="">Not one place (e.g. online)</option>${ctx.counties.map((c) => `<option${(t?.county || "") === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
        <div class="field"><label for="tr_school">School</label><select id="tr_school" name="schoolId"></select></div>
      </div>
      <div class="lms-grid3" style="grid-template-columns:1fr 1fr">
        <div class="field"><label for="tr_fac">Facilitator</label><input id="tr_fac" name="facilitator" maxlength="200" value="${esc(t?.facilitator || "")}"></div>
        <div class="field"><label for="tr_topic">Topic</label><input id="tr_topic" name="topic" maxlength="300" value="${esc(t?.topic || "")}" placeholder="Using tablets in literacy lessons"></div>
      </div>
      <div class="field"><label for="tr_notes">Notes</label><textarea id="tr_notes" name="notes" rows="2" maxlength="4000">${esc(t?.notes || "")}</textarea></div>
      <fieldset class="mel-source"><legend>Who attended <span class="hint-inline" data-count></span></legend>
        <div class="lms-actions" style="margin-bottom:.5rem">
          <input type="search" data-q placeholder="Search teachers, schools…" style="flex:1 1 12rem">
          <label class="q-choice" style="margin:0"><input type="checkbox" data-all-places> All counties</label>
          <button type="button" class="btn btn-ghost q-small" data-select-shown>Tick all shown</button>
        </div>
        <div class="training-people" data-people></div>
        <p class="field-hint">Taking someone off the list keeps them on record as not attended.</p>
      </fieldset>
      <div class="lms-actions">
        <button class="btn btn-primary" type="submit">${t ? "Save" : "Record session"}</button>
        ${t ? `<button type="button" class="btn btn-ghost" data-archive>${t.archived ? "Restore" : "Archive"}</button>` : ""}
      </div>
    </form>`;

  const form = panel.querySelector("[data-f]");
  const val = (n) => form.querySelector(`[name="${n}"]`).value.trim();
  function renderSchools() {
    const county = val("county");
    const keep = form.querySelector('[name="schoolId"]').value || t?.schoolId || "";
    const list = ctx.schools.filter((s) => !county || s.county === county);
    form.querySelector('[name="schoolId"]').innerHTML = `<option value="">${county ? "The whole county" : "—"}</option>` +
      list.map((s) => `<option value="${esc(s.id)}"${s.id === keep ? " selected" : ""}>${esc(s.name)} (${esc(s.code)})</option>`).join("");
    form.querySelector('[name="schoolId"]').disabled = !county;
  }
  function shown() {
    const q = form.querySelector("[data-q]").value.trim().toLowerCase();
    const county = val("county");
    const everywhere = form.querySelector("[data-all-places]").checked || !county;
    return people.filter((p) => chosen.has(p.id) || ((everywhere || p.county === county) &&
      (!q || `${p.name} ${p.school} ${p.county}`.toLowerCase().includes(q))))
      .sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)) || String(a.name).localeCompare(String(b.name)));
  }
  function renderPeople() {
    const list = shown();
    form.querySelector("[data-people]").innerHTML = list.length ? list.map((p) => `
      <label class="q-choice training-person"><input type="checkbox" value="${esc(p.id)}"${chosen.has(p.id) ? " checked" : ""}>
        <span>${esc(p.name)} <small class="hint-inline">${esc(p.school || "No school")}${p.county ? ` · ${esc(p.county)}` : ""}</small></span></label>`).join("")
      : `<p class="field-hint">No teachers match.</p>`;
    form.querySelector("[data-count]").textContent = `— ${chosen.size} ticked`;
  }
  renderSchools();
  renderPeople();
  form.querySelector('[name="county"]').addEventListener("change", () => { renderSchools(); renderPeople(); });
  form.querySelector("[data-q]").addEventListener("input", renderPeople);
  form.querySelector("[data-all-places]").addEventListener("change", renderPeople);
  form.querySelector("[data-people]").addEventListener("change", (e) => {
    const box = e.target.closest("input[type=checkbox]");
    if (!box) return;
    if (box.checked) chosen.add(box.value); else chosen.delete(box.value);
    form.querySelector("[data-count]").textContent = `— ${chosen.size} ticked`;
  });
  form.querySelector("[data-select-shown]").addEventListener("click", () => { for (const p of shown()) chosen.add(p.id); renderPeople(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      title: val("title"), kind: val("kind"), heldOn: val("heldOn"), endsOn: val("endsOn") || null,
      county: val("county") || null, schoolId: val("schoolId") || null,
      facilitator: val("facilitator"), topic: val("topic"), notes: val("notes"),
    };
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      if (t) {
        const attendance = [
          ...[...chosen].filter((x) => !was.has(x)).map((teacherId) => ({ teacherId, attended: true })),
          ...[...was].filter((x) => !chosen.has(x)).map((teacherId) => ({ teacherId, attended: false })),
        ];
        await updateTraining(t.id, { ...body, attendance });
        toast("Saved", "", "success");
      } else {
        await createTraining({ ...body, teacherIds: [...chosen] });
        toast("Session recorded", `${chosen.size} teacher${chosen.size === 1 ? "" : "s"} on the list.`, "success");
      }
      closeViewer();
      ctx.onChange?.();
    } catch (err) {
      toast("Couldn't save it", friendlyError(err), "error");
      btn.disabled = false;
    }
  });
  form.querySelector("[data-archive]")?.addEventListener("click", async () => {
    if (!t.archived && !(await confirmDialog({ title: "Archive this session?", body: "It's kept, with its attendance, but no longer counted on the dashboards. You can restore it.", confirmLabel: "Archive" }))) return;
    try {
      await updateTraining(t.id, { archived: !t.archived });
      toast(t.archived ? "Restored" : "Archived", "", "success");
      closeViewer();
      ctx.onChange?.();
    } catch (err) {
      toast("Couldn't do that", friendlyError(err), "error");
    }
  });
}

function readOnlyHtml(t) {
  const there = t.attendance.filter((a) => a.attended);
  const off = t.attendance.filter((a) => !a.attended);
  return `
    <h3 style="margin:.2rem 0">${esc(t.title)}</h3>
    <p class="hint">${esc((KINDS.find(([v]) => v === t.kind) || [, t.kind])[1])} · ${esc(fmtDay(t.heldOn))}${t.endsOn && t.endsOn !== t.heldOn ? ` – ${esc(fmtDay(t.endsOn))}` : ""}
      · ${esc(t.school || (t.county ? `${t.county} County` : "No one place"))}${t.archived ? ` · <span class="pill">Archived</span>` : ""}</p>
    ${t.facilitator ? `<p><b>Facilitator:</b> ${esc(t.facilitator)}</p>` : ""}
    ${t.topic ? `<p><b>Topic:</b> ${esc(t.topic)}</p>` : ""}
    ${t.notes ? `<p>${esc(t.notes)}</p>` : ""}
    <h4>Attended (${there.length})</h4>
    ${there.length ? `<ul class="mel-evidence">${there.map((a) => `<li>${esc(a.name)} <span class="hint-inline">${esc(a.school || "")}</span></li>`).join("")}</ul>` : `<p class="field-hint">Nobody on the list yet.</p>`}
    ${off.length ? `<p class="field-hint">Taken off the list: ${off.map((a) => esc(a.name)).join(", ")}</p>` : ""}`;
}
