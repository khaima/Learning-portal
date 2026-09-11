import { $, $$ } from "./util.js";
import { supabase, setRememberMe, getRememberMe } from "./supabase.js";
import {
  DASHBOARD_PATH, registerStaff, signInWithPassword, signInWithGoogle,
  learnerLogin, getProfile, createProfile, signOut,
} from "./auth.js";
import { learnerToken } from "./api.js";
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
function loadLastLearnerUsername() {
  try { return localStorage.getItem(LAST_LEARNER_KEY) || ""; } catch { return ""; }
}
function saveLastLearnerUsername(username) {
  try { localStorage.setItem(LAST_LEARNER_KEY, username); } catch { /* ignore */ }
}
function clearLastLearnerUsername() {
  try { localStorage.removeItem(LAST_LEARNER_KEY); } catch { /* ignore */ }
}

const steps = {
  loading: $("#stepLoading"),
  role: $("#stepRole"),
  learner: $("#stepLearner"),
  password: $("#stepPassword"),
  onboard: $("#stepOnboard"),
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

/* ---- decide which step to show on load ---- */
async function route() {
  const hasLearner = !!learnerToken();
  if (!hasLearner) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) { show("role"); return; }
  }
  const profile = await getProfile({ force: true });
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
  if (remember) saveLastLearnerUsername(username);
  else clearLastLearnerUsername();
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
    ? "Pick a password you'll remember — there's no email reset."
    : "Enter your email and password.";
  $("#pwSubmit").textContent = signup ? "Create account" : "Sign in";
  $("#pw_pass").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  $("#pwToggleMode").textContent = signup
    ? "Already have an account? Sign in"
    : "New here? Create an account";
  pwError.hidden = true;
}

$("#pwToggleMode").addEventListener("click", () => setPwMode(!pwSignupMode));

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
    if (remember) saveLastStaffLogin(pendingRole(), email);
    else clearLastStaffLogin();
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
    pwError.textContent = err?.message || "Couldn't start Google sign-in.";
    pwError.hidden = false;
  }
});

// ---- onboarding (staff only) ----
let selectedRole = "teacher";
const roleCards = $$("#roleGrid .role-card");
function setOnboardRole(role) {
  selectedRole = role;
  roleCards.forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.role === role)));
  $("#ob_grade_field").hidden = role !== "learner";
}
roleCards.forEach((c) => c.addEventListener("click", () => setOnboardRole(c.dataset.role)));

const onboardForm = $("#onboardForm");
const onboardError = $("#onboardError");
onboardForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  onboardError.hidden = true;
  const btn = onboardForm.querySelector("[type=submit]");
  const fd = new FormData(onboardForm);
  btn.disabled = true;
  try {
    const profile = await createProfile({
      fullName: fd.get("fullName"),
      role: selectedRole,
      school: fd.get("school"),
      county: fd.get("county"),
      grade: fd.get("grade"),
    });
    goToDashboard(profile.role);
  } catch (err) {
    btn.disabled = false;
    onboardError.textContent = err?.message || "Could not create your account.";
    onboardError.hidden = false;
  }
});

$("#onboardSignOut").addEventListener("click", async () => {
  await signOut();
  show("role");
});

(async () => {
  await consumeOAuthRedirect();
  route();
})();
