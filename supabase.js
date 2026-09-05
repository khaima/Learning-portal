/* ============================================================
   HPF Digital Learning Portal — Supabase client.
   Loaded from a CDN as an ES module, matching the rest of this static
   build (no build step). Every call this client makes is scoped to the
   `learning_portal` schema — never `public`, which is where the
   production HPF-digital-portal-2026 app's real tables live.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  db: { schema: "learning_portal" },
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
