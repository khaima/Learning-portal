/* ============================================================
   HPF Digital Learning Portal — Supabase Auth client.

   Used for staff sign-in (email + password, or Google) and the session
   it returns. All data goes through the `api` Edge Function (see
   api.js) — the browser has no direct database access.

   "Remember me": a plain, always-on localStorage flag (`hpf_remember_me`)
   that says where the ACTUAL session token should live — localStorage
   when remembered (survives closing the browser) or sessionStorage when
   not (cleared when the tab/browser closes, same as a bank's "remember
   me" toggle). Call setRememberMe() right before a sign-in/sign-up/OAuth
   attempt so the token lands in the right place; rememberableStorage is
   reused by api.js for the learner PIN token so both sign-in paths
   behave the same way.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const REMEMBER_KEY = "hpf_remember_me";

export function getRememberMe() {
  try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch { return true; }
}
export function setRememberMe(on) {
  try { localStorage.setItem(REMEMBER_KEY, on ? "1" : "0"); } catch { /* ignore */ }
}

export const rememberableStorage = {
  getItem(key) {
    try { return (getRememberMe() ? localStorage : sessionStorage).getItem(key); } catch { return null; }
  },
  setItem(key, value) {
    try {
      if (getRememberMe()) { localStorage.setItem(key, value); sessionStorage.removeItem(key); }
      else { sessionStorage.setItem(key, value); localStorage.removeItem(key); }
    } catch { /* ignore */ }
  },
  removeItem(key) {
    try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch { /* ignore */ }
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storage: rememberableStorage,
  },
});

/** The current access token, or null. Attached as a Bearer by api.js. */
export async function accessToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
