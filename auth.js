/* ============================================================
   HPF Digital Learning Portal — accounts and sessions.

   Real Supabase Auth now. Sign-in is a magic link: enter an email,
   click the link, land back with a real JWT session. The account's
   role and profile live in `public.profiles`, reachable only through
   the `api` Edge Function — never trusted from the browser or from a
   JWT claim.
   ============================================================ */

import { supabase } from "./supabase.js";
import { rawRequest, apiGet } from "./api.js";

export const DASHBOARD_PATH = {
  teacher: "teacher.html",
  learner: "learner.html",
  school_leader: "leader.html",
  field_officer: "field.html",
  education_team: "education.html",
};

/** Send a one-time sign-in link to `email`, returning to `redirectTo`. */
export async function sendMagicLink(email, redirectTo) {
  const { error } = await supabase.auth.signInWithOtp({
    email: (email || "").trim(),
    options: {
      shouldCreateUser: true,
      emailRedirectTo: redirectTo || `${location.origin}${location.pathname}`,
    },
  });
  return error ? { error: error.message } : { ok: true };
}

let cachedProfile;

/** The signed-in user's profile, or null. Cached for the page view.
    Returns `{ needsOnboarding: true, email }` if signed in but not yet
    onboarded. */
export async function getProfile({ force } = {}) {
  if (cachedProfile !== undefined && !force) return cachedProfile;
  const { data } = await supabase.auth.getSession();
  if (!data.session) { cachedProfile = null; return null; }
  try {
    const res = await rawRequest("GET", "/me");
    cachedProfile = res.needsOnboarding
      ? { needsOnboarding: true, email: res.email }
      : res.profile;
  } catch {
    cachedProfile = null;
  }
  return cachedProfile;
}

/** Create the profile for a freshly signed-in user (onboarding step). */
export async function createProfile(fields) {
  const res = await rawRequest("POST", "/me", fields);
  cachedProfile = res.profile;
  return res.profile;
}

export async function signOut() {
  cachedProfile = null;
  await supabase.auth.signOut().catch(() => {});
}

/* Call at the top of every dashboard. Async now: it checks the real
   session and the server-side profile, and sends anyone who isn't
   signed in, isn't onboarded, or is the wrong role back to the front
   door. Returns the profile on success, null after redirecting. */
export async function requireRole(role) {
  const profile = await getProfile();
  if (!profile || profile.needsOnboarding || profile.role !== role) {
    location.href = "index.html";
    return null;
  }
  return profile;
}
