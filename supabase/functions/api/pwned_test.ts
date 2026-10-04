/**
 * The leaked-password check: only a 5-character hash prefix is sent, the
 * reply is matched on the rest, padding is ignored, and an outage skips
 * the check rather than blocking. No network — a stand-in fetch.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --config deno.json pwned_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { timesPwned } from "./pwned.ts";

// SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
const PASSWORD_SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

function rangeApi(body: string, status = 200) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const f = ((url: string, init: RequestInit) => {
    asked.push({ url, headers: init.headers as Record<string, string> });
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as typeof fetch;
  return { f, asked };
}

Deno.test("only the first 5 characters of the SHA-1 leave the server, with padding asked for", async () => {
  const { f, asked } = rangeApi(`${PASSWORD_SUFFIX}:9659365\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0`);
  assertEquals(await timesPwned("password", f), 9659365);
  assertEquals(asked.length, 1);
  assertEquals(asked[0].url, "https://api.pwnedpasswords.com/range/5BAA6");
  assertEquals(asked[0].headers["Add-Padding"], "true");
  assert(!new URL(asked[0].url).pathname.includes(PASSWORD_SUFFIX), "never the rest of the hash");
});

Deno.test("a password not in the list (or only in the padding) counts as 0", async () => {
  assertEquals(await timesPwned("password", rangeApi("0018A45C4D1DEF81644B54AB7F969B88D65:12\r\n").f), 0);
  assertEquals(await timesPwned("password", rangeApi(`${PASSWORD_SUFFIX}:0\r\n`).f), 0, "a padding line");
});

Deno.test("an outage skips the check instead of blocking", async () => {
  assertEquals(await timesPwned("password", rangeApi("", 503).f), null);
  const down = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
  assertEquals(await timesPwned("password", down), null);
});
