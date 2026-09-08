import { $, $$ } from "./util.js";
import { supabase } from "./supabase.js";
import {
  DASHBOARD_PATH, sendSignInEmail, verifySignInCode, getProfile, createProfile, signOut,
} from "./auth.js";
import { ROLES } from "./data.js";

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
const PENDING_ROLE_KEY = "hpf_pending_role";

const steps = {
  loading: $("#stepLoading"),
  role: $("#stepRole"),
  email: $("#stepEmail"),
  code: $("#stepCode"),
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
let signInEmail = "";

async function requestCode(email) {
  return sendSignInEmail(email, `${location.origin}${location.pathname}`);
}

emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  emailError.hidden = true;
  const email = $("#email").value.trim();
  const btn = emailForm.querySelector("[type=submit]");
  btn.disabled = true;
  btn.textContent = "Sending…";
  const res = await requestCode(email);
  btn.disabled = false;
  btn.textContent = "Email me a sign-in link";
  if (res.error) {
    emailError.textContent = res.error;
    emailError.hidden = false;
    return;
  }
  signInEmail = email;
  $("#codeSentTo").textContent = email;
  $("#code").value = "";
  show("code");
  $("#code").focus();
  startResendCooldown();
});

// ---- step 3: code ----
const codeForm = $("#codeForm");
const codeError = $("#codeError");
const resendBtn = $("#resendCode");

codeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  codeError.hidden = true;
  const code = $("#code").value.trim();
  const btn = codeForm.querySelector("[type=submit]");
  btn.disabled = true;
  btn.textContent = "Verifying…";
  const res = await verifySignInCode(signInEmail, code);
  if (res.error) {
    btn.disabled = false;
    btn.textContent = "Verify & sign in";
    codeError.textContent = res.error === "Something went wrong."
      ? "That code didn't work. Check it and try again, or resend."
      : res.error;
    codeError.hidden = false;
    return;
  }
  // Session established — route() sorts out dashboard vs onboarding.
  show("loading");
  route();
});

let resendTimer = null;
function startResendCooldown(seconds = 60) {
  clearInterval(resendTimer);
  let left = seconds;
  resendBtn.disabled = true;
  const tick = () => {
    resendBtn.textContent = left > 0 ? `Resend code (${left}s)` : "Resend code";
    if (left <= 0) { clearInterval(resendTimer); resendBtn.disabled = false; }
    left -= 1;
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

resendBtn.addEventListener("click", async () => {
  codeError.hidden = true;
  const res = await requestCode(signInEmail);
  if (res.error) {
    codeError.textContent = res.error;
    codeError.hidden = false;
    return;
  }
  startResendCooldown();
});

$("#tryDifferent").addEventListener("click", () => {
  $("#email").value = signInEmail;
  show("email");
  $("#email").focus();
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
  clearInterval(resendTimer);
  show("role");
});

route();
