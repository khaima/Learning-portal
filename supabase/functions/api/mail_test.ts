/**
 * The invitation mailer: what is sent to each provider, and how refusals
 * are reported. No network — a stand-in fetch records the request.
 *
 *   cd supabase/functions/api
 *   deno test --allow-env --config deno.json mail_test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { invitationEmail, mailReady, sendMail } from "./mail.ts";

const KEY = "re_test_key_not_real";
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  return async () => {
    const before: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      before[k] = Deno.env.get(k);
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    }
  };
}
function recorder(status = 200, body: unknown = { id: "msg_1" }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  return { f, calls };
}
const MSG = { to: "new@school.org", subject: "S", html: "<p>H</p>", text: "T", replyTo: "admin@humanpractice.org" };

Deno.test("not set up: nothing is sent, and it says so", withEnv({ MAIL_PROVIDER: undefined, MAIL_API_KEY: undefined, MAIL_FROM: undefined }, async () => {
  assertEquals(mailReady(), false);
  const { f, calls } = recorder();
  const r = await sendMail(MSG, f);
  assertEquals(r.ok, false);
  assertEquals(calls.length, 0);
}));

Deno.test("half set up (no sender, or an unknown provider) counts as not set up", withEnv({ MAIL_PROVIDER: "resend", MAIL_API_KEY: KEY, MAIL_FROM: "" }, async () => {
  assertEquals(mailReady(), false);
  Deno.env.set("MAIL_FROM", "no-reply@humanpractice.org");
  Deno.env.set("MAIL_PROVIDER", "smtp");
  assertEquals(mailReady(), false);
}));

Deno.test("Resend: one POST with the key as a bearer token", withEnv({ MAIL_PROVIDER: "resend", MAIL_API_KEY: KEY, MAIL_FROM: "no-reply@humanpractice.org", MAIL_FROM_NAME: undefined }, async () => {
  assertEquals(mailReady(), true);
  const { f, calls } = recorder(200, { id: "re_msg" });
  assertEquals(await sendMail(MSG, f), { ok: true, id: "re_msg" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.resend.com/emails");
  assertEquals((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(String(calls[0].init.body));
  assertEquals(body.from, "HPF Digital Learning Portal <no-reply@humanpractice.org>");
  assertEquals(body.to, ["new@school.org"]);
  assertEquals([body.subject, body.html, body.text, body.reply_to], ["S", "<p>H</p>", "T", "admin@humanpractice.org"]);
}));

Deno.test("Brevo: api-key header and its own body shape", withEnv({ MAIL_PROVIDER: "brevo", MAIL_API_KEY: "xkeysib-test", MAIL_FROM: "no-reply@humanpractice.org", MAIL_FROM_NAME: "HPF" }, async () => {
  const { f, calls } = recorder(201, { messageId: "<b@x>" });
  assertEquals(await sendMail(MSG, f), { ok: true, id: "<b@x>" });
  assertEquals(calls[0].url, "https://api.brevo.com/v3/smtp/email");
  assertEquals((calls[0].init.headers as Record<string, string>)["api-key"], "xkeysib-test");
  const body = JSON.parse(String(calls[0].init.body));
  assertEquals(body.sender, { name: "HPF", email: "no-reply@humanpractice.org" });
  assertEquals(body.to, [{ email: "new@school.org" }]);
  assertEquals(body.replyTo, { email: "admin@humanpractice.org" });
}));

Deno.test("refusals are reported plainly, never with the key", withEnv({ MAIL_PROVIDER: "resend", MAIL_API_KEY: KEY, MAIL_FROM: "no-reply@humanpractice.org" }, async () => {
  let r = await sendMail(MSG, recorder(403, { message: "The humanpractice.org domain is not verified" }).f);
  assert(!r.ok && r.error.includes("not verified") && !r.error.includes(KEY), JSON.stringify(r));
  r = await sendMail(MSG, recorder(429, {}).f);
  assert(!r.ok && r.error.includes("limit"));
  const boom = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
  r = await sendMail(MSG, boom);
  assert(!r.ok && r.error.includes("couldn't reach"));
}));

Deno.test("the invitation email: the link, the role and place, the expiry — and nothing unescaped", () => {
  const m = invitationEmail({
    link: "https://khaima.github.io/Learning-portal/index.html?invite=abc_DEF-123",
    roleLabel: "Teacher", place: "Aitong Primary (NRK-001)", inviterName: "Grace <script>", expiresAt: "2026-10-18T09:00:00.000Z",
  });
  assertEquals(m.subject, "You're invited to the HPF Digital Learning Portal");
  for (const part of [m.html, m.text]) {
    assert(part.includes("https://khaima.github.io/Learning-portal/index.html?invite=abc_DEF-123"));
    assert(part.includes("Teacher") && part.includes("Aitong Primary (NRK-001)") && part.includes("18 October 2026"));
  }
  assert(m.html.includes("Grace &lt;script&gt;") && !m.html.includes("<script>"), "names are escaped");
  assert(!/<img\b/i.test(m.html), "no images");
});
