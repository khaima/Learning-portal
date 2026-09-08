/* ============================================================
   HPF Digital Learning Portal — backend API client.

   Thin wrapper over fetch() to the `api` Edge Function. Attaches the
   caller's token as a Bearer — a learner's PIN-issued session token if
   one is stored, otherwise the staff Supabase Auth token. The database
   is not reachable from the browser — this is the only data path.
   ============================================================ */

import { API_BASE } from "./config.js";
import { supabase, accessToken } from "./supabase.js";

export const LEARNER_TOKEN_KEY = "hpf_learner_token";

export function learnerToken() {
  try { return localStorage.getItem(LEARNER_TOKEN_KEY); } catch { return null; }
}
export function setLearnerToken(token) {
  try {
    if (token) localStorage.setItem(LEARNER_TOKEN_KEY, token);
    else localStorage.removeItem(LEARNER_TOKEN_KEY);
  } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || body?.message || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.body = body || {};
    this.needsOnboarding = status === 428 || !!body?.needsOnboarding;
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
export async function rawRequest(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(await authHeader()),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
    if (err instanceof ApiError && (err.status === 401 || err.needsOnboarding)) {
      if (err.status === 401) {
        setLearnerToken(null);
        await supabase.auth.signOut().catch(() => {});
      }
      if (!location.pathname.endsWith("index.html") && location.pathname !== "/") {
        location.href = "index.html";
      }
    }
    throw err;
  }
}

export const apiGet = (path) => request("GET", path);
export const apiSend = (method, path, body) => request(method, path, body);
