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

/* "Remember me": besides where the session token lives (supabase.js),
   remember the last email or username used, so a returning, remembered
   visitor doesn't have to retype it. Never stores a password or PIN.
   Cleared the moment someone signs in with the box unchecked. (The two
   older keys, one for staff and one for learners, are still read once.) */
const LAST_LOGIN_KEY = "hpf_last_login";
const OLD_LAST_KEYS = ["hpf_last_staff_login", "hpf_last_learner_username"];

function loadLastLogin() {
  try {
    return localStorage.getItem(LAST_LOGIN_KEY)
      || JSON.parse(localStorage.getItem(OLD_LAST_KEYS[0]) || "null")?.email
      || localStorage.getItem(OLD_LAST_KEYS[1]) || "";
  } catch { return ""; }
}
function saveLastLogin(id) {
  try { localStorage.setItem(LAST_LOGIN_KEY, id); } catch { /* ignore */ }
}
function clearLastLogin() {
  try { for (const k of [LAST_LOGIN_KEY, ...OLD_LAST_KEYS]) localStorage.removeItem(k); } catch { /* ignore */ }
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

// The page's code has arrived: no "slow connection" notice needed.
window.__hpfReady = true;
$("#gateSlow").hidden = true;

const steps = {
  loading: $("#stepLoading"),
  signin: $("#stepSignIn"),
  resetPassword: $("#stepResetPassword"),
  onboard: $("#stepOnboard"),
  school: $("#stepSchool"),
  status: $("#stepStatus"),
  invite: $("#stepInvite"),
};
function show(name) {
  for (const [k, el] of Object.entries(steps)) el.hidden = k !== name;
  $(".gate-card").dataset.step = name; // the brand header shrinks after the sign-in step
  // Find out whether to offer Google (its button is on this step only, and
  // the page never waits for the answer).
  if (name === "signin") authSettings().then((s) => { authCfg = s; syncGoogleButton(); });
}

function goToDashboard(role) {
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
  if (!inv) { showSignIn(); return; }
  setPwMode(true);
  $("#siHeading").textContent = `Join as ${inv.roleLabel}`;
  $("#siSub").textContent = `You've been invited to join as ${inv.roleLabel}. Create a password for ${inv.email} — or sign in if you already have an account.`;
  siId.value = inv.email;
  show("signin");
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
  if (token) showInviteSignup(token); else showSignIn();
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
  showSignIn();
});

/* ---- decide which step to show on load ---- */
async function route() {
  const hasLearner = !!learnerToken();
  const invite = hasLearner ? "" : pendingInvite();
  if (!hasLearner) {
    // No staff session on this device: the sign-in form, without loading the sign-in library.
    const data = storedStaffUserId()
      ? await getAuth().then((a) => a.getSession()).then((r) => r.data).catch(() => ({}))
      : {};
    if (!data.session) {
      if (invite) await showInviteSignup(invite); else showSignIn();
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
    // Signed in: straight to the page for the role on the account.
    if (profile.email && getRememberMe()) saveLastLogin(profile.email);
    goToDashboard(profile.role);
    return;
  }
  if (hasLearner) { showSignIn(); return; } // stale learner token, cleared by getProfile
  // Staff signed in but not onboarded yet (first Google sign-in lands here too).
  if (profile?.email && getRememberMe()) saveLastLogin(profile.email);
  $("#onboardEmail").textContent = profile?.email || "you";
  setOnboardRole("teacher"); // they choose on the form
  show("onboard");
  loadOnboardSchools();
}

// ---- sign in: one form, and the account says who it is ----
/* Nobody is asked who they are. An email is a staff sign-in (password);
   anything else is a learner's username (4-digit PIN) — usernames never
   contain "@" (the API's rule). Once in, the portal opens the page for the
   role on the account (route → goToDashboard). The second field follows
   what's typed: a staff password stays hidden and can be kept by the
   browser's password manager; a learner's PIN is 4 numbers and is never
   offered to it (learners share school devices). */
const signInForm = $("#signInForm");
const siId = $("#si_id");
const siSecret = $("#si_secret");
const siError = $("#siError");
let pwSignupMode = false;
let forgotOn = false;
/* A name without "@" is taken as a learner's username once they've moved
   on from the field — not while a staff member is still typing the start of
   their email. */
let idSettled = true;

function signInKind() {
  if (pwSignupMode) return "staff";
  const id = siId.value.trim();
  if (!id) return "either";
  if (id.includes("@")) return "staff";
  return idSettled ? "learner" : "either";
}
function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) el.removeAttribute(k); else el.setAttribute(k, v);
  }
}
const SECRET = {
  either: { label: "Password or PIN", type: "password", autocomplete: "current-password", placeholder: "Your password or 4-digit PIN", inputmode: null, maxlength: null, minlength: null },
  staff: { label: "Password", type: "password", autocomplete: "current-password", placeholder: "Your password", inputmode: null, maxlength: null, minlength: null },
  newStaff: { label: "Password", type: "password", autocomplete: "new-password", placeholder: "At least 8 characters", inputmode: null, maxlength: null, minlength: "8" },
  learner: { label: "4-digit PIN", type: "text", autocomplete: "off", placeholder: "0000", inputmode: "numeric", maxlength: "4", minlength: null },
};
let fieldsNow = "";
function syncSignInFields() {
  const kind = signInKind();
  const key = pwSignupMode ? "newStaff" : kind;
  if (key !== fieldsNow) {
    // A typed password is never shown as plain text: it goes when the field becomes a PIN.
    if (key === "learner" && siSecret.type === "password") siSecret.value = "";
    fieldsNow = key;
    const { label, ...attrs } = SECRET[key];
    $("#siSecretLabel").textContent = label;
    setAttrs(siSecret, attrs);
    if (kind === "staff") getAuth().catch(() => {}); // fetch the sign-in library while they type
  }
  $("#pwForgotLink").hidden = kind === "learner" || pwSignupMode;
  $("#pinForgot").hidden = kind !== "learner";
  syncGoogleButton();
}
siId.addEventListener("input", () => { idSettled = false; siError.hidden = true; syncSignInFields(); });
siId.addEventListener("change", () => { idSettled = true; syncSignInFields(); }); // moved on, or filled in by the browser

function showSignInError(text) {
  siError.textContent = text;
  siError.hidden = false;
}

/** The sign-in form; a remembered visitor finds their email or username filled in. */
function showSignIn() {
  setPwMode(false);
  if (!siId.value) siId.value = loadLastLogin();
  idSettled = true;
  syncSignInFields();
  show("signin");
  // Straight into the form with a mouse; on a phone the keyboard waits for a tap.
  if (matchMedia("(pointer: fine)").matches) (siId.value ? siSecret : siId).focus();
}

$("#gateHelpBtn").addEventListener("click", () => {
  const open = $("#gateHelp").hidden;
  $("#gateHelp").hidden = !open;
  $("#gateHelpBtn").setAttribute("aria-expanded", String(open));
});

function setPwMode(signup) {
  pwSignupMode = signup;
  $("#siHeading").textContent = signup ? "Create an account" : "Sign in";
  $("#siSub").textContent = signup
    ? "For teachers, school heads and field officers: your email and a password you'll remember."
    : "Staff: your email and password. Learners: the username and PIN from your teacher.";
  $("#siIdLabel").textContent = signup ? "Email address" : "Email or username";
  setAttrs(siId, signup
    ? { type: "email", autocomplete: "email", placeholder: "you@example.org" }
    : { type: "text", autocomplete: "username", placeholder: "you@example.org or naomi.k" });
  $("#siSubmit").textContent = signup ? "Create account" : "Sign in";
  $("#pwToggleMode").textContent = signup
    ? "Already have an account? Sign in"
    : "New staff member? Create an account";
  siError.hidden = true;
  setForgotMode(false);
  syncSignInFields();
}

$("#pwToggleMode").addEventListener("click", () => setPwMode(!pwSignupMode));

/* "Continue with Google" appears only once Supabase Auth's public settings
   say Google is switched on — never shown and then failing (they're read
   when the sign-in step shows, in show()). It's for staff, so it goes while
   a learner's username is typed; and while public sign-ups are closed it's
   for signing in only, so it isn't offered when creating an account. */
let authCfg = null;
function syncGoogleButton() {
  const on = !!authCfg?.external?.google && !(pwSignupMode && authCfg?.disable_signup)
    && !forgotOn && signInKind() !== "learner";
  $("#googleBtn").hidden = !on;
  $("#googleDivider").hidden = !on;
}

// ---- self-service password reset (emails a link) ----
const forgotForm = $("#forgotForm");
const forgotError = $("#forgotError");

function setForgotMode(on) {
  forgotOn = on;
  signInForm.hidden = on;
  $("#pwFootLinks").hidden = on;
  forgotForm.hidden = !on;
  $("#forgotSent").hidden = true;
  forgotError.hidden = true;
  $("#forgotFootLinks").hidden = !on;
  syncGoogleButton();
  if (on) {
    const id = siId.value.trim();
    $("#fp_email").value = id.includes("@") ? id : "";
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

signInForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  siError.hidden = true;
  const id = siId.value.trim();
  const remember = $("#si_remember").checked;
  setRememberMe(remember);
  idSettled = true;
  syncSignInFields();
  if (signInKind() === "learner") await learnerSignIn(id, siSecret.value, remember);
  else await staffSignIn(id, siSecret.value, remember);
});

async function staffSignIn(email, password, remember) {
  const btn = $("#siSubmit");
  btn.disabled = true;
  btn.textContent = pwSignupMode ? "Creating…" : "Signing in…";
  try {
    if (pwSignupMode) {
      const reg = await registerStaff(email, password);
      if (reg.error && !reg.exists) {
        showSignInError(reg.error);
        return;
      }
      // reg.exists → fall through and just try to sign in
    }
    const res = await signInWithPassword(email, password);
    if (res.error) {
      showSignInError(pwSignupMode ? "Account is ready, but that password didn't sign you in. Try again." : res.error);
      return;
    }
    if (remember) {
      saveLastLogin(email);
      await offerToSaveCredential(email, password);
    } else {
      clearLastLogin();
    }
    show("loading");
    route(); // → the page for the role on the account
  } finally {
    btn.disabled = false;
    btn.textContent = pwSignupMode ? "Create account" : "Sign in";
  }
}

async function learnerSignIn(username, pin, remember) {
  username = username.toLowerCase();
  pin = pin.trim();
  if (!/^\d{4}$/.test(pin)) {
    showSignInError("A PIN is 4 numbers. Check it and try again.");
    return;
  }
  const btn = $("#siSubmit");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  const res = await learnerLogin(username, pin);
  btn.disabled = false;
  btn.textContent = "Sign in";
  if (res.error) {
    // Someone with an email account who typed only their name lands here too.
    showSignInError(/^wrong username or pin$/i.test(res.error)
      ? "Wrong username or PIN. (Staff: sign in with your email address.)"
      : res.error);
    siSecret.value = "";
    return;
  }
  // Only the username is remembered, never the PIN.
  if (remember) saveLastLogin(username); else clearLastLogin();
  location.href = DASHBOARD_PATH.learner;
}

// ---- staff: Google ----
$("#googleBtn").addEventListener("click", async () => {
  siError.hidden = true;
  setRememberMe($("#si_remember").checked);
  try {
    await signInWithGoogle();
  } catch (err) {
    showSignInError(friendlyError(err, "Couldn't start Google sign-in. Check your connection and try again."));
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
  showSignIn();
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
  showSignIn();
});

// ---- set a new password (from an emailed reset link) ----
$("#rpBack").addEventListener("click", async () => {
  await signOut().catch(() => {});
  showSignIn();
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
