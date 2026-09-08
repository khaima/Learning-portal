import { $, $$ } from "./util.js";
import { supabase } from "./supabase.js";
import {
  DASHBOARD_PATH, sendMagicLink, getProfile, createProfile, signOut,
} from "./auth.js";
import { ROLES } from "./data.js";

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
const PENDING_ROLE_KEY = "hpf_pending_role";

const steps = {
  loading: $("#stepLoading"),
  role: $("#stepRole"),
  email: $("#stepEmail"),
  sent: $("#stepSent"),
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

/* ---- decide which step to show on load ----
   detectSessionInUrl (see supabase.js) consumes the magic-link token
   before this runs, so getSession() already reflects a fresh sign-in. */
async function route() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) { show("role"); return; }
  const profile = await getProfile({ force: true });
  if (profile && !profile.needsOnboarding) {
    goToDashboard(profile.role);
    return;
  }
  // Signed in but no profile yet — onboard, pre-filled with the role
  // they picked before signing in.
  $("#onboardEmail").textContent = profile?.email || data.session.user.email || "you";
  setOnboardRole(pendingRole());
  show("onboard");
}

// ---- step 1: role ----
$$("#loginRoleGrid .role-card").forEach((card) =>
  card.addEventListener("click", () => {
    const role = card.dataset.role;
    setPendingRole(role);
    $("#emailRoleLabel").textContent = ROLE_LABEL[role] || role;
    show("email");
    $("#email").focus();
  })
);

$("#changeRole").addEventListener("click", () => show("role"));

// ---- step 2: email ----
const emailForm = $("#emailForm");
const emailError = $("#emailError");
emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  emailError.hidden = true;
  const email = $("#email").value.trim();
  const btn = emailForm.querySelector("[type=submit]");
  btn.disabled = true;
  btn.textContent = "Sending…";
  const res = await sendMagicLink(email, `${location.origin}${location.pathname}`);
  btn.disabled = false;
  btn.textContent = "Email me a sign-in link";
  if (res.error) {
    emailError.textContent = res.error;
    emailError.hidden = false;
    return;
  }
  $("#sentTo").textContent = email;
  show("sent");
});

$("#tryDifferent").addEventListener("click", () => {
  $("#email").value = "";
  show("email");
});

// ---- onboarding ----
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
