/* ============================================================
   HPF Digital Learning Portal — accounts and sessions.

   Two ways in:
   - Staff (teacher / school head / field officer / education team) use
     real Supabase Auth: enter an email, get a 6-digit code.
   - Learners use a username + 4-digit PIN. Their teacher creates the
     account; the `api` Edge Function issues an opaque session token
     (stored as `hpf_learner_token`). No email, no Supabase Auth.

   The role and profile live server-side (`profiles` / `learners`) and
   are reached only through the `api` Edge Function.
   ============================================================ */

import { supabase } from "./supabase.js";
import { ApiError, rawRequest, learnerToken, setLearnerToken } from "./api.js";

export const DASHBOARD_PATH = {
  teacher: "teacher.html",
  learner: "learner.html",
  school_leader: "leader.html",
  field_officer: "field.html",
  education_team: "education.html",
};

function friendlyAuthError(error) {
  if (!error) return null;
  if (error.status === 429 || /rate limit/i.test(error.message || "")) {
    return "Too many requests. Wait a minute before trying again.";
  }
  return error.message || "Something went wrong.";
}

/* ---- staff: email + code ---- */

/** Email a one-time 6-digit code (and magic link) to `email`. */
export async function sendSignInEmail(email, redirectTo) {
  const { error } = await supabase.auth.signInWithOtp({
    email: (email || "").trim(),
    options: {
      shouldCreateUser: true,
      emailRedirectTo: redirectTo || `${location.origin}${location.pathname}`,
    },
  });
  return error ? { error: friendlyAuthError(error) } : { ok: true };
}

/** Verify the 6-digit code from the email and establish a session. */
export async function verifySignInCode(email, code) {
  const { data, error } = await supabase.auth.verifyOtp({
    email: (email || "").trim(),
    token: (code || "").trim(),
    type: "email",
  });
  if (error) return { error: friendlyAuthError(error) };
  return { ok: true, session: data.session };
}

/* ---- learners: username + PIN ---- */

export async function learnerLogin(username, pin) {
  try {
    const res = await rawRequest("POST", "/learner/login", {
      username: (username || "").trim().toLowerCase(),
      pin: (pin || "").trim(),
    });
    setLearnerToken(res.token);
    cachedProfile = res.learner;
    return { ok: true, learner: res.learner };
  } catch (err) {
    return { error: err?.body?.error || err?.message || "Could not sign in." };
  }
}

/* ---- shared ---- */

let cachedProfile;

/** The signed-in actor's profile, or null. Cached for the page view.
    `{ needsOnboarding: true, email }` for staff who signed in but haven't
    onboarded. */
export async function getProfile({ force } = {}) {
  if (cachedProfile !== undefined && !force) return cachedProfile;
  if (!learnerToken()) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) { cachedProfile = null; return null; }
  }
  try {
    const res = await rawRequest("GET", "/me");
    cachedProfile = res.needsOnboarding
      ? { needsOnboarding: true, email: res.email }
      : res.profile;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && learnerToken()) {
      setLearnerToken(null); // stale learner session
    }
    cachedProfile = null;
  }
  return cachedProfile;
}

/** Create the profile for a freshly signed-in staff user (onboarding). */
export async function createProfile(fields) {
  const res = await rawRequest("POST", "/me", fields);
  cachedProfile = res.profile;
  return res.profile;
}

export async function signOut() {
  const lt = learnerToken();
  cachedProfile = null;
  if (lt) {
    await rawRequest("POST", "/learner/logout", { token: lt }).catch(() => {});
    setLearnerToken(null);
    return;
  }
  await supabase.auth.signOut().catch(() => {});
}

/* Call at the top of every dashboard. Async: checks the real session and
   the server-side profile, and sends anyone who isn't signed in, isn't
   onboarded, or is the wrong role back to the front door. */
export async function requireRole(role) {
  const profile = await getProfile();
  if (!profile || profile.needsOnboarding || profile.role !== role) {
    location.href = "index.html";
    return null;
  }
  return profile;
}
