import { $, $$, friendlyError } from "./util.js";
import { supabase, setRememberMe, getRememberMe } from "./supabase.js";
import {
  DASHBOARD_PATH, registerStaff, signInWithPassword, signInWithGoogle,
  learnerLogin, getProfile, createProfile, setMySchool, signOut, sendPasswordResetLink,
} from "./auth.js";
import { learnerToken } from "./api.js";
import { watchSchools, wireSchoolPicker } from "./store.js";
import { ROLES } from "./data.js";

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
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
   actually makes it autofill email+password (or username+PIN) next time
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

/* Same rotating taglines as the main HPF portal's hero. */
const HERO_QUOTES = [
  "When actions flow from the heart.",
  "When word inspires but only action counts.",
  "When compassion is lived, not just felt.",
  "Change the future. Build the school.",
];

/* Decorative hero background: cross-fades between photo slides and
   swaps the tagline every 4s, purely visual — left alone for
   prefers-reduced-motion. */
(function wireHeroBackground() {
  const slides = $$(".hero-bg-slide");
  const quoteEl = $("[data-hero-quote]");
  if (slides.length < 2 && !quoteEl) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let i = 0;
  let qi = 0;
  setInterval(() => {
    if (slides.length > 1) {
      i = (i + 1) % slides.length;
      slides.forEach((s, k) => s.classList.toggle("is-active", k === i));
    }
    if (quoteEl) {
      qi = (qi + 1) % HERO_QUOTES.length;
      quoteEl.classList.add("is-swapping");
      setTimeout(() => {
        quoteEl.textContent = HERO_QUOTES[qi];
        quoteEl.classList.remove("is-swapping");
      }, 600);
    }
  }, 4000);
})();

const steps = {
  loading: $("#stepLoading"),
  role: $("#stepRole"),
  learner: $("#stepLearner"),
  password: $("#stepPassword"),
  resetPassword: $("#stepResetPassword"),
  onboard: $("#stepOnboard"),
  school: $("#stepSchool"),
};
function show(name) {
  for (const [k, el] of Object.entries(steps)) el.hidden = k !== name;
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
    await supabase.auth.exchangeCodeForSession(code);
  } catch (err) {
    console.warn("Google sign-in failed:", err?.message);
  }
}

/* Land here from an emailed "reset password" link (education team →
   Users → Send reset link, see auth.js sendPasswordResetLink). Supabase
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
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) throw error;
      session = data.session;
    } else if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
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
      "This link is invalid or has expired. Ask your Education Team admin to send a new one.";
    $("#rpLinkErrorField").hidden = false;
    $("#resetPasswordForm").hidden = true;
    $("#rpBack").hidden = false;
    show("resetPassword");
    return true;
  }
}

/* ---- decide which step to show on load ---- */
async function route() {
  const hasLearner = !!learnerToken();
  if (!hasLearner) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) { show("role"); return; }
  }
  const profile = await getProfile({ force: true });
  if (profile?.needsSchool) {
    showSchoolStep(profile);
    return;
  }
  if (profile && !profile.needsOnboarding) {
    if (profile.email && getRememberMe()) saveLastStaffLogin(profile.role, profile.email);
    goToDashboard(profile.role);
    return;
  }
  if (hasLearner) { show("role"); return; } // stale learner token, cleared by getProfile
  // Staff signed in but not onboarded yet (first Google sign-in lands here too).
  if (profile?.email && getRememberMe()) saveLastStaffLogin(pendingRole(), profile.email);
  $("#onboardEmail").textContent = profile?.email || "you";
  setOnboardRole(pendingRole());
  show("onboard");
  loadOnboardSchools();
}

// ---- step 1: role ----
$$("#loginRoleGrid .role-card").forEach((card) =>
  card.addEventListener("click", () => {
    const role = card.dataset.role;
    if (role === "learner") {
      $("#learnerError").hidden = true;
      $("#ln_user").value = loadLastLearnerUsername();
      show("learner");
      $("#ln_user").focus();
      return;
    }
    setPendingRole(role);
    $("#pwRoleLabel").textContent = ROLE_LABEL[role] || role;
    setPwMode(false);
    const last = loadLastStaffLogin();
    $("#pw_email").value = last && last.role === role ? last.email : "";
    show("password");
    $("#pw_email").focus();
  })
);

$("#changeRole").addEventListener("click", () => show("role"));
$("#learnerBack").addEventListener("click", () => show("role"));

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
  if (remember) {
    saveLastLearnerUsername(username);
    await offerToSaveCredential(username, $("#ln_pin").value);
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
  $("#pwToggleMode").textContent = signup
    ? "Already have an account? Sign in"
    : "New here? Create an account";
  pwError.hidden = true;
  setForgotMode(false);
}

$("#pwToggleMode").addEventListener("click", () => setPwMode(!pwSignupMode));

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
function loadOnboardSchools() {
  $("#ob_county").innerHTML = `<option value="">Loading…</option>`;
  $("#ob_school").innerHTML = `<option value="">Loading…</option>`;
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
    goToDashboard(profile.role);
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
function showSchoolStep(profile) {
  show("school");
  schoolError.hidden = true;
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
    const { error } = await supabase.auth.updateUser({ password: p1 });
    if (error) throw error;
    // Already signed in as the recovered account — straight to their dashboard.
    await route();
  } catch (e2) {
    err.textContent = e2?.message || "Could not update the password.";
    err.hidden = false;
    btn.disabled = false;
  }
});

(async () => {
  if (await consumePasswordRecovery()) return;
  await consumeOAuthRedirect();
  route();
})();
