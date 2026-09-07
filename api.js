/* ============================================================
   HPF Digital Learning Portal — backend API client.

   Thin wrapper over fetch() to the `api` Edge Function. Attaches the
   Supabase Auth access token as a Bearer on every call. The database is
   not reachable from the browser — this is the only data path.
   ============================================================ */

import { API_BASE } from "./config.js";
import { supabase, accessToken } from "./supabase.js";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || body?.message || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.body = body || {};
    this.needsOnboarding = status === 428 || !!body?.needsOnboarding;
  }
}

/* Low-level call — never redirects, lets the caller handle every status.
   index.js uses this for the sign-in / onboarding flow. */
export async function rawRequest(method, path, body) {
  const token = await accessToken();
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
      if (err.status === 401) await supabase.auth.signOut().catch(() => {});
      if (!location.pathname.endsWith("index.html") && location.pathname !== "/") {
        location.href = "index.html";
      }
    }
    throw err;
  }
}

export const apiGet = (path) => request("GET", path);
export const apiSend = (method, path, body) => request(method, path, body);
