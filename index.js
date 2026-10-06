import "./pwa.js";
import { $, $$, friendlyError, toast } from "./util.js";
import { getAuth, setRememberMe, getRememberMe, storedStaffUserId } from "./supabase.js";
import {
  DASHBOARD_PATH, registerStaff, signInWithPassword, signInWithGoogle,
  learnerLogin, getProfile, createProfile, setMySchool, signOut, sendPasswordResetLink,
  getInvitation, acceptInvitation, authSettings, changeMyPassword,
} from "./auth.js";
import { learnerToken, ApiError } from "./api.js";
import { ROLES } from "./data.js";

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
/* The school list (and the store code behind it) is only needed when an
   account is being set up, so it isn't part of the sign-in page's download. */
const schoolTools = () => import("./store.js");
const PENDING_ROLE_KEY = "hpf_pending_role";

/* "Remember me": besides where the session token lives (supabase.js),
   remember the last email/username used per role so a returning,
   remembered visitor doesn't have to retype it. Never stores a password
   or PIN. Cleared the moment someone signs in with the box unchecked. */
const LAST_STAFF_KEY = "hpf_last_staff_login";
const LAST_LEARNER_KEY = "hpf_last_learner_username";

function loadLastStaffLogin() {
  try { return JSON.parse(localStorage.getItem(LAST_STAFF_KEY) || "null"); } catch { return null; }
}
function saveLastStaffLogin(role, email) {
  try { localStorage.setItem(LAST_STAFF_KEY, JSON.stringify({ role, email })); } catch { /* ignore */ }
}
function clearLastStaffLogin() {
  try { localStorage.removeItem(LAST_STAFF_KEY); } catch { /* ignore */ }
}
/* Ask the browser's own password manager to remember this login — what
   actually makes it autofill email+password next time (staff only)
   instead of retyping it, on top of the "remember me" session/prefill
   above. Chrome/Edge support the Credential Management API used here;
   Safari/Firefox just don't have `PasswordCredential` and this quietly
   no-ops there, same as any other site using this API. Only called when
   "remember me" is checked, and always awaited before navigating away —
   the browser needs a beat to store it. */
async function offerToSaveCredential(id, password) {
  if (typeof PasswordCredential === "undefined" || !navigator.credentials?.store) return;
  try {
    await navigator.credentials.store(new PasswordCredential({ id, password }));
  } catch { /* not fatal — sign-in already succeeded either way */ }
}

function loadLastLearnerUsername() {
  try { return localStorage.getItem(LAST_LEARNER_KEY) || ""; } catch { return ""; }
}
function saveLastLearnerUsername(username) {
  try { localStorage.setItem(LAST_LEARNER_KEY, username); } catch { /* ignore */ }
}
function clearLastLearnerUsername() {
  try { localStorage.removeItem(LAST_LEARNER_KEY); } catch { /* ignore */ }
}

// The page's code has arrived: no "slow connection" notice needed.
window.__hpfReady = true;
$("#gateSlow").hidden = true;

const steps = {
  loading: $("#stepLoading"),
  role: $("#stepRole"),
  learner: $("#stepLearner"),
  password: $("#stepPassword"),
  resetPassword: $("#stepResetPassword"),
  onboard: $("#stepOnboard"),
  school: $("#stepSchool"),
  status: $("#stepStatus"),
  invite: $("#stepInvite"),
};
function show(name) {
  for (const [k, el] of Object.entries(steps)) el.hidden = k !== name;
  $(".gate-card").dataset.step = name; // the brand header shrinks after step 1
  // A staff sign-in is coming: fetch the sign-in library while they type,
  // and find out whether to offer Google (its button is on this step only,
  // so the first load of the page doesn't wait on another server).
  if (name === "password") {
    getAuth().catch(() => {});
    authSettings().then((s) => { authCfg = s; syncGoogleButton(); });
  }
}

function pendingRole() {
  try { return sessionStorage.getItem(PENDING_ROLE_KEY) || "teacher"; } catch { return "teacher"; }
}
function setPendingRole(role) {
  try { sessionStorage.setItem(PENDING_ROLE_KEY, role); } catch { /* ignore */ }
}

function goToDashboard(role) {
  try { sessionStorage.removeItem(PENDING_ROLE_KEY); } catch { /* ignore */ }
  location.href = DASHBOARD_PATH[role] || "index.html";
}

/* Exchange the ?code= Google leaves in the URL for a session (we run
   with detectSessionInUrl:false so this doesn't happen automatically).
   No-op for a plain visit or the password/learner flows. */
async function consumeOAuthRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (code || params.has("error")) history.replaceState({}, "", location.pathname);
  if (!code) return;
  try {
    await (await getAuth()).exchangeCodeForSession(code);
  } catch (err) {
    console.warn("Google sign-in failed:", err?.message);
  }
}

/* Land here from an emailed "reset password" link (an administrator's
   Users → Reset password → Send reset link, or "Forgot password?" below —
   templates and mail sender in docs/AUTH.md). Supabase
   delivers recovery tokens as a #access_token/#refresh_token hash
   fragment (not the ?code= that Google OAuth uses — recovery links are
   commonly opened on a different device/browser than the one that
   requested them, so they carry the full proof instead of a PKCE code
   tied to this browser), but a ?code= is also handled defensively in
   case that ever changes. Shows the "set a new password" step instead of
   routing normally. Returns true whenever this load IS a recovery link —
   success or an expired/already-used one — so the caller skips route(). */
async function consumePasswordRecovery() {
  const params = new URLSearchParams(location.search);
  if (params.get("flow") !== "recovery") return false;

  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const code = params.get("code");
  history.replaceState({}, "", location.pathname);

  try {
    let session = null;
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    if (accessToken && refreshToken) {
      const { data, error } = await (await getAuth()).setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) throw error;
      session = data.session;
    } else if (code) {
      const { data, error } = await (await getAuth()).exchangeCodeForSession(code);
      if (error) throw error;
      session = data.session;
    } else {
      throw new Error(hash.get("error_description") || "Missing recovery token");
    }
    $("#rpEmail").textContent = session?.user?.email || "your account";
    show("resetPassword");
    return true;
  } catch {
    $("#rpHeading").textContent = "Link expired";
    $("#rpSub").hidden = true;
    $("#rpLinkError").textContent =
      "This link is invalid, already used, or has expired. Use “Forgot password?” to get a new one, or ask an administrator.";
    $("#rpLinkErrorField").hidden = false;
    $("#resetPasswordForm").hidden = true;
    $("#rpBack").hidden = false;
    show("resetPassword");
    return true;
  }
}

/* ---- invitation links (index.html?invite=…) ----
   Kept for the whole sign-up — including a Google round trip — and
   dropped once used. The role and school come from the invitation on the
   server, never from this page. */
const INVITE_KEY = "hpf_invite_token";
function pendingInvite() {
  try { return sessionStorage.getItem(INVITE_KEY) || ""; } catch { return ""; }
}
function clearInvite() {
  try { sessionStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
}
(function captureInviteFromUrl() {
  const params = new URLSearchParams(location.search);
  const token = params.get("invite");
  if (!token) return;
  try { sessionStorage.setItem(INVITE_KEY, token); } catch { /* ignore */ }
  params.delete("invite");
  const rest = params.toString();
  history.replaceState({}, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
})();

async function loadInviteOrDrop(token) {
  try {
    return await getInvitation(token);
  } catch (err) {
    clearInvite();
    toast("Invitation not valid", friendlyError(err, "That invitation link couldn't be checked."), "error");
    return null;
  }
}

/* Not signed in yet: create the account for the invited email. */
async function showInviteSignup(token) {
  const inv = await loadInviteOrDrop(token);
  if (!inv) { show("role"); return; }
  setPendingRole(inv.role);
  $("#pwRoleLabel").textContent = inv.roleLabel;
  setPwMode(true);
  $("#pwSub").textContent = `You've been invited to join as ${inv.roleLabel}. Create a password for ${inv.email} — or sign in if you already have an account.`;
  $("#pw_email").value = inv.email;
  show("password");
}

/* Signed in: confirm name (and BOM/TSC for teachers) and join. */
async function showInviteAccept(token, profile) {
  const inv = await loadInviteOrDrop(token);
  if (!inv) return false;
  $("#ivRole").textContent = inv.roleLabel;
  $("#ivSub").textContent = `For ${inv.email}${inv.school ? ` · ${inv.school}` : inv.county ? ` · ${inv.county}` : ""}.`;
  $("#iv_name").value = profile?.fullName || "";
  $("#iv_tt_field").hidden = inv.role !== "teacher";
  $("#inviteError").hidden = true;
  show("invite");
  return true;
}

$("#inviteAcceptForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#inviteError");
  err.hidden = true;
  const btn = e.target.querySelector("[type=submit]");
  btn.disabled = true;
  try {
    const fd = new FormData(e.target);
    const profile = await acceptInvitation(pendingInvite(), {
      fullName: String(fd.get("fullName") || "").trim(),
      teacherType: fd.get("teacherType") || "",
    });
    clearInvite();
    goToDashboard(profile.role);
  } catch (e2) {
    btn.disabled = false;
    err.textContent = friendlyError(e2, "Couldn't accept the invitation. Check your connection and try again.");
    err.hidden = false;
  }
});
$("#inviteSignOut").addEventListener("click", async () => {
  await signOut();
  const token = pendingInvite();
  if (token) showInviteSignup(token); else show("role");
});

/* ---- accounts that can't be used yet (or any more) ---- */
const STATUS_COPY = {
  pending: ["Waiting for approval", (p) =>
    `Thanks — your request to join as ${ROLE_LABEL[p.requestedRole || p.role] || "staff"} has been sent. An administrator will review it. You can close this page and sign in again later.`],
  rejected: ["Account not approved", () =>
    "An administrator didn't approve this account. Contact them if you think this is a mistake."],
  suspended: ["Account suspended", () => "This account is suspended. Contact an administrator."],
  deactivated: ["Account deactivated", () => "This account has been deactivated. Contact an administrator."],
};
function showStatus(profile) {
  const [heading, text] = STATUS_COPY[profile.status] || ["Account not active", () => "Contact an administrator."];
  $("#stHeading").textContent = heading;
  $("#stText").textContent = text(profile);
  $("#stReason").hidden = !profile.statusReason;
  $("#stReason").textContent = profile.statusReason ? `Reason: ${profile.statusReason}` : "";
  $("#stEmail").textContent = profile.email || "";
  show("status");
}
$("#stRefresh").addEventListener("click", () => { show("loading"); route(); });
$("#stSignOut").addEventListener("click", async () => {
  await signOut();
  show("role");
});

/* ---- decide which step to show on load ---- */
async function route() {
  const hasLearner = !!learnerToken();
  const invite = hasLearner ? "" : pendingInvite();
  if (!hasLearner) {
    // No staff session on this device: the role tiles, without loading the sign-in library.
    const data = storedStaffUserId()
      ? await getAuth().then((a) => a.getSession()).then((r) => r.data).catch(() => ({}))
      : {};
    if (!data.session) {
      if (invite) await showInviteSignup(invite); else showRoles();
      return;
    }
  }
  const profile = await getProfile({ force: true });
  // An invitation finishes a new or still-pending account; an account that's
  // already set up just carries on as normal.
  if (invite && (!profile || profile.needsOnboarding || profile.status === "pending")) {
    if (await showInviteAccept(invite, profile)) return;
  } else if (invite) {
    clearInvite();
  }
  if (profile && !profile.needsOnboarding && (profile.status ?? "active") !== "active") {
    showStatus(profile);
    return;
  }
  if (profile?.mustChangePassword) {
    showChooseOwnPassword(profile);
    return;
  }
  if (profile?.needsSchool) {
    showSchoolStep(profile);
    return;
  }
  if (profile && !profile.needsOnboarding) {
    if (profile.email && getRememberMe()) saveLastStaffLogin(profile.role, profile.email);
    goToDashboard(profile.role);
    return;
  }
  if (hasLearner) { showRoles(); return; } // stale learner token, cleared by getProfile
  // Staff signed in but not onboarded yet (first Google sign-in lands here too).
  if (profile?.email && getRememberMe()) saveLastStaffLogin(pendingRole(), profile.email);
  $("#onboardEmail").textContent = profile?.email || "you";
  setOnboardRole(pendingRole());
  show("onboard");
  loadOnboardSchools();
}

// ---- step 1: role ----
// The role picked goes in the address (#teacher), so the phone's Back
// button returns to the tiles instead of leaving the portal — and a tile
// tapped before this code arrived is opened as soon as it does.
const ROLE_TILES = new Set($$("#loginRoleGrid .gate-role").map((a) => a.dataset.role));
const hashRole = () => { const h = location.hash.slice(1); return ROLE_TILES.has(h) ? h : null; };
let pushedRole = false;

function showRoles() {
  show("role");
  const role = hashRole();
  if (role) openRole(role);
}
function backToRoles() {
  if (pushedRole) { pushedRole = false; history.back(); return; } // hashchange shows the tiles
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  show("role");
}
$$("#loginRoleGrid .gate-role").forEach((tile) =>
  tile.addEventListener("click", (e) => {
    e.preventDefault();
    const role = tile.dataset.role;
    if (hashRole() === role) { openRole(role); return; }
    pushedRole = true;
    location.hash = role; // → hashchange → openRole
  })
);
window.addEventListener("hashchange", () => {
  if (!["role", "learner", "password"].includes($(".gate-card").dataset.step)) return;
  const role = hashRole();
  if (role) openRole(role);
  else { pushedRole = false; show("role"); }
});
$("#gateHelpBtn").addEventListener("click", () => {
  const open = $("#gateHelp").hidden;
  $("#gateHelp").hidden = !open;
  $("#gateHelpBtn").setAttribute("aria-expanded", String(open));
});

function openRole(role) {
  if (role === "learner") {
    $("#learnerError").hidden = true;
    $("#ln_user").value = loadLastLearnerUsername();
    show("learner");
    $("#ln_user").focus();
    return;
  }
  setPendingRole(role);
  // The tile's own wording ("School Head"), so the heading matches what was tapped.
  $("#pwRoleLabel").textContent = $(`#loginRoleGrid [data-role="${role}"] b`)?.textContent || ROLE_LABEL[role] || role;
  setPwMode(false);
  const last = loadLastStaffLogin();
  $("#pw_email").value = last && last.role === role ? last.email : "";
  show("password");
  $("#pw_email").focus();
}

$("#changeRole").addEventListener("click", backToRoles);
$("#learnerBack").addEventListener("click", backToRoles);

// ---- learner sign-in (username + PIN) ----
const learnerForm = $("#learnerForm");
const learnerError = $("#learnerError");
learnerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  learnerError.hidden = true;
  const username = $("#ln_user").value.trim().toLowerCase();
  const remember = $("#ln_remember").checked;
  setRememberMe(remember);
  const btn = learnerForm.querySelector("[type=submit]");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  const res = await learnerLogin(username, $("#ln_pin").value);
  btn.disabled = false;
  btn.textContent = "Sign in";
  if (res.error) {
    learnerError.textContent = res.error;
    learnerError.hidden = false;
    $("#ln_pin").value = "";
    return;
  }
  // Learners share school devices, so their PIN is never offered to the
  // browser's password manager — only the username is remembered.
  if (remember) {
    saveLastLearnerUsername(username);
  } else {
    clearLastLearnerUsername();
  }
  location.href = "learner.html";
});

// ---- staff step 2: email + password ----
const passwordForm = $("#passwordForm");
const pwError = $("#pwError");
let pwSignupMode = false;

function setPwMode(signup) {
  pwSignupMode = signup;
  $("#pwHeadVerb").textContent = signup ? "Create an account" : "Sign in";
  $("#pwSub").textContent = signup
    ? "Pick a password you'll remember."
    : "Enter your email and password.";
  $("#pwSubmit").textContent = signup ? "Create account" : "Sign in";
  $("#pw_pass").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  $("#pw_pass").placeholder = signup ? "At least 8 characters" : "Your password";
  syncGoogleButton();
  $("#pwToggleMode").textContent = signup
    ? "Already have an account? Sign in"
    : "New here? Create an account";
  pwError.hidden = true;
  setForgotMode(false);
}

$("#pwToggleMode").addEventListener("click", () => setPwMode(!pwSignupMode));

/* "Continue with Google" appears only once Supabase Auth's public settings
   say Google is switched on — never shown and then failing (they're read
   when the password step opens, in show()). While public sign-ups are
   closed it's for signing in only, so it isn't offered when creating an
   account. */
let authCfg = null;
function syncGoogleButton() {
  const on = !!authCfg?.external?.google && !(pwSignupMode && authCfg?.disable_signup);
  $("#googleBtn").hidden = !on;
  $("#googleDivider").hidden = !on;
}

// ---- self-service password reset (emails a link) ----
const forgotForm = $("#forgotForm");
const forgotError = $("#forgotError");

function setForgotMode(on) {
  passwordForm.hidden = on;
  $("#pwFootLinks").hidden = on;
  forgotForm.hidden = !on;
  $("#forgotSent").hidden = true;
  forgotError.hidden = true;
  $("#forgotFootLinks").hidden = !on;
  if (on) {
    $("#fp_email").value = $("#pw_email").value.trim();
    $("#fp_email").focus();
  }
}

$("#pwForgotLink").addEventListener("click", () => setForgotMode(true));
$("#forgotBack").addEventListener("click", () => setForgotMode(false));

forgotForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  forgotError.hidden = true;
  const email = $("#fp_email").value.trim();
  const btn = $("#forgotSubmit");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    await sendPasswordResetLink(email);
    forgotForm.hidden = true;
    $("#forgotFootLinks").hidden = false;
    const sent = $("#forgotSent");
    sent.textContent = `If an account exists for ${email}, a reset link is on its way — check your inbox.`;
    sent.hidden = false;
  } catch (err) {
    forgotError.textContent = friendlyError(err, "Could not send the reset link. Check your connection and try again.");
    forgotError.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Send reset link";
  }
});

passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  pwError.hidden = true;
  const email = $("#pw_email").value.trim();
  const password = $("#pw_pass").value;
  const remember = $("#pw_remember").checked;
  setRememberMe(remember);
  const btn = $("#pwSubmit");
  btn.disabled = true;
  btn.textContent = pwSignupMode ? "Creating…" : "Signing in…";

  try {
    if (pwSignupMode) {
      const reg = await registerStaff(email, password);
      if (reg.error && !reg.exists) {
        pwError.textContent = reg.error;
        pwError.hidden = false;
        return;
      }
      // reg.exists → fall through and just try to sign in
    }
    const res = await signInWithPassword(email, password);
    if (res.error) {
      pwError.textContent = pwSignupMode
        ? "Account is ready, but that password didn't sign you in. Try again."
        : res.error;
      pwError.hidden = false;
      return;
    }
    if (remember) {
      saveLastStaffLogin(pendingRole(), email);
      await offerToSaveCredential(email, password);
    } else {
      clearLastStaffLogin();
    }
    show("loading");
    route();
  } finally {
    btn.disabled = false;
    btn.textContent = pwSignupMode ? "Create account" : "Sign in";
  }
});

// ---- staff step 2: Google ----
$("#googleBtn").addEventListener("click", async () => {
  pwError.hidden = true;
  setRememberMe($("#pw_remember").checked);
  try {
    await signInWithGoogle();
  } catch (err) {
    pwError.textContent = friendlyError(err, "Couldn't start Google sign-in. Check your connection and try again.");
    pwError.hidden = false;
  }
});

// ---- where each role sits ----
/* Teachers and school heads pick County → School from the Education
   Team's list and get a personal code under that school's code; field
   officers pick only their county (they choose a school per visit/form);
   the Education Team is portal-wide and picks neither. */
const SCHOOL_ROLES = ["teacher", "school_leader"];
const CODE_LETTER = { teacher: "T", school_leader: "H" };
/* Roles a new account can pick for itself — the API refuses anything
   else. Education Team is granted by an existing Education Team member. */
const ONBOARD_ROLES = ["teacher", "school_leader", "field_officer"];

function codeHint(el, school, role) {
  el.textContent = school
    ? `School code ${school.code}. Your personal code will be ${school.code}-${CODE_LETTER[role] || "T"}… — given to you as soon as you continue.`
    : "";
}

// ---- onboarding (staff only) ----
let selectedRole = "teacher";
let onboardPicker = null;
const roleCards = $$("#roleGrid .role-card");
function setOnboardRole(role) {
  if (!ONBOARD_ROLES.includes(role)) role = "teacher";
  selectedRole = role;
  roleCards.forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.role === role)));
  $("#ob_grade_field").hidden = role !== "learner";
  $("#ob_teacher_type_field").hidden = role !== "teacher";
  $("#ob_county_field").hidden = !(SCHOOL_ROLES.includes(role) || role === "field_officer");
  $("#ob_school_field").hidden = !SCHOOL_ROLES.includes(role);
  codeHint($("#ob_code_hint"), onboardPicker?.current(), role);
}
roleCards.forEach((c) => c.addEventListener("click", () => setOnboardRole(c.dataset.role)));

/* Live list: a school the Education Team adds while someone is on this
   screen appears in their dropdown when they come back to the tab (or
   within a minute) — no reload needed. */
async function loadOnboardSchools() {
  $("#ob_county").innerHTML = `<option value="">Loading…</option>`;
  $("#ob_school").innerHTML = `<option value="">Loading…</option>`;
  let watchSchools, wireSchoolPicker;
  try {
    ({ watchSchools, wireSchoolPicker } = await schoolTools());
  } catch (err) {
    onboardError.textContent = friendlyError(err, "Couldn't load the list of schools. Check your connection and reload.");
    onboardError.hidden = false;
    return;
  }
  watchSchools(
    (data) => {
      const onChange = (school) => codeHint($("#ob_code_hint"), school, selectedRole);
      if (onboardPicker) onboardPicker.update(data);
      else onboardPicker = wireSchoolPicker($("#ob_county"), $("#ob_school"), data, { onChange });
    },
    (err) => {
      onboardError.textContent = friendlyError(err, "Couldn't load the list of schools. Check your connection and reload.");
      onboardError.hidden = false;
    },
  );
}

const onboardForm = $("#onboardForm");
const onboardError = $("#onboardError");
onboardForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  onboardError.hidden = true;
  const btn = onboardForm.querySelector("[type=submit]");
  const fd = new FormData(onboardForm);
  const school = onboardPicker?.current();
  const county = onboardPicker?.county() || "";
  if (SCHOOL_ROLES.includes(selectedRole) && !school) {
    onboardError.textContent = "Choose your county and then your school.";
    onboardError.hidden = false;
    return;
  }
  if (selectedRole === "field_officer" && !county) {
    onboardError.textContent = "Choose your county.";
    onboardError.hidden = false;
    return;
  }
  btn.disabled = true;
  try {
    const profile = await createProfile({
      fullName: fd.get("fullName"),
      role: selectedRole,
      schoolId: school?.id || null,
      county,
      grade: fd.get("grade"),
      teacherType: fd.get("teacherType"),
    });
    // A new account waits for an administrator's approval.
    if ((profile.status ?? "active") !== "active") showStatus(profile);
    else goToDashboard(profile.role);
  } catch (err) {
    btn.disabled = false;
    onboardError.textContent = friendlyError(err, "Could not create your account. Check your connection and try again.");
    onboardError.hidden = false;
  }
});

$("#onboardSignOut").addEventListener("click", async () => {
  await signOut();
  show("role");
});

// ---- one-time school pick (accounts made before school codes) ----
let schoolPicker = null;
const schoolForm = $("#schoolForm");
const schoolError = $("#schoolError");
async function showSchoolStep(profile) {
  show("school");
  schoolError.hidden = true;
  let watchSchools, wireSchoolPicker;
  try {
    ({ watchSchools, wireSchoolPicker } = await schoolTools());
  } catch (err) {
    schoolError.textContent = friendlyError(err, "Couldn't load the list of schools. Check your connection and reload.");
    schoolError.hidden = false;
    return;
  }
  watchSchools(
    (data) => {
      if (schoolPicker) schoolPicker.update(data);
      else schoolPicker = wireSchoolPicker($("#sp_county"), $("#sp_school"), data, {
        onChange: (school) => codeHint($("#sp_code_hint"), school, profile.role),
      });
    },
    (err) => {
      schoolError.textContent = friendlyError(err, "Couldn't load the list of schools. Check your connection and reload.");
      schoolError.hidden = false;
    },
  );
}
schoolForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  schoolError.hidden = true;
  const school = schoolPicker?.current();
  if (!school) {
    schoolError.textContent = "Choose your county and then your school.";
    schoolError.hidden = false;
    return;
  }
  const btn = schoolForm.querySelector("[type=submit]");
  btn.disabled = true;
  try {
    const profile = await setMySchool(school.id);
    goToDashboard(profile.role);
  } catch (err) {
    btn.disabled = false;
    schoolError.textContent = friendlyError(err, "Couldn't save your school. Check your connection and try again.");
    schoolError.hidden = false;
  }
});
$("#schoolSignOut").addEventListener("click", async () => {
  await signOut();
  show("role");
});

// ---- set a new password (from an emailed reset link) ----
$("#rpBack").addEventListener("click", async () => {
  await signOut().catch(() => {});
  show("role");
});

/* Signed in with a temporary password from an administrator: the only way
   on is to choose their own — the API refuses everything else until they
   do. The same form as a reset link. */
function showChooseOwnPassword(profile) {
  $("#rpEyebrow").textContent = "Temporary password";
  $("#rpHeading").textContent = "Choose your own password";
  const sub = $("#rpSub");
  sub.hidden = false;
  sub.innerHTML = `You signed in as <b id="rpEmail"></b> with a temporary password. Choose your own to carry on — the temporary one stops working once you do.`;
  $("#rpEmail").textContent = profile.email || "your account";
  $("#rpLinkErrorField").hidden = true;
  $("#resetPasswordForm").hidden = false;
  $("#rpSubmit").textContent = "Save my password";
  $("#rpBack").textContent = "Sign out";
  $("#rpBack").hidden = false;
  show("resetPassword");
  $("#rp_pass").focus();
}

$("#resetPasswordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#resetPasswordError");
  err.hidden = true;
  const p1 = $("#rp_pass").value;
  const p2 = $("#rp_pass2").value;
  if (p1.length < 8) {
    err.textContent = "Password must be at least 8 characters.";
    err.hidden = false;
    return;
  }
  if (p1 !== p2) {
    err.textContent = "Passwords don't match.";
    err.hidden = false;
    return;
  }
  const btn = $("#rpSubmit");
  btn.disabled = true;
  try {
    await changeMyPassword(p1);
    // Let the browser's password manager keep the new one, if they asked to be remembered.
    const email = (await (await getAuth()).getSession()).data.session?.user?.email;
    if (email && getRememberMe()) await offerToSaveCredential(email, p1);
    // Already signed in — straight on to their dashboard.
    show("loading");
    await route();
  } catch (e2) {
    btn.disabled = false;
    if (e2 instanceof ApiError && e2.body?.signInAgain) {
      // A session from before the temporary password was made can't replace it.
      $("#resetPasswordForm").hidden = true;
      $("#rpLinkError").textContent = e2.message;
      $("#rpLinkErrorField").hidden = false;
      $("#rpBack").textContent = "Sign in again";
      return;
    }
    err.textContent = friendlyError(e2, "Could not save the password. Check your connection and try again.");
    err.hidden = false;
  }
});

(async () => {
  if (await consumePasswordRecovery()) return;
  await consumeOAuthRedirect();
  route();
})();
