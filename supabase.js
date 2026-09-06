/* ============================================================
   HPF Digital Learning Portal — Supabase client.
   Loaded from a CDN as an ES module, matching the rest of this static
   build (no build step). This project's own dedicated Supabase
   project — every table lives in the default `public` schema here,
   since there's no production data sharing this project to keep
   separate from.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
