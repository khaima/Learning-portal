/* ============================================================
   HPF Digital Learning Portal — Supabase connection settings.

   Same Supabase project as the production HPF-digital-portal-2026 app
   (only one exists on this account) — but every table this app touches
   lives in its own `learning_portal` Postgres schema, never `public`,
   so nothing here can read, write, or collide with the production
   portal's real data. supabase.js points the client at that schema.

   Both values below are safe to publish: access is controlled by the
   RLS policies on the learning_portal schema (see
   supabase/learning-portal-schema.sql), not by keeping the key secret.
   ============================================================ */

export const SUPABASE_URL = "https://zptupvyrwoeabncxabgj.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_7TjjWMCk6Hrc-nut_qLMoQ_YnJM1C93";
