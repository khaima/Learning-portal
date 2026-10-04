/* ============================================================
   HPF Digital Learning Portal — accounts and sessions.

   Two ways in:
   - Staff use an email + password. Accounts are made only by the `api`
     Edge Function (POST /auth/register, already confirmed — public
     sign-ups are off in Supabase Auth). The only emails are password
     reset links, sent by Supabase Auth through the portal's own mail
     sender (docs/AUTH.md). Google appears only when it's switched on.
   - Learners use a username + 4-digit PIN. Their teacher creates the
     account; the `api` Edge Function issues an opaque session token
     (stored as `hpf_learner_token`). No email, no Supabase Auth.

   The role and profile live server-side (`profiles` / `learners`) and
   are reached only through the `api` Edge Function.
   ============================================================ */

import { supabase, storedStaffUserId } from "./supabase.js";
import { setOwner, unsentCount, forgetThisDevice, isNetworkError } from "./sync.js";
import { getMeta, setMeta } from "./offline.js";
import { ApiError, rawRequest, learnerToken, setLearnerToken } from "./api.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { friendlyError, confirmDialog } from "./util.js";
import { workspacePage } from "./navigation.js";

/** Where each role lands after signing in: its own workspace (navigation.js). */
export const DASHBOARD_PATH = {
  teacher: "teacher.html",
  learner: "learner.html",
  school_leader: "leader.html",
  field_officer: "field.html",
  education_team: "education.html",
  me: "me.html",
  admin: "admin.html",
  super_admin: "platform.html",
};

/* ---- staff: email + password ---- */

/** Create a staff account (already email-confirmed, server-side). */
export async function registerStaff(email, password) {
  try {
    await rawRequest("POST", "/auth/register", { email: (email || "").trim(), password });
    return { ok: true };
  } catch (err) {
    return {
      error: friendlyError(err, "Could not create the account. Check your connection and try again."),
      exists: err instanceof ApiError && err.status === 409,
    };
  }
}

/** Sign in with an email + password. */
export async function signInWithPassword(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: (email || "").trim(),
    password: password || "",
  });
  if (error) {
    const msg = /invalid login credentials/i.test(error.message || "")
      ? "Wrong email or password."
      : error.message || "Could not sign in.";
    return { error: msg };
  }
  return { ok: true, session: data.session };
}

/** Supabase Auth's public settings (which sign-in providers are on,
    whether sign-ups are open) — fetched once per page, null if they
    can't be read. Nothing secret: it's the same for every visitor. */
let authSettingsOnce;
export function authSettings() {
  authSettingsOnce ??= fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY } })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  return authSettingsOnce;
}

/** Whether Google is switched on in Supabase Auth. Fails closed: if it
    can't be confirmed, the button isn't offered (index.js), rather than
    shown and then sending the visitor to an error page at supabase.co. */
export async function googleProviderEnabled() {
  return !!(await authSettings())?.external?.google;
}

/** Start a Google sign-in/sign-up. Redirects the whole page to Google.
    On return, index.js finishes the flow (exchangeCodeForSession) and
    routes as usual: a first-time Google account lands in onboarding, a
    returning one goes straight to its dashboard. */
export async function signInWithGoogle() {
  if (!(await googleProviderEnabled())) {
    throw new Error("Google sign-in isn't set up yet — use email and password instead.");
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

/** "Forgot password?" on the sign-in page: email yourself a "set a new
    password" link — the standard Supabase Auth recovery flow. (An
    administrator's "Send reset link" sends the same email from the server,
    POST /users/:id/reset-link, so it's audited.) redirectTo points at
    index.html with a `flow=recovery` flag so it reuses the exact origin +
    path already allow-listed for Google sign-in (Supabase's redirect-URL
    allow list ignores the query string, so this needs no extra Supabase
    dashboard configuration). index.js detects the flag on load and shows
    the "set a new password" step instead of routing to a dashboard. */
export async function sendPasswordResetLink(email) {
  const redirectTo = new URL("index.html?flow=recovery", window.location.href).href;
  const { error } = await supabase.auth.resetPasswordForEmail((email || "").trim(), { redirectTo });
  if (error) throw error;
}

/** Choose your own password (after a reset link or a temporary password,
    or from My profile). Goes through the API so a temporary password's
    "must change" is cleared and the change is audited. */
export async function changeMyPassword(password) {
  await rawRequest("POST", "/me/password", { password });
  cachedProfile = undefined;
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
    return { error: friendlyError(err, "Could not sign in. Check your connection and try again.") };
  }
}

/* ---- shared ---- */

let cachedProfile;

/* ---- signed in without a connection ----
   This device remembers who was signed in and their profile, so a
   dashboard still opens offline. Keyed by the session itself — a learner's
   token (hashed, never stored twice) or the staff account's id — so it only
   ever answers for the session that's actually here. */
async function sessionKey() {
  const lt = learnerToken();
  if (lt) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lt));
    return "L:" + [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const uid = storedStaffUserId();
  return uid ? `S:${uid}` : null;
}
async function rememberProfile(profile) {
  if (!profile?.id || profile.needsOnboarding) return;
  const key = await sessionKey().catch(() => null);
  if (key) await setMeta(`session:${key}`, { profile, savedAt: new Date().toISOString() });
  await setOwner(profile.id, profile.role);
}
async function profileOnThisDevice() {
  const key = await sessionKey().catch(() => null);
  const saved = key ? await getMeta(`session:${key}`) : null;
  if (!saved?.profile) return null;
  await setOwner(saved.profile.id, saved.profile.role);
  return { ...saved.profile, offline: true };
}
const unreachable = (err) => isNetworkError(err) || (err instanceof ApiError && err.status >= 500);

/** The signed-in actor's profile, or null. Cached for the page view.
    `{ needsOnboarding: true, email }` for staff who signed in but haven't
    onboarded. */
export async function getProfile({ force } = {}) {
  if (cachedProfile !== undefined && !force) return cachedProfile;
  if (!learnerToken()) {
    const { data, error } = await supabase.auth.getSession();
    if (!data.session) {
      // Offline with an expired token: it can't be refreshed now, but it's still this person's session.
      if (storedStaffUserId() && (!navigator.onLine || isNetworkError(error))) return (cachedProfile = await profileOnThisDevice());
      cachedProfile = null;
      return null;
    }
  }
  try {
    const res = await rawRequest("GET", "/me");
    cachedProfile = res.needsOnboarding
      ? { needsOnboarding: true, email: res.email }
      : res.profile;
    await rememberProfile(cachedProfile);
  } catch (err) {
    if (unreachable(err)) return (cachedProfile = await profileOnThisDevice());
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

/** One-time school pick for a teacher/head whose account predates school
    codes (profile.needsSchool). */
export async function setMySchool(schoolId) {
  const res = await rawRequest("PUT", "/me/school", { schoolId });
  cachedProfile = res.profile;
  return res.profile;
}

/* Signing out on a shared device forgets this account's offline copies and
   saved resources — but never work that hasn't been sent: that stays and
   goes the next time they sign in here. Returns false if they chose to stay. */
export async function signOut() {
  const unsent = unsentCount();
  if (unsent) {
    const ok = await confirmDialog({
      title: `${unsent} ${unsent === 1 ? "activity hasn't" : "activities haven't"} been sent yet`,
      body: "They stay on this device and are sent the next time you sign in here with a connection. Sign out anyway?",
      confirmLabel: "Sign out",
    });
    if (!ok) return false;
  }
  const key = await sessionKey().catch(() => null);
  if (key) await setMeta(`session:${key}`, null);
  await forgetThisDevice();
  const lt = learnerToken();
  cachedProfile = null;
  if (lt) {
    await rawRequest("POST", "/learner/logout", { token: lt }).catch(() => {});
    setLearnerToken(null);
    return true;
  }
  await supabase.auth.signOut().catch(() => {});
  return true;
}

/* Call at the top of every dashboard. Async: checks the real session and
   the server-side profile, and sends anyone who isn't signed in, isn't
   onboarded, isn't active yet (pending approval, suspended…), still has
   to pick their school or replace a temporary password, or is the wrong
   role back to the front door
   (which shows them the right step). `role` may be one role or a list.
   This only decides which page to show — the API checks every request. */
export async function requireRole(role) {
  const roles = Array.isArray(role) ? role : [role];
  const profile = await getProfile();
  const status = profile?.status ?? "active";
  if (!profile || profile.needsOnboarding || profile.needsSchool || profile.mustChangePassword || status !== "active") {
    location.href = "index.html";
    return null;
  }
  // Signed in, but this isn't their workspace: their own one instead (the
  // page address comes along, and their menu decides whether it's theirs).
  if (!roles.includes(profile.role)) {
    location.replace(workspacePage(profile.role) + location.hash);
    return null;
  }
  return profile;
}

/* Join through an administrator's invitation link (index.html?invite=…).
   The role and placement come from the invitation on the server. */
export async function getInvitation(token) {
  const res = await rawRequest("GET", `/invitations/${encodeURIComponent(token)}`);
  return res.invitation;
}
export async function acceptInvitation(token, fields) {
  const res = await rawRequest("POST", "/me/accept-invite", { token, ...fields });
  cachedProfile = res.profile;
  return res.profile;
}
