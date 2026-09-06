/* ============================================================
   HPF Digital Learning Portal — Supabase connection settings.

   Its own, separate Supabase project — genuinely a different system
   from the production HPF-digital-portal-2026 app, not just a
   different schema in the same project. Nothing here can read, write,
   or collide with the production portal's real data, because there is
   no shared project at all anymore.

   Both values below are safe to publish: access is controlled by the
   RLS policies on these tables (see supabase-schema.sql), not by
   keeping the key secret.
   ============================================================ */

export const SUPABASE_URL = "https://fwpqytrdlmxymvegvgji.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_oP17Qvcq_jOzcZGJyh8UVw_paLVL9_v";
