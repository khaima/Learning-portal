/* ============================================================
   HPF Digital Learning Portal — who teaches which class.

   For a school head (My school): each teacher with the classes they
   teach, and each class with its teachers. A class has one class teacher
   and any number of subject teachers; a teacher can teach one class or
   several. Add classes to a teacher (or teachers to a class) several at
   a time, change a role, or take one away. Taking one away ends the
   assignment — it's kept, with who and when, and in the audit log; the
   work they set stays with the class.
   ============================================================ */

import { esc, toast, friendlyError, confirmDialog } from "./util.js";
import { assignClassTeacher, removeClassTeacher } from "./store.js";
import { openContentPanel, closeViewer } from "./viewer.js";

const ROLE = { class_teacher: "Class teacher", subject_teacher: "Subject teacher" };
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });

/** A teacher's classes: [{ cls, role }]. */
const classesOf = (teacherId, classes) => classes.flatMap((cls) => cls.teachers.filter((t) => t.teacherId === teacherId).map((t) => ({ cls, role: t.role })));
const classTeacherOf = (cls) => cls.teachers.find((t) => t.role === "class_teacher") || null;

/** The Teachers page list: each teacher, their classes as chips (one tap to take one away), and
    the classes still without a class teacher. */
export function teachersClassesHtml(teachers, classes) {
  if (!teachers.length) return `<div class="empty-state"><b>No teachers in the school yet.</b><div>Teachers appear here once their accounts are approved for this school.</div></div>`;
  const noCT = classes.filter((c) => !classTeacherOf(c));
  const free = teachers.filter((t) => !classesOf(t.id, classes).length);
  return `${noCT.length || free.length ? `<div class="tc-gaps">
      ${noCT.length ? `<p><span class="pill warm">${plural(noCT.length, "class", "classes")} without a class teacher</span> ${noCT.map((c) => `<button type="button" class="link-btn" data-class-teachers="${esc(c.id)}">${esc(c.name)}</button>`).join(" · ")}</p>` : ""}
      ${free.length ? `<p><span class="pill">${plural(free.length, "teacher")} with no class yet</span> ${esc(free.map((t) => t.fullName).join(", "))}</p>` : ""}
    </div>` : ""}
    <div class="fo-list">${[...teachers].sort((a, b) => String(a.fullName).localeCompare(String(b.fullName))).map((t) => {
      const mine = classesOf(t.id, classes).sort((a, b) => byName(a.cls, b.cls));
      return `<div class="fo-row">
        <div class="fo-who"><b>${esc(t.fullName)}</b><span>${mine.length ? `${plural(mine.length, "class", "classes")}${mine.some((m) => m.role === "class_teacher")
          ? ` · class teacher of ${esc(mine.filter((m) => m.role === "class_teacher").map((m) => m.cls.name).join(", "))}` : ""}` : "No classes yet"}</span></div>
        <div class="fo-chips">${mine.map((m) => `<span class="fo-chip${m.role === "class_teacher" ? " is-lead" : ""}">${esc(m.cls.name)}<small>${m.role === "class_teacher" ? "Class teacher" : "Subject"}</small>
          <button type="button" class="fo-x" data-take-off="${esc(t.id)}" data-class="${esc(m.cls.id)}" aria-label="${esc(`Take ${t.fullName} off ${m.cls.name}`)}">✕</button></span>`).join("")}</div>
        <div class="fo-act"><button type="button" class="btn btn-outline q-small" data-teacher-classes="${esc(t.id)}">${mine.length ? "Change classes" : "Give classes"}</button></div>
      </div>`;
    }).join("")}</div>`;
}

/** A class's teachers in one line (the class list). */
export function classTeachersLine(cls) {
  const ct = classTeacherOf(cls);
  const st = cls.teachers.filter((t) => t.role === "subject_teacher");
  return `<span class="hint-inline">Class teacher</span> <b>${ct ? esc(ct.name || "—") : '<span class="warn-text">None yet</span>'}</b>${
    st.length ? ` · <span class="hint-inline">Subject</span> ${esc(st.map((t) => t.name).join(", "))}` : ""}`;
}

/** Applies a list of changes one by one: [{ classId, teacherId, role }] (role null = take off). */
async function apply(changes) {
  let done = 0;
  const failed = [];
  // Roles first, then taking off: a new class teacher is in place before anyone leaves.
  for (const ch of [...changes].sort((a, b) => Number(!a.role) - Number(!b.role))) {
    try {
      if (ch.role) await assignClassTeacher(ch.classId, ch.teacherId, ch.role);
      else await removeClassTeacher(ch.classId, ch.teacherId);
      done++;
    } catch (err) {
      failed.push(`${ch.label}: ${friendlyError(err)}`);
    }
  }
  if (failed.length) toast(`${failed.length} change${failed.length === 1 ? "" : "s"} not saved`, failed.join(" · "), "error");
  else if (done) toast("Saved", `${plural(done, "change")} to who teaches what.`, "success");
  return done;
}

/** Takes one teacher off one class, after a yes. */
export async function takeOff(teacher, cls, onDone) {
  const ok = await confirmDialog({
    title: `Take ${teacher.fullName} off ${cls.name}?`,
    body: "The class stays, with its learners and the work set. You can give it back any time.",
    confirmLabel: "Take off", danger: true,
  });
  if (!ok) return;
  if (await apply([{ classId: cls.id, teacherId: teacher.id, role: null, label: cls.name }])) onDone();
}

/** One teacher: tick their classes — one or several — and say for each whether they're its class teacher. */
export function openTeacherClasses(teacher, { classes, onDone }) {
  const panel = openContentPanel({ title: `Classes for ${teacher.fullName}`, html: "" });
  const now = new Map(classesOf(teacher.id, classes).map((m) => [m.cls.id, m.role]));
  const grades = [...new Set(classes.map((c) => c.grade))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  panel.innerHTML = classes.length ? `
    <p class="hint" style="margin-top:0">Tick one class or several. A class has one class teacher; giving it a new one takes the role from whoever had it.</p>
    <form data-pick>${grades.map((g) => `<fieldset class="fo-county"><legend><b>${esc(g)}</b></legend>${classes.filter((c) => c.grade === g).sort(byName).map((c) => {
      const role = now.get(c.id) || "";
      const ct = classTeacherOf(c);
      const other = ct && ct.teacherId !== teacher.id ? ct.name : "";
      return `<div class="tc-pick" data-class="${esc(c.id)}">
        <label class="fo-pick"><input type="checkbox" data-on${role ? " checked" : ""}><span>${esc(c.name)}<small>${plural(c.learnerCount, "learner")}${other ? ` · class teacher: ${esc(other)}` : ct ? "" : " · no class teacher"}</small></span></label>
        <select data-role aria-label="${esc(`Role in ${c.name}`)}"${role ? "" : " hidden"}>
          <option value="subject_teacher"${role !== "class_teacher" ? " selected" : ""}>Subject teacher</option>
          <option value="class_teacher"${role === "class_teacher" ? " selected" : ""}>Class teacher${other ? ` (instead of ${esc(other)})` : ""}</option>
        </select>
      </div>`;
    }).join("")}</fieldset>`).join("")}
      <div class="lms-actions fo-save"><span class="hint-inline" data-count></span><button type="submit" class="btn btn-primary">Save</button><button type="button" class="btn btn-ghost" data-cancel>Cancel</button></div>
    </form>` : `<div class="empty-state">No classes this year yet — add them on Learners &amp; classes.</div>`;
  const form = panel.querySelector("[data-pick]");
  if (!form) return;
  const count = () => { panel.querySelector("[data-count]").textContent = plural(form.querySelectorAll("[data-on]:checked").length, "class", "classes"); };
  count();
  form.addEventListener("change", (e) => {
    if (!e.target.matches("[data-on]")) return;
    e.target.closest(".tc-pick").querySelector("[data-role]").hidden = !e.target.checked;
    count();
  });
  panel.querySelector("[data-cancel]").addEventListener("click", () => closeViewer());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const changes = [];
    for (const row of form.querySelectorAll(".tc-pick")) {
      const c = classes.find((x) => x.id === row.dataset.class);
      const on = row.querySelector("[data-on]").checked;
      const role = on ? row.querySelector("[data-role]").value : null;
      if ((now.get(c.id) || null) !== role) changes.push({ classId: c.id, teacherId: teacher.id, role, label: c.name });
    }
    if (!changes.length) { closeViewer(); return; }
    const off = changes.filter((ch) => !ch.role);
    if (off.length && !(await confirmDialog({ title: `Take ${teacher.fullName} off ${plural(off.length, "class", "classes")}?`,
      body: `${off.map((ch) => ch.label).join(", ")}. The classes keep their learners and work.`, confirmLabel: "Save" }))) return;
    form.querySelector("[type=submit]").disabled = true;
    await apply(changes);
    closeViewer();
    onDone();
  });
}

/** One class: its class teacher, and its subject teachers — one or several. */
export function openClassTeachers(cls, { teachers, onDone }) {
  const panel = openContentPanel({ title: `Teachers of ${cls.name}`, html: "" });
  const ct = classTeacherOf(cls);
  const subj = new Set(cls.teachers.filter((t) => t.role === "subject_teacher").map((t) => t.teacherId));
  const list = [...teachers].sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  panel.innerHTML = list.length ? `
    <p class="hint" style="margin-top:0">${esc(cls.grade)} · ${plural(cls.learnerCount, "learner")}</p>
    <form data-pick>
      <div class="field"><label for="ct_lead">Class teacher</label>
        <select id="ct_lead"><option value="">None</option>${list.map((t) => `<option value="${esc(t.id)}"${ct?.teacherId === t.id ? " selected" : ""}>${esc(t.fullName)}</option>`).join("")}</select></div>
      <fieldset class="fo-county"><legend><b>Subject teachers</b> <span class="hint-inline">— tick one or several</span></legend>
        ${list.map((t) => `<label class="fo-pick"><input type="checkbox" data-subject="${esc(t.id)}"${subj.has(t.id) ? " checked" : ""}${ct?.teacherId === t.id ? " disabled" : ""}><span>${esc(t.fullName)}</span></label>`).join("")}
      </fieldset>
      <div class="lms-actions fo-save"><button type="submit" class="btn btn-primary">Save</button><button type="button" class="btn btn-ghost" data-cancel>Cancel</button></div>
    </form>` : `<div class="empty-state">No teachers in the school yet.</div>`;
  const form = panel.querySelector("[data-pick]");
  if (!form) return;
  const lead = form.querySelector("#ct_lead");
  // The class teacher isn't also ticked as a subject teacher; a class teacher being replaced stays on
  // as a subject teacher unless they're unticked — nobody comes off the class without a tick.
  lead.addEventListener("change", () => {
    for (const box of form.querySelectorAll("[data-subject]")) {
      box.disabled = box.dataset.subject === lead.value;
      if (box.disabled) box.checked = false;
      else if (ct && box.dataset.subject === ct.teacherId) box.checked = true;
    }
  });
  panel.querySelector("[data-cancel]").addEventListener("click", () => closeViewer());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const want = new Map(); // teacherId → role
    if (lead.value) want.set(lead.value, "class_teacher");
    for (const box of form.querySelectorAll("[data-subject]:checked")) if (!want.has(box.dataset.subject)) want.set(box.dataset.subject, "subject_teacher");
    const had = new Map(cls.teachers.map((t) => [t.teacherId, t.role]));
    const name = (id) => teachers.find((t) => t.id === id)?.fullName || "a teacher";
    const changes = [];
    for (const [id, role] of want) if (had.get(id) !== role) changes.push({ classId: cls.id, teacherId: id, role, label: name(id) });
    // Whoever is left off comes off. A class teacher being replaced comes off with the new one's
    // assignment (it takes the role from them), so there's nothing more to send for them.
    const off = [...had.keys()].filter((id) => !want.has(id)).map((id) => ({ classId: cls.id, teacherId: id, role: null, label: name(id) }));
    for (const ch of off) if (!(had.get(ch.teacherId) === "class_teacher" && lead.value)) changes.push(ch);
    if (!changes.length) { closeViewer(); return; }
    if (off.length && !(await confirmDialog({ title: `Take ${off.map((ch) => ch.label).join(", ")} off ${cls.name}?`, body: "The class keeps its learners and work.", confirmLabel: "Save" }))) return;
    form.querySelector("[type=submit]").disabled = true;
    await apply(changes);
    closeViewer();
    onDone();
  });
}
