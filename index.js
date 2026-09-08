import { $, $$ } from "./util.js";
import { supabase } from "./supabase.js";
import {
  DASHBOARD_PATH, registerStaff, signInWithPassword, learnerLogin,
  getProfile, createProfile, signOut,
} from "./auth.js";
import { learnerToken } from "./api.js";
import { ROLES } from "./data.js";

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
const PENDING_ROLE_KEY = "hpf_pending_role";

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

/* ---- decide which step to show on load ---- */
async function route() {
  const hasLearner = !!learnerToken();
  if (!hasLearner) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) { show("role"); return; }
  }
  const profile = await getProfile({ force: true });
  if (profile && !profile.needsOnboarding) {
    goToDashboard(profile.role);
    return;
  }
  if (hasLearner) { show("role"); return; } // stale learner token, cleared by getProfile
  // Staff signed in but not onboarded yet.
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
      show("learner");
      $("#ln_user").focus();
      return;
    }
    setPendingRole(role);
    $("#pwRoleLabel").textContent = ROLE_LABEL[role] || role;
    setPwMode(false);
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
  const btn = learnerForm.querySelector("[type=submit]");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  const res = await learnerLogin($("#ln_user").value, $("#ln_pin").value);
  btn.disabled = false;
  btn.textContent = "Sign in";
  if (res.error) {
    learnerError.textContent = res.error;
    learnerError.hidden = false;
    $("#ln_pin").value = "";
    return;
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
    show("loading");
    route();
  } finally {
    btn.disabled = false;
    btn.textContent = pwSignupMode ? "Create account" : "Sign in";
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

route();
