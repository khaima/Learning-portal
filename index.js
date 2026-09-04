import { $, $$ } from "./util.js";
import { signIn, signUp, currentUser } from "./auth.js";

const DASHBOARD_PATH = { teacher: "teacher.html", learner: "learner.html" };

// Already signed in? Go straight to the right dashboard rather than
// showing the sign-in form again.
const existing = currentUser();
if (existing && DASHBOARD_PATH[existing.role]) {
  location.href = DASHBOARD_PATH[existing.role];
}

let selectedRole = "teacher";
const roleLabelEls = $$("[data-role-label]");
const signupRoleLabelEls = $$("[data-signup-role-label]");
const roleCards = $$(".role-card");

function setRole(role) {
  selectedRole = role;
  roleCards.forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.role === role)));
  const label = role === "learner" ? "Learner" : "Teacher";
  roleLabelEls.forEach((el) => (el.textContent = label));
  signupRoleLabelEls.forEach((el) => (el.textContent = label));
  $("#su_grade_field").hidden = role !== "learner";
}
roleCards.forEach((c) => c.addEventListener("click", () => setRole(c.dataset.role)));
setRole("teacher");

// ---- login ----
const loginForm = $("#loginForm");
const loginError = $("#loginError");
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const fd = new FormData(loginForm);
  const res = signIn(fd.get("username"), fd.get("password"));
  if (res.error) {
    loginError.textContent = res.error;
    loginError.hidden = false;
    return;
  }
  if (res.user.role !== selectedRole) {
    loginError.textContent = `That account is a ${res.user.role === "learner" ? "Learner" : "Teacher"} — switch the role above and try again.`;
    loginError.hidden = false;
    return;
  }
  location.href = DASHBOARD_PATH[res.user.role];
});

$$("[data-fill]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const role = btn.dataset.fill;
    setRole(role);
    $("#li_user").value = role === "teacher" ? "grace.mwangi" : "naomi.k";
    $("#li_pw").value = "demo1234";
  })
);

// ---- mode switch (login <-> signup) ----
const modeLogin = $("#modeLogin");
const modeSignup = $("#modeSignup");
$("#toSignup").addEventListener("click", () => {
  modeLogin.hidden = true;
  modeSignup.hidden = false;
});
$("#toLogin").addEventListener("click", () => {
  modeSignup.hidden = true;
  modeLogin.hidden = false;
});

// ---- sign up ----
const signupForm = $("#signupForm");
const signupError = $("#signupError");
signupForm.addEventListener("submit", (e) => {
  e.preventDefault();
  signupError.hidden = true;
  const fd = new FormData(signupForm);
  const res = signUp({
    fullName: fd.get("fullName"),
    username: fd.get("username"),
    password: fd.get("password"),
    school: fd.get("school"),
    county: fd.get("county"),
    grade: fd.get("grade"),
    role: selectedRole,
  });
  if (res.error) {
    signupError.textContent = res.error;
    signupError.hidden = false;
    return;
  }
  location.href = DASHBOARD_PATH[res.user.role];
});
