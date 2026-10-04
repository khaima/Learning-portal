/* My profile — on every dashboard (nav.js adds the page). Who you are, which
   workspace this is, where your data reaches (your scope), what you can do
   in plain words, anything granted to you on top of your role — and, for
   staff, changing your own password. Everything here comes from the server
   (GET /me, GET /me/access); it only shows, it decides nothing. */
import { esc, initials, toast, errorState, friendlyError } from "./util.js";
import { rawRequest } from "./api.js";

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

export async function renderProfile(el, user) {
  if (!el) return;
  const learner = user.role === "learner";
  el.innerHTML = `<div class="panel"><div class="empty-state">Loading…</div></div>`;
  let access = null;
  try {
    access = await rawRequest("GET", "/me/access");
  } catch (err) {
    el.innerHTML = `<div class="panel">${errorState(navigator.onLine ? friendlyError(err) : "Your access is shown when you're online.", () => renderProfile(el, user))}</div>`;
    return;
  }
  const place = learner
    ? [user.className || user.grade, user.school].filter(Boolean).join(" · ")
    : [user.school, user.county].filter(Boolean).join(" · ");
  el.innerHTML = `
    <div class="panel profile-card">
      <div class="profile-head">
        <span class="side-avatar profile-avatar">${esc(initials(user.fullName || ""))}</span>
        <div>
          <h2 style="margin:0">${esc(user.fullName || "")}</h2>
          <p class="hint" style="margin:.15rem 0 0">${esc(access.roleLabel)}${access.workspace ? ` · ${esc(access.workspace.title)}` : ""}</p>
        </div>
      </div>
      <dl class="profile-facts">
        ${learner ? "" : `<div><dt>Email</dt><dd>${esc(user.email || "—")}</dd></div>`}
        ${user.userCode || user.learnerCode ? `<div><dt>Code</dt><dd><span class="code-chip">${esc(user.userCode || user.learnerCode)}</span></dd></div>` : ""}
        ${place ? `<div><dt>${learner ? "Class and school" : "Based at"}</dt><dd>${esc(place)}</dd></div>` : ""}
        <div><dt>Your data</dt><dd>${esc(access.scope.label)}${access.scope.global ? "" : ` <span class="hint-inline">— lists, dashboards and exports show only this</span>`}</dd></div>
      </dl>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>What you can do</h2></div>
      <p class="hint" style="margin-top:0">From your role${access.grants.length ? " and what's been granted to you" : ""}. The portal checks this on every request — the menu only shows what it allows.</p>
      <div class="access-groups">${access.groups.map((g) => `
        <div class="access-group"><b>${esc(g.group)}</b>
          <ul>${g.items.map((i) => `<li>${esc(i.label)}</li>`).join("")}</ul></div>`).join("")}</div>
    </div>
    ${access.grants.length ? `<div class="panel">
      <div class="panel-head"><h2>Granted to you</h2></div>
      ${access.grants.map((g) => `<div class="task-row"><div style="flex:1;min-width:0"><b>${esc(g.label)}</b>
        <span>${esc(g.reason)} · ${esc(fmtDate(g.grantedAt))}${g.grantedBy ? ` by ${esc(g.grantedBy)}` : ""}</span></div></div>`).join("")}
    </div>` : ""}
    ${learner ? `<div class="panel"><p class="hint" style="margin:0">Your teacher looks after your username and PIN. Ask them if you need a new PIN.</p></div>` : `
    <div class="panel">
      <div class="panel-head"><h2>Change your password</h2></div>
      <form class="profile-password" autocomplete="off">
        <div class="field"><label for="pf_pw">New password</label><input id="pf_pw" type="password" minlength="8" autocomplete="new-password" required></div>
        <div class="field"><label for="pf_pw2">Type it again</label><input id="pf_pw2" type="password" minlength="8" autocomplete="new-password" required></div>
        <p class="field-hint" style="margin-top:0">At least 8 characters. You stay signed in on this device.</p>
        <button class="btn btn-primary" type="submit">Change password</button>
      </form>
    </div>`}`;

  el.querySelector(".profile-password")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const pw = form.querySelector("#pf_pw").value;
    if (pw.length < 8) { toast("Too short", "Use at least 8 characters.", "error"); return; }
    if (pw !== form.querySelector("#pf_pw2").value) { toast("They don't match", "Type the same password twice.", "error"); return; }
    if (!navigator.onLine) { toast("You're offline", "Changing your password needs a connection.", "error"); return; }
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      // Through the API, so the change is audited.
      await rawRequest("POST", "/me/password", { password: pw });
      form.reset();
      toast("Password changed", "Use the new one next time you sign in.", "success");
    } catch (err) {
      toast("Couldn't change it", friendlyError(err, "Check your connection and try again."), "error");
    } finally {
      btn.disabled = false;
    }
  });
}
