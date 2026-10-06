/* ============================================================
   HPF Digital Learning Portal — backend API client.

   Thin wrapper over fetch() to the `api` Edge Function. Attaches the
   caller's token as a Bearer — a learner's PIN-issued session token if
   one is stored, otherwise the staff Supabase Auth token. The database
   is not reachable from the browser — this is the only data path.

   Offline: what the server sent for the pages people work in is kept on
   this device (offline.js) and shown when there's no connection; work
   that can be done offline goes through sync.js, which queues it.
   ============================================================ */

import { API_BASE } from "./config.js";
import { getAuth, accessToken, rememberableStorage, storedStaffUserId } from "./supabase.js";
import { currentOwner, isDirty, isNetworkError, noteNetwork } from "./sync.js";
import { getCached, putCached } from "./offline.js";

export const LEARNER_TOKEN_KEY = "hpf_learner_token";

/* Same "remember me" storage as the staff session (see supabase.js) —
   set setRememberMe() before learnerLogin() so the token lands in the
   right place. */
export function learnerToken() {
  return rememberableStorage.getItem(LEARNER_TOKEN_KEY);
}
export function setLearnerToken(token) {
  if (token) rememberableStorage.setItem(LEARNER_TOKEN_KEY, token);
  else rememberableStorage.removeItem(LEARNER_TOKEN_KEY);
}

/** No connection (or it dropped). status 0, so friendlyError() shows the message. */
export class OfflineError extends Error {
  constructor(message = "You're offline. This needs a connection — try again when you're back online.") {
    super(message);
    this.name = "OfflineError";
    this.offline = true;
    this.status = 0;
  }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || body?.message || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.body = body || {};
    this.needsOnboarding = status === 428 || !!body?.needsOnboarding;
    // Signed in with a temporary password: choosing their own comes first.
    this.mustChangePassword = status === 403 && !!body?.mustChangePassword;
  }
}

async function authHeader() {
  const lt = learnerToken();
  if (lt) return { Authorization: `Bearer hpl_${lt}` };
  const t = await accessToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/* Low-level call — never redirects, lets the caller handle every status.
   index.js uses this for the sign-in / onboarding flow. */
export async function rawRequest(method, path, body, { idempotencyKey, timeoutMs } = {}) {
  if (!navigator.onLine) throw new OfflineError();
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        ...(await authHeader()),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl?.signal,
    });
  } catch (err) {
    noteNetwork(false);
    throw isNetworkError(err) ? new OfflineError("Couldn't reach the portal — check your connection and try again.") : err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  noteNetwork(true);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* App-level calls — on an expired session or a missing profile, bounce
   to the front door rather than showing a broken dashboard. */
async function request(method, path, body) {
  try {
    return await rawRequest(method, path, body);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.needsOnboarding || err.mustChangePassword)) {
      if (err.status === 401) {
        setLearnerToken(null);
        if (storedStaffUserId()) await getAuth().then((a) => a.signOut()).catch(() => {});
      }
      if (!location.pathname.endsWith("index.html") && location.pathname !== "/") {
        location.href = "index.html";
      }
    }
    throw err;
  }
}

/* Pages people work in offline: what the server sends for these is kept on
   the device (per account) and shown when there's no connection. Dashboards
   of figures for the Education Team aren't — they're only meaningful live. */
const KEEP_OFFLINE = [
  /^\/schools$/, /^\/subjects$/, /^\/academic-years$/,
  /^\/learner\/assignments(\/[^/?]+)?$/, /^\/results(\?.*)?$/,
  /^\/library(\?.*)?$/, /^\/library\/folders$/, /^\/library\/interactions\/mine$/,
  /^\/forms$/, /^\/responses$/, /^\/field-reports$/, /^\/kobo\/my-surveys$/,
  /^\/learners(\?.*)?$/, /^\/classes(\?.*)?$/, /^\/classes\/[^/?]+$/,
  /^\/assignments(\?.*)?$/, /^\/assignments\/[^/?]+$/,
  /^\/submissions(\?.*)?$/, /^\/submissions\/[^/?]+$/,
  /^\/school\/overview$/, /^\/sync\/status$/, /^\/notifications$/,
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function apiGet(path) {
  const owner = currentOwner();
  if (!owner || !KEEP_OFFLINE.some((re) => re.test(path))) return request("GET", path);
  const cached = await getCached(owner, path);
  // Changes made here that haven't synced yet are part of the page: keep showing them.
  if (cached && isDirty(path)) return cached.data;
  if (!navigator.onLine) {
    if (cached) return cached.data;
    throw new OfflineError("You're offline, and this wasn't saved on this device yet. Open it once while online to have it offline.");
  }
  const fresh = request("GET", path).then(async (data) => {
    if (!isDirty(path)) await putCached(owner, path, data);
    return data;
  });
  if (!cached) return fresh;
  fresh.catch(() => {});
  // A slow connection shouldn't hold the page up: after a few seconds show the
  // copy on this device; the fresh one still lands in it for next time.
  return Promise.race([
    fresh.catch((err) => { if (isNetworkError(err)) return cached.data; throw err; }),
    wait(8000).then(() => cached.data),
  ]);
}

/** Server copy of a page, written into this device's offline copy (sync.js handlers). */
export async function keepOffline(path, data) {
  const owner = currentOwner();
  if (owner) await putCached(owner, path, data);
}
export async function offlineCopy(path) {
  return (await getCached(currentOwner(), path))?.data ?? null;
}

export const apiSend = (method, path, body) => request(method, path, body);
