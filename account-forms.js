/* ============================================================
   HPF Digital Learning Portal — inviting someone, and editing a profile.

   Two forms in a side panel (a <dialog>: it holds the focus, Escape or
   Cancel closes it, and the page behind can't be clicked by mistake):

     Invite someone  their role (only the roles this person may give: for
                     the Programme Admin, a teacher, school head or field
                     officer), their email and where they'll work. Then the
                     invitation is emailed, or a link made to copy; either
                     way the link works once and expires in 14 days.
     Edit profile    their details (name, email, gender) and their role,
                     county, school and employment type: what this person
                     may change. Save stays off until something changes,
                     and the panel says what will change before it does.

   Mistakes are shown beside the field, in words, inside the panel. The API
   checks every one of these again.
   ============================================================ */

import { esc, initials, friendlyError, toast } from "./util.js";
import { inviteStaff, updateUser, wireSchoolPicker } from "./store.js";

const ROLE_HELP = {
  teacher: "Teaches classes at one school: registers, classwork and marks.",
  school_leader: "Runs one school: its teachers, classes and learners.",
  field_officer: "Visits schools in a county and reports on them.",
  education_team: "Runs learning and education across the programme.",
  me: "Measures the programme: indicators, results and reports.",
  super_admin: "Runs the whole portal: accounts, data and settings.",
};
const IN_SCHOOL = new Set(["teacher", "school_leader"]);
const GENDERS = [["", "Not recorded"], ["female", "Female"], ["male", "Male"], ["prefer_not_to_say", "Prefer not to say"]];
const EMPLOYMENT = [["", "Not specified"], ["BOM", "BOM"], ["TSC", "TSC"]];
const STATUS = { active: "Active", pending: "Waiting for approval", suspended: "Suspended", deactivated: "Deactivated", rejected: "Not approved" };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLOSE_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const DONE_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>';

/* ---- the panel ---- */
let seq = 0;
function openPanel({ title, head = "", body }) {
  const id = `sf${++seq}`;
  const d = document.createElement("dialog");
  d.className = "side-form";
  d.setAttribute("aria-labelledby", `${id}-title`);
  d.innerHTML = `
    <div class="sf-head">
      <div class="sf-head-text"><h2 id="${id}-title">${esc(title)}</h2>${head}</div>
      <button type="button" class="sf-close" data-sf-close aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="sf-body">${body}</div>`;
  document.body.appendChild(d);
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", (e) => {
    if (e.target === d || e.target.closest("[data-sf-close]")) d.dispatchEvent(new Event("cancel", { cancelable: true })) && d.close();
  });
  d.showModal();
  return d;
}

/** A field's mistake, in words, beside it; cleared when they change it. */
function fieldError(field, message) {
  const box = field.closest(".field, .sf-section");
  let p = box.querySelector(":scope > .field-error");
  if (!p) {
    p = document.createElement("p");
    p.className = "field-error";
    p.id = `${field.id || field.name}-error`;
    box.appendChild(p);
  }
  p.textContent = message;
  p.hidden = !message;
  box.classList.toggle("is-invalid", !!message);
  if (field.setAttribute) {
    if (message) { field.setAttribute("aria-invalid", "true"); field.setAttribute("aria-describedby", p.id); }
    else { field.removeAttribute("aria-invalid"); }
  }
}
const clearErrors = (form) => form.querySelectorAll(".is-invalid").forEach((b) => {
  b.classList.remove("is-invalid");
  b.querySelector(":scope > .field-error")?.setAttribute("hidden", "");
});
function formError(form, message) {
  const box = form.querySelector("[data-sf-error]");
  box.textContent = message || "";
  box.hidden = !message;
}

// Most often given first: the people the programme works through, then the administrators.
const ROLE_ORDER = ["teacher", "school_leader", "field_officer", "education_team", "admin", "me", "super_admin"];
const byUse = (a, b) => ROLE_ORDER.indexOf(a.value) - ROLE_ORDER.indexOf(b.value);

function roleChoices(roles, current, { name = "role", disabled = false } = {}) {
  return `<div class="role-choices" role="radiogroup">${[...roles].sort(byUse).map((r) => `
    <label class="role-choice">
      <input type="radio" name="${name}" value="${esc(r.value)}"${r.value === current ? " checked" : ""}${disabled ? " disabled" : ""}>
      <span class="rc-text"><b>${esc(r.label)}</b>${ROLE_HELP[r.value] ? `<span>${esc(ROLE_HELP[r.value])}</span>` : ""}</span>
    </label>`).join("")}</div>`;
}
const options = (list, current) => list.map(([v, l]) => `<option value="${esc(v)}"${v === (current ?? "") ? " selected" : ""}>${esc(l)}</option>`).join("");
const roleLabelOf = (roles, value, fallback) => roles.find((r) => r.value === value)?.label || fallback || value;

/* ============================================================ Invite someone */

/**
 * @param {{ grantable: {value:string,label:string}[], schoolDir: {counties:string[], schools:object[]},
 *           emailReady: boolean, onDone?: () => void }} opts
 */
export function openInviteForm({ grantable, schoolDir, emailReady, onDone = () => {} }) {
  const start = grantable.some((r) => r.value === "teacher") ? "teacher" : grantable[0]?.value || "";
  const d = openPanel({
    title: "Invite someone",
    head: `<p class="sf-sub">They get a link to make their own account, with the role and place you choose here.</p>`,
    body: inviteBody(grantable, start, emailReady),
  });
  wireInvite(d, { grantable, schoolDir, emailReady, onDone });
}

function inviteBody(grantable, start, emailReady) {
  return `<form class="sf-form" novalidate>
    <fieldset class="sf-section">
      <legend>Their role</legend>
      ${roleChoices(grantable, start)}
    </fieldset>
    <div class="sf-section">
      <div class="field"><label for="sfi_email">Their email</label>
        <input id="sfi_email" type="email" autocomplete="off" spellcheck="false" placeholder="name@example.org" required>
        <p class="field-hint">The invitation goes to this address, and they sign in with it.</p></div>
    </div>
    <fieldset class="sf-section" data-where>
      <legend>Where they'll work</legend>
      <div class="sf-grid">
        <div class="field"><label for="sfi_county">County</label><select id="sfi_county"></select></div>
        <div class="field" data-school-field><label for="sfi_school">School</label><select id="sfi_school"></select></div>
      </div>
      <p class="field-hint" data-where-hint></p>
    </fieldset>
    <div class="sf-summary" data-summary aria-live="polite"></div>
    ${emailReady ? "" : `<p class="field-hint sf-note">Email isn't set up for the portal yet, so you'll copy the link and send it yourself.</p>`}
    <div class="alert alert-warn sf-error" data-sf-error role="alert" hidden></div>
    <div class="sf-foot">
      ${emailReady
        ? `<button class="btn btn-primary" type="submit" value="email">Send invitation email</button>
           <button class="btn btn-outline" type="submit" value="link">Create link to copy</button>`
        : `<button class="btn btn-primary" type="submit" value="link">Create invitation link</button>`}
      <button class="btn btn-ghost" type="button" data-sf-close>Cancel</button>
    </div>
  </form>`;
}

function wireInvite(d, { grantable, schoolDir, emailReady, onDone }) {
  const form = d.querySelector("form");
  const email = form.querySelector("#sfi_email");
  const countySel = form.querySelector("#sfi_county");
  const schoolSel = form.querySelector("#sfi_school");
  const role = () => form.querySelector('input[name="role"]:checked')?.value || "";
  const picker = wireSchoolPicker(countySel, schoolSel, schoolDir, { onChange: sync });

  function sync() {
    const r = role();
    const inSchool = IN_SCHOOL.has(r);
    const placed = inSchool || r === "field_officer";
    form.querySelector("[data-where]").hidden = !placed;
    form.querySelector("[data-school-field]").hidden = !inSchool;
    const school = picker.current();
    form.querySelector("[data-where-hint]").textContent = inSchool
      ? (school ? `They'll be placed at ${school.name} and get a code under ${school.code}.` : "Teachers and school heads belong to one school.")
      : r === "field_officer" ? "Field officers belong to a county. The schools they support are set on Field officers." : "";
    const who = email.value.trim() || "them";
    const where = inSchool && school ? ` at <b>${esc(school.name)} (${esc(school.code)})</b>`
      : r === "field_officer" && picker.county() ? ` in <b>${esc(picker.county())} County</b>` : !placed && r ? " — across every school and county" : "";
    form.querySelector("[data-summary]").innerHTML = r
      ? `An invitation for <b>${esc(who)}</b> to join as <b>${esc(roleLabelOf(grantable, r))}</b>${where}.`
      : "Choose their role.";
  }
  form.addEventListener("change", (e) => { if (e.target.name === "role") sync(); });
  email.addEventListener("input", () => { fieldError(email, ""); sync(); });
  countySel.addEventListener("change", () => fieldError(countySel, ""));
  schoolSel.addEventListener("change", () => fieldError(schoolSel, ""));
  sync();
  email.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors(form);
    formError(form, "");
    const r = role();
    const inSchool = IN_SCHOOL.has(r);
    const school = picker.current();
    const county = picker.county();
    const address = email.value.trim();
    let first = null;
    const bad = (field, msg) => { fieldError(field, msg); first ||= field; };
    if (!address) bad(email, "Enter their email address.");
    else if (!EMAIL_RE.test(address)) bad(email, "That doesn't look like an email address — check it for a typo.");
    if (inSchool && !county) bad(countySel, "Choose the county their school is in.");
    else if (inSchool && !school) bad(schoolSel, "Choose their school.");
    if (r === "field_officer" && !county) bad(countySel, "Choose the county they'll work in.");
    if (first) { first.focus(); return; }

    const send = emailReady && e.submitter?.value === "email";
    const buttons = [...form.querySelectorAll("button")];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const res = await inviteStaff({
        email: address, role: r,
        schoolId: inSchool ? school.id : undefined,
        county: r === "field_officer" ? county : undefined,
        send,
      });
      showInvited(d, res, { again: () => { d.close(); openInviteForm({ grantable, schoolDir, emailReady, onDone }); } });
      onDone();
    } catch (err) {
      buttons.forEach((b) => { b.disabled = false; });
      const msg = friendlyError(err);
      if (/email/i.test(msg) && /account|valid/i.test(msg)) { fieldError(email, msg); email.focus(); }
      else formError(form, msg);
    }
  });
}

/** The invitation made: emailed (or why not), and the link — shown once — to copy either way. */
function showInvited(d, { invitation, token, emailed, emailError }, { again }) {
  const link = new URL(`index.html?invite=${encodeURIComponent(token)}`, location.href).href;
  const until = new Date(invitation.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const head = emailed ? `Invitation emailed to ${invitation.email}` : `Invitation ready for ${invitation.email}`;
  const text = emailed
    ? `They can open it from their inbox. You can also copy the link below to send another way.`
    : emailError
      ? `${emailError}`
      : `Copy the link and send it to them — by SMS, WhatsApp or email. It's shown only now.`;
  d.querySelector(".sf-body").innerHTML = `
    <div class="sf-done" role="status">
      <span class="sf-done-icon">${DONE_ICON}</span>
      <h3>${esc(head)}</h3>
      <p>${esc(invitation.roleLabel)}. ${esc(text)} The link works once and expires on ${esc(until)}.</p>
      <div class="sf-link">
        <label class="sr-only" for="sfi_link">Invitation link</label>
        <input id="sfi_link" type="text" readonly value="${esc(link)}">
        <button type="button" class="btn btn-outline" data-copy>Copy link</button>
      </div>
      <div class="sf-foot">
        <button type="button" class="btn btn-primary" data-again>Invite someone else</button>
        <button type="button" class="btn btn-ghost" data-sf-close>Done</button>
      </div>
    </div>`;
  const input = d.querySelector("#sfi_link");
  d.querySelector("[data-copy]").addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(link); e.target.textContent = "Copied"; }
    catch { input.select(); }
  });
  d.querySelector("[data-again]").addEventListener("click", again);
  (emailed ? d.querySelector("[data-again]") : d.querySelector("[data-copy]")).focus();
}

/* ============================================================ Edit profile */

/**
 * @param {object} u  the account, as GET /users lists it
 * @param {{ grantable: {value:string,label:string}[], schoolDir: object,
 *           can: { details: boolean, role: boolean, place: boolean },
 *           roleLabel: (r:string) => string, onSaved?: (user:object) => void }} opts
 */
export function openProfileForm(u, { grantable, schoolDir, can, roleLabel, onSaved = () => {} }) {
  const roles = grantable.some((r) => r.value === u.role) ? grantable : [{ value: u.role, label: roleLabel(u.role) }, ...grantable];
  const where = [u.school, u.county ? `${u.county} County` : ""].filter(Boolean).join(" · ");
  const d = openPanel({
    title: "Edit profile",
    head: `<div class="sf-person">
      <span class="sf-avatar" aria-hidden="true">${esc(initials(u.fullName || u.email || ""))}</span>
      <div><b>${esc(u.fullName || u.email || "(no name)")}</b>
        <span>${esc([roleLabel(u.role), where, u.userCode].filter(Boolean).join(" · "))}</span>
        <span class="pill ${u.status && u.status !== "active" ? "warm" : "ok"} sf-status">${esc(STATUS[u.status || "active"] || u.status)}</span></div>
    </div>`,
    body: profileBody(u, roles, can),
  });
  wireProfile(d, u, { roles, schoolDir, can, roleLabel, onSaved });
}

function profileBody(u, roles, can) {
  const off = (yes) => (yes ? "" : " disabled");
  return `<form class="sf-form" novalidate>
    <fieldset class="sf-section">
      <legend>Their details</legend>
      <div class="sf-grid">
        <div class="field span-2"><label for="sfp_name">Full name</label>
          <input id="sfp_name" type="text" autocomplete="off" value="${esc(u.fullName || "")}" required${off(can.details)}></div>
        <div class="field span-2"><label for="sfp_email">Email</label>
          <input id="sfp_email" type="email" autocomplete="off" spellcheck="false" value="${esc(u.email || "")}" required${off(can.details)}>
          <p class="field-hint">They sign in with this address, so changing it changes their sign-in.</p></div>
        <div class="field"><label for="sfp_gender">Gender <span class="hint-inline">optional</span></label>
          <select id="sfp_gender"${off(can.details)}>${options(GENDERS, u.gender)}</select></div>
        <div class="field" data-employment><label for="sfp_tt">Employment</label>
          <select id="sfp_tt"${off(can.details)}>${options(EMPLOYMENT, u.teacherType)}</select></div>
      </div>
    </fieldset>
    <fieldset class="sf-section">
      <legend>Role and school</legend>
      ${roleChoices(roles, u.role, { disabled: !can.role })}
      <div class="sf-grid" data-where>
        <div class="field"><label for="sfp_county">County</label><select id="sfp_county"${off(can.place)}></select></div>
        <div class="field" data-school-field><label for="sfp_school">School</label><select id="sfp_school"${off(can.place)}></select></div>
      </div>
      <p class="field-hint" data-where-hint></p>
    </fieldset>
    <div class="sf-summary" data-changes aria-live="polite"></div>
    <div class="alert alert-warn sf-error" data-sf-error role="alert" hidden></div>
    <div class="sf-foot">
      <button class="btn btn-primary" type="submit" disabled>Save changes</button>
      <button class="btn btn-ghost" type="button" data-sf-close>Cancel</button>
    </div>
  </form>`;
}

function wireProfile(d, u, { roles, schoolDir, can, roleLabel, onSaved }) {
  const form = d.querySelector("form");
  const $f = (s) => form.querySelector(s);
  const name = $f("#sfp_name"), email = $f("#sfp_email"), gender = $f("#sfp_gender"), tt = $f("#sfp_tt");
  const countySel = $f("#sfp_county"), schoolSel = $f("#sfp_school");
  const save = $f('button[type="submit"]');
  const role = () => $f('input[name="role"]:checked')?.value || u.role;
  const picker = wireSchoolPicker(countySel, schoolSel, schoolDir, {
    schoolId: u.schoolId, countyId: schoolDir.counties.includes(u.county) ? u.county : "", onChange: sync,
  });
  const schoolName = (id) => schoolDir.schools.find((s) => s.id === id)?.name || "no school";

  /** What would change, as a patch and in words. */
  function changes() {
    const r = role();
    const inSchool = IN_SCHOOL.has(r);
    const school = picker.current();
    const county = picker.county();
    const patch = {};
    const said = [];
    if (can.details) {
      if (name.value.trim() !== (u.fullName || "")) { patch.fullName = name.value.trim(); said.push("name"); }
      if (email.value.trim().toLowerCase() !== (u.email || "").toLowerCase()) { patch.email = email.value.trim(); said.push("email (their sign-in)"); }
      if (gender.value !== (u.gender || "")) { patch.gender = gender.value; said.push("gender"); }
      if (r === "teacher" && tt.value !== (u.teacherType || "")) { patch.teacherType = tt.value; said.push("employment"); }
    }
    if (r !== u.role) { patch.role = r; said.push(`role, ${roleLabel(u.role)} → ${roleLabel(r)}`); }
    if (can.place || patch.role) {
      if (inSchool && school && (school.id !== u.schoolId || patch.role)) {
        patch.schoolId = school.id;
        if (school.id !== u.schoolId) said.push(`school, ${schoolName(u.schoolId)} → ${school.name}`);
      }
      if (r === "field_officer" && county && (county !== (u.county || "") || patch.role)) {
        patch.county = county;
        if (county !== (u.county || "")) said.push(`county, ${u.county || "none"} → ${county}`);
      }
    }
    return { patch, said, r, inSchool, school, county };
  }

  function sync() {
    const { said, r, inSchool, school } = changes();
    const placed = inSchool || r === "field_officer";
    $f("[data-where]").hidden = !placed;
    $f("[data-school-field]").hidden = !inSchool;
    $f("[data-employment]").hidden = r !== "teacher";
    const moving = inSchool && school && (school.id !== u.schoolId || r !== u.role);
    $f("[data-where-hint]").textContent = !placed ? "This role works across every school and county."
      : r === "field_officer" ? "Field officers belong to a county. The schools they support are set on Field officers."
      : moving ? `They'll get a new code under ${school.code}${r === "teacher" ? ", and their learners move to this school with new codes too" : ""}.`
      : u.userCode ? `Their code stays ${u.userCode}.` : "";
    const box = $f("[data-changes]");
    box.innerHTML = said.length ? `<b>Saving changes:</b> ${esc(said.join("; "))}.` : "No changes yet.";
    box.classList.toggle("is-set", said.length > 0);
    save.disabled = !said.length;
  }
  form.addEventListener("input", (e) => { fieldError(e.target, ""); sync(); });
  form.addEventListener("change", sync);
  sync();
  (can.details ? name : form.querySelector("input:not([disabled]), select:not([disabled])"))?.focus();

  // Closing with changes not saved: say so, once.
  let warned = false;
  d.addEventListener("cancel", (e) => {
    if (save.disabled || warned) return;
    e.preventDefault();
    warned = true;
    formError(form, "You have changes that aren't saved. Save them, or close again to leave without saving.");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors(form);
    formError(form, "");
    const { patch, inSchool, school, county, r } = changes();
    let first = null;
    const bad = (field, msg) => { fieldError(field, msg); first ||= field; };
    if (can.details && !name.value.trim()) bad(name, "Enter their full name.");
    if (can.details && !EMAIL_RE.test(email.value.trim())) bad(email, "That doesn't look like an email address — check it for a typo.");
    if (inSchool && !county) bad(countySel, "Choose the county their school is in.");
    else if (inSchool && !school) bad(schoolSel, "Teachers and school heads belong to a school — choose one.");
    if (r === "field_officer" && !county) bad(countySel, "Choose the county they'll work in.");
    if (first) { first.focus(); return; }
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const user = await updateUser(u.id, patch);
      d.close();
      toast("Profile saved", user.userCode && patch.schoolId ? `${user.fullName} is now ${user.userCode}.` : `${user.fullName || "Their"} profile is up to date.`, "success");
      onSaved(user);
    } catch (err) {
      save.textContent = "Save changes";
      save.disabled = false;
      const msg = friendlyError(err);
      if (/email/i.test(msg)) { fieldError(email, msg); email.focus(); }
      else formError(form, msg);
    }
  });
}
