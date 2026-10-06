/* ============================================================
   HPF Digital Learning Portal — Supabase Storage client (loaded on
   demand by supabase.js getStorage()), for one thing: uploading a file
   to a signed upload URL the API has just issued (uploadToSignedUrl).

   Requests carry the same headers supabase-js's createClient() sent: the
   publishable key, and the signed-in staff member's access token as the
   Bearer (or the key, for a learner — the signed URL's token is what
   authorises the upload). A learner's upload never loads the sign-in
   library.
   ============================================================ */

import { StorageClient } from "@supabase/storage-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import { getAuth, storedStaffUserId } from "./supabase.js";

async function bearer() {
  if (!storedStaffUserId()) return SUPABASE_PUBLISHABLE_KEY;
  const { data } = await (await getAuth()).getSession();
  return data.session?.access_token ?? SUPABASE_PUBLISHABLE_KEY;
}

async function fetchWithAuth(input, init) {
  const headers = new Headers(init?.headers);
  if (!headers.has("apikey")) headers.set("apikey", SUPABASE_PUBLISHABLE_KEY);
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${await bearer()}`);
  return fetch(input, { ...init, headers });
}

export const storage = new StorageClient(`${SUPABASE_URL}/storage/v1`, {}, fetchWithAuth);
