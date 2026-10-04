/* ============================================================
   Leaked-password check — the portal's own, for every password it sets.

   Supabase Auth's "leaked password protection" needs the Pro plan, and in
   any case every password here is set through the api Edge Function
   (sign-up, choosing your own after a reset link or a temporary password,
   My profile). So the function checks HaveIBeenPwned's Pwned Passwords
   list itself, the same way Supabase does: k-anonymity — only the first 5
   characters of the password's SHA-1 leave the server, never the password
   or its full hash; the reply is padded so its size gives nothing away.

   If the list can't be reached the check is skipped (null), as Supabase
   Auth does by default: an outage at haveibeenpwned.com mustn't stop
   people choosing a password.
   ============================================================ */

const RANGE_API = "https://api.pwnedpasswords.com/range/";

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** How many times this password appears in known breaches (0 = none), or null if the list couldn't be checked. */
export async function timesPwned(password: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const hash = await sha1Hex(password);
    const res = await fetchImpl(RANGE_API + hash.slice(0, 5), {
      headers: { "Add-Padding": "true", "User-Agent": "hpf-learning-portal" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const suffix = hash.slice(5);
    for (const line of (await res.text()).split("\n")) {
      const [s, count] = line.trim().split(":");
      if (s === suffix) return Number(count) || 0; // padding lines carry a count of 0
    }
    return 0;
  } catch {
    return null;
  }
}

export const PWNED_MESSAGE = "That password has appeared in a data breach elsewhere, so it isn't safe. Choose a different one.";
