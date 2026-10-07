/* ============================================================
   HPF Digital Learning Portal — connection settings.

   Its own, separate Supabase project — a different system from the
   production HPF-digital-portal-2026 app.

   Which project a build talks to — production, or staging for Vercel's
   preview deployments — is decided when it's built, from
   environments.json (vite.config.js; docs/OPERATIONS.md).

   The values are safe to publish: the publishable key can only talk to
   Supabase Auth, and every table is locked down (deny-all RLS,
   privileges revoked). All data goes through the `api` Edge Function,
   which authorises each request server-side.
   ============================================================ */

export const SUPABASE_URL = import.meta.env.HPF_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY = import.meta.env.HPF_PUBLISHABLE_KEY;
/** "production" or "staging". */
export const TARGET = import.meta.env.HPF_TARGET;

/** Base URL of the backend API (the `api` Edge Function). */
export const API_BASE = `${SUPABASE_URL}/functions/v1/api`;
