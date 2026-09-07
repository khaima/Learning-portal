/* ============================================================
   HPF Digital Learning Portal — connection settings.

   Its own, separate Supabase project — a different system from the
   production HPF-digital-portal-2026 app.

   The two values below are safe to publish: the publishable key can only
   talk to Supabase Auth, and every table is locked down (deny-all RLS,
   privileges revoked). All data goes through the `api` Edge Function,
   which authorises each request server-side.
   ============================================================ */

export const SUPABASE_URL = "https://fwpqytrdlmxymvegvgji.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_oP17Qvcq_jOzcZGJyh8UVw_paLVL9_v";

/** Base URL of the backend API (the `api` Edge Function). */
export const API_BASE = `${SUPABASE_URL}/functions/v1/api`;
