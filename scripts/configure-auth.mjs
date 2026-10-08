#!/usr/bin/env node
/* ============================================================
   HPF Digital Learning Portal — production Supabase Auth settings.

   Sets, through the Supabase Management API (docs/AUTH.md):
   - the portal's own mail sender (custom SMTP: Resend, Brevo, or any
     SMTP server) and the HPF-branded "reset password" email
     (supabase/templates/recovery.html);
   - public sign-ups OFF — accounts are made only by the api Edge
     Function's POST /auth/register (and invitations / approval);
   - the portal's addresses on the redirect allow-list, so reset links
     come back to the portal (added to, never removed from);
   - the api Edge Function's mail secrets (MAIL_PROVIDER, MAIL_API_KEY,
     MAIL_FROM, MAIL_FROM_NAME), so the portal can email staff invitations
     through the same provider (Resend or Brevo — supabase/functions/api/mail.ts);
   - Supabase Auth's own leaked-password check, where the plan allows it
     (Pro and above). The portal checks every password it sets anyway
     (supabase/functions/api/pwned.ts), so on the Free plan it's skipped.

   Dry run by default: shows what would change, then stops. Nothing
   secret is ever printed — keys and passwords show only as "set".

     node --env-file=.env scripts/configure-auth.mjs              # dry run
     node --env-file=.env scripts/configure-auth.mjs --apply      # make the change
     node --env-file=.env scripts/configure-auth.mjs --signups-only --apply
     node scripts/configure-auth.mjs --check                      # public settings only, no token

   Needs Node 20.6+ (built-in fetch and --env-file). No packages.

   Environment (see docs/AUTH.md; keep them in .env, which git ignores):
     SUPABASE_ACCESS_TOKEN     personal access token (supabase.com/dashboard/account/tokens)
     SUPABASE_PROJECT_REF      default fwpqytrdlmxymvegvgji
     SMTP_PROVIDER             resend | brevo | custom
       resend:  RESEND_API_KEY
       brevo:   BREVO_SMTP_LOGIN, BREVO_SMTP_KEY, and BREVO_API_KEY for invitation emails
       custom:  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
     SMTP_SENDER_EMAIL         e.g. no-reply@humanpractice.org (a domain verified with the provider)
     SMTP_SENDER_NAME          default "HPF Digital Learning Portal"
     SMTP_RATE_LIMIT_PER_HOUR  emails per hour, default 30
     PORTAL_URLS               comma-separated portal addresses for the redirect allow-list
                               (default: the Vercel and GitHub Pages sites)
     SUPABASE_API_URL          default https://api.supabase.com (tests point it at a mock)
   ============================================================ */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const SIGNUPS_ONLY = args.has("--signups-only");
const CHECK_ONLY = args.has("--check");

const env = (k, d = "") => (process.env[k] ?? d).trim();
const REF = env("SUPABASE_PROJECT_REF", "fwpqytrdlmxymvegvgji");
const API = env("SUPABASE_API_URL", "https://api.supabase.com").replace(/\/$/, "");
const PORTAL_URLS = env("PORTAL_URLS", "https://learning-portal-mu-two.vercel.app/,https://khaima.github.io/Learning-portal/")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SECRET_KEYS = new Set(["smtp_pass"]);
// The API may hand numbers back as strings (smtp_port) and the other way round.
const sameValue = (a, b) => String(a ?? "") === String(b ?? "");
const show = (k, v) => (SECRET_KEYS.has(k) ? (v ? "set (hidden)" : "not set")
  : k === "mailer_templates_recovery_content" ? (v ? `HTML, ${String(v).length} characters` : "default")
  : v === undefined || v === null || v === "" ? "—" : JSON.stringify(v));

/* Stop with a message. (No process.exit — on Windows it can abort
   Node while a fetch connection is still closing.) */
class Stop extends Error {}
function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  throw new Stop(msg);
}

/** Public, unauthenticated settings — what the sign-in page reads. The
    project's address and publishable key come from environments.json (the
    same file the build uses): the entry for SUPABASE_PROJECT_REF. */
async function publicSettings() {
  const environments = JSON.parse(readFileSync(join(ROOT, "environments.json"), "utf8"));
  const env = Object.values(environments).find((e) => e?.supabaseUrl?.includes(`//${REF}.`));
  const url = env?.supabaseUrl;
  const key = env?.publishableKey;
  if (!url || !key) throw new Error(`environments.json has no project ${REF} (with its publishable key).`);
  const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
  if (!res.ok) throw new Error(`${url}/auth/v1/settings answered ${res.status}.`);
  return res.json();
}
function printPublic(s) {
  console.log("Public Auth settings (what the sign-in page sees):");
  console.log(`  sign-ups disabled: ${s.disable_signup ? "yes" : "NO — anyone can create an account directly"}`);
  console.log(`  email + password:  ${s.external?.email ? "on" : "off"}`);
  console.log(`  Google:            ${s.external?.google ? "on (the button shows)" : "off (the button stays hidden)"}`);
}

async function main() {
  if (args.has("--help") || args.has("-h")) {
    console.log("Usage: node --env-file=.env scripts/configure-auth.mjs [--apply] [--signups-only] [--check]\nSee docs/AUTH.md.");
    return;
  }
  const unknown = [...args].filter((a) => !["--apply", "--signups-only", "--check"].includes(a));
  if (unknown.length) fail(`Unknown option ${unknown.join(", ")}. Try --help.`);

  if (CHECK_ONLY) {
    try { printPublic(await publicSettings()); } catch (err) { fail(err.message); }
    return;
  }

  const TOKEN = env("SUPABASE_ACCESS_TOKEN");
  if (!TOKEN) fail("SUPABASE_ACCESS_TOKEN isn't set. Make one at https://supabase.com/dashboard/account/tokens and put it in .env (docs/AUTH.md).");

  async function management(method, body, path = "config/auth") {
    const res = await fetch(`${API}/v1/projects/${REF}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const why = json?.message || json?.error || text.slice(0, 200) || res.statusText;
      fail(`Supabase Management API ${method} ${path} answered ${res.status}: ${why}`);
    }
    return json ?? {};
  }
  /** The same, but a refusal is returned rather than stopping the script. */
  async function managementTry(method, body, path = "config/auth") {
    const res = await fetch(`${API}/v1/projects/${REF}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return res.ok ? { ok: true } : { ok: false, why: json?.message || json?.error || text.slice(0, 200) || res.statusText };
  }

  /* ---- what to set ---- */
  function smtpSettings() {
    const provider = env("SMTP_PROVIDER").toLowerCase();
    const sender = env("SMTP_SENDER_EMAIL");
    let host, port, user, pass;
    if (provider === "resend") {
      [host, port, user, pass] = ["smtp.resend.com", "465", "resend", env("RESEND_API_KEY")];
      if (!pass) fail("SMTP_PROVIDER=resend needs RESEND_API_KEY.");
    } else if (provider === "brevo") {
      [host, port, user, pass] = ["smtp-relay.brevo.com", "587", env("BREVO_SMTP_LOGIN"), env("BREVO_SMTP_KEY")];
      if (!user || !pass) fail("SMTP_PROVIDER=brevo needs BREVO_SMTP_LOGIN and BREVO_SMTP_KEY (Brevo → SMTP & API → SMTP).");
    } else if (provider === "custom") {
      [host, port, user, pass] = [env("SMTP_HOST"), env("SMTP_PORT", "587"), env("SMTP_USER"), env("SMTP_PASS")];
      if (!host || !user || !pass) fail("SMTP_PROVIDER=custom needs SMTP_HOST, SMTP_USER and SMTP_PASS (and SMTP_PORT, default 587).");
    } else {
      fail("Set SMTP_PROVIDER to resend, brevo or custom (or use --signups-only).");
    }
    if (!/^\d{2,5}$/.test(port)) fail(`SMTP port "${port}" isn't a port number.`);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) fail("SMTP_SENDER_EMAIL must be an address at a domain verified with your mail provider, e.g. no-reply@humanpractice.org.");
    const perHour = Number(env("SMTP_RATE_LIMIT_PER_HOUR", "30"));
    if (!Number.isInteger(perHour) || perHour < 1) fail("SMTP_RATE_LIMIT_PER_HOUR must be a whole number, 1 or more.");
    const template = readFileSync(join(ROOT, "supabase", "templates", "recovery.html"), "utf8");
    if (!template.includes("{{ .ConfirmationURL }}")) fail("supabase/templates/recovery.html must contain {{ .ConfirmationURL }}.");
    return {
      smtp_admin_email: sender,
      smtp_sender_name: env("SMTP_SENDER_NAME", "HPF Digital Learning Portal"),
      smtp_host: host,
      smtp_port: port, // the API takes it as a string
      smtp_user: user,
      smtp_pass: pass,
      smtp_max_frequency: 60, // one email per address per minute
      rate_limit_email_sent: perHour,
      mailer_subjects_recovery: "Reset your HPF Digital Learning Portal password",
      mailer_templates_recovery_content: template,
      mailer_otp_exp: 3600, // the link lasts an hour, as the email says
    };
  }

  /* The api Edge Function's mail secrets, for invitation emails — sent
     through the provider's HTTPS API (Edge Functions can't use the usual
     SMTP ports). Returns { secrets } or { skip: why }. */
  function mailSecrets(smtp) {
    const provider = env("SMTP_PROVIDER").toLowerCase();
    let key = "";
    if (provider === "resend") key = env("RESEND_API_KEY"); // the same key works for Resend's API
    else if (provider === "brevo") {
      key = env("BREVO_API_KEY");
      if (!key) return { skip: "BREVO_API_KEY isn't set (Brevo → SMTP & API → API keys; it's not the SMTP key)" };
    } else return { skip: "a custom SMTP server has no HTTPS API the portal can use — invitation links are copied instead" };
    return {
      secrets: [
        { name: "MAIL_PROVIDER", value: provider },
        { name: "MAIL_API_KEY", value: key },
        { name: "MAIL_FROM", value: smtp.smtp_admin_email },
        { name: "MAIL_FROM_NAME", value: smtp.smtp_sender_name },
      ],
    };
  }
  const secretNames = (list) => new Set(Array.isArray(list) ? list.map((x) => x.name) : []);

  /** The allow-list with the portal's addresses added (never removed). */
  function allowList(current) {
    const have = String(current ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const want = PORTAL_URLS.map((u) => (u.endsWith("/") ? u : u + "/") + "**");
    const merged = [...have];
    for (const w of want) if (!merged.includes(w)) merged.push(w);
    return merged.join(",");
  }

  /* ---- run ---- */
  const current = await management("GET");
  const change = { disable_signup: true };
  let mail = { skip: "--signups-only" };
  if (!SIGNUPS_ONLY) {
    Object.assign(change, smtpSettings());
    change.uri_allow_list = allowList(current.uri_allow_list);
    mail = mailSecrets(change);
  }

  console.log(`Project ${REF} — Supabase Auth`);
  console.log(APPLY ? "Applying:" : "Dry run (nothing is changed; add --apply to make the change):");
  let differs = 0;
  for (const [k, v] of Object.entries(change)) {
    if (SECRET_KEYS.has(k)) {
      // Can't be compared without showing it: always sent again.
      if (!current[k]) differs++;
      console.log(`  ${current[k] ? " " : "~"} ${k.padEnd(34)} ${current[k] ? "set (hidden) — sent again" : "not set  →  set (hidden)"}`);
      continue;
    }
    const same = sameValue(current[k], v);
    if (!same) differs++;
    console.log(`  ${same ? " " : "~"} ${k.padEnd(34)} ${same ? show(k, v) : `${show(k, current[k])}  →  ${show(k, v)}`}`);
  }

  // Secret values can't be read back (the API returns only a hash), so they're always sent.
  console.log("\nEdge Function secrets (invitation emails):");
  if (mail.secrets) {
    const have = secretNames(await management("GET", undefined, "secrets"));
    for (const { name, value } of mail.secrets) {
      const shown = name === "MAIL_API_KEY" ? "set (hidden)" : JSON.stringify(value);
      console.log(`  ~ ${name.padEnd(34)} ${have.has(name) ? `set — sent again as ${shown}` : `not set  →  ${shown}`}`);
    }
  } else {
    console.log(`  (not set: ${mail.skip})`);
  }

  // Supabase Auth's own leaked-password check: Pro plan and above, so tried on its own.
  console.log("\nLeaked-password check in Supabase Auth (Pro plan and above):");
  console.log(current.password_hibp_enabled
    ? `    ${"password_hibp_enabled".padEnd(34)} true`
    : `  ~ ${"password_hibp_enabled".padEnd(34)} false  →  true (skipped if the plan doesn't include it)`);

  if (!APPLY) {
    console.log(`\n${differs} Auth setting(s) would change. Run again with --apply to make the change.`);
    return;
  }

  await management("PATCH", change);
  const after = await management("GET");
  const problems = Object.entries(change)
    .filter(([k]) => !SECRET_KEYS.has(k) && k !== "mailer_templates_recovery_content")
    .filter(([k, v]) => after[k] !== undefined && !sameValue(after[k], v))
    .map(([k]) => k);
  if (problems.length) fail(`Saved, but these read back differently: ${problems.join(", ")}. Check the dashboard (Authentication → Settings).`);
  console.log("\n✓ Auth settings saved.");
  if (!current.password_hibp_enabled) {
    const hibp = await managementTry("PATCH", { password_hibp_enabled: true });
    console.log(hibp.ok
      ? "✓ Supabase Auth's leaked-password check is on."
      : `• Supabase Auth's leaked-password check wasn't turned on (${hibp.why}) — it needs the Pro plan. The portal's own check covers every password it sets.`);
  }
  if (mail.secrets) {
    await management("POST", mail.secrets, "secrets");
    const names = secretNames(await management("GET", undefined, "secrets"));
    const missing = mail.secrets.map((x) => x.name).filter((n) => !names.has(n));
    if (missing.length) fail(`Auth settings saved, but these Edge Function secrets didn't appear: ${missing.join(", ")}.`);
    console.log("✓ Edge Function mail secrets saved — the portal can now email invitations.");
  }
  try {
    printPublic(await publicSettings());
  } catch (err) {
    console.log(`(Couldn't read the public settings to confirm: ${err.message})`);
  }
  if (!SIGNUPS_ONLY) {
    console.log("\nNext: in the portal, Users → Reset password → Send reset link to yourself, and Invite staff → Send invitation email to an address of yours; check both arrive (docs/AUTH.md, \"Check it works\").");
  }
}

main().catch((err) => {
  if (!(err instanceof Stop)) console.error(`\n✗ ${err?.message || err}\n`);
  process.exitCode = 1;
});
