/* ============================================================
   HPF Digital Learning Portal — Supabase Auth client (loaded on demand
   by supabase.js getAuth()).

   Only @supabase/auth-js, not all of supabase-js: the portal uses Supabase
   for signing in and nothing else (data goes through the api Edge
   Function), and the full library is twice the size — it matters on a
   slow school connection. Built exactly as supabase-js 2.117.2's
   createClient() builds its auth client, with the same storage key, so
   existing sessions carry on.
   ============================================================ */

import { AuthClient } from "@supabase/auth-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import { rememberableStorage, SESSION_KEY } from "./supabase.js";

export const auth = new AuthClient({
  url: `${SUPABASE_URL}/auth/v1`,
  headers: { Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`, apikey: SUPABASE_PUBLISHABLE_KEY },
  storageKey: SESSION_KEY,
  storage: rememberableStorage,
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: false, // index.js handles recovery and OAuth links itself
  flowType: "implicit",
  hasCustomAuthorizationHeader: false,
});
