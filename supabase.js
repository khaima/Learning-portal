/* ============================================================
   HPF Digital Learning Portal — Supabase Auth client.

   Used for ONE thing only: staff email + password sign-in and the
   session it returns. All data goes through the `api` Edge Function
   (see api.js) — the browser has no direct database access.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

/** The current access token, or null. Attached as a Bearer by api.js. */
export async function accessToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
