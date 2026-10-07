#!/usr/bin/env node
/* ============================================================
   Sets up a staging Supabase project — once, when it's new. It gets
   production's STRUCTURE, never its data:

     node scripts/bootstrap-staging.mjs <staging project ref> --site=<staging site URL>

   e.g. --site=https://learning-portal-git-staging-<team>.vercel.app/

   1. the schema: supabase-schema.sql (reference lists only — counties,
      terms, subjects, grade bands — no people), with its hourly
      notifications job pointed at staging's own API;
   2. every migration marked as applied, so the release's `db push` brings
      only the ones after today;
   3. the API, with HPF_ENVIRONMENT=staging and PORTAL_URLS=<site> (so
      reset and invitation links lead to staging, not the live site);
   4. environments.json and the CSP in vercel.json learn the project, so
      Vercel's preview deployments talk to it.
   Then it prints what's left to do by hand (docs/OPERATIONS.md, "Staging").

   Needs the Supabase CLI signed in (`npx supabase login`). Refuses
   production's ref.
   ============================================================ */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PRODUCTION = "fwpqytrdlmxymvegvgji";
const CLI = "supabase@2.114.0";
const ref = process.argv[2];
const site = process.argv.find((a) => a.startsWith("--site="))?.slice(7);
if (!/^[a-z]{20}$/.test(ref ?? "")) throw new Error("usage: node scripts/bootstrap-staging.mjs <staging project ref> --site=<staging site URL>");
if (ref === PRODUCTION) throw new Error("That's production's ref — this is only for a new, empty staging project.");
if (!/^https:\/\/[\w.-]+\/?$/.test(site ?? "")) throw new Error("--site=<the staging site's address>, e.g. https://learning-portal-git-staging-<team>.vercel.app/");

/** Runs a command; on Windows through the shell (npx is a .cmd there) as one quoted string. */
const run = (cmd, args, opts) => (process.platform === "win32"
  ? spawnSync([cmd, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" "), { ...opts, shell: true })
  : spawnSync(cmd, args, opts));
const supabase = (...args) => {
  const r = run("npx", ["--yes", CLI, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) throw new Error(`supabase ${args.slice(0, 2).join(" ")} failed:\n${r.stdout}`);
  return r.stdout;
};

// 1. the schema, with staging's own address in the notifications job
console.log("1/4 schema…");
const dir = mkdtempSync(join(tmpdir(), "hpf-staging-"));
const schema = join(dir, "schema.sql");
writeFileSync(schema, readFileSync(join(ROOT, "supabase-schema.sql"), "utf8").replaceAll(PRODUCTION, ref));
supabase("db", "query", "--project-ref", ref, "-f", schema);

// 2. every migration as applied
console.log("2/4 migration history…");
const versions = readdirSync(join(ROOT, "supabase", "migrations")).map((f) => f.split("_")[0]).filter((v) => /^\d{14}$/.test(v));
supabase("migration", "repair", "--status", "applied", ...versions, "--project-ref", ref, "--yes");

// 3. the API
console.log("3/4 the API…");
supabase("secrets", "set", "--project-ref", ref, "HPF_ENVIRONMENT=staging", `PORTAL_URLS=${site.endsWith("/") ? site : `${site}/`}`);
const deployed = spawnSync("node", [join(ROOT, "scripts", "deploy-api.mjs"), `--project-ref=${ref}`], { cwd: ROOT, stdio: "inherit" });
if (deployed.status !== 0) throw new Error("deploying the API failed");

// 4. the site's side: which project previews use, and the CSP letting them reach it
console.log("4/4 environments.json and vercel.json…");
const keys = JSON.parse(supabase("projects", "api-keys", "--project-ref", ref, "-o", "json"));
const publishable = (Array.isArray(keys) ? keys : keys.keys ?? []).map((k) => k.api_key ?? k.key ?? "").find((k) => k.startsWith("sb_publishable_"));
if (!publishable) throw new Error("No publishable key on the staging project — create one in the dashboard (Settings → API Keys) and run this again.");
const url = `https://${ref}.supabase.co`;
const envFile = join(ROOT, "environments.json");
const environments = JSON.parse(readFileSync(envFile, "utf8"));
environments.staging = { supabaseUrl: url, publishableKey: publishable };
writeFileSync(envFile, `${JSON.stringify(environments, null, 2)}\n`);
const vercelFile = join(ROOT, "vercel.json");
const vercel = readFileSync(vercelFile, "utf8");
const prod = `https://${PRODUCTION}.supabase.co`;
writeFileSync(vercelFile, vercel.includes(url) ? vercel : vercel.replaceAll(`${prod} `, `${prod} ${url} `).replaceAll(`${prod};`, `${prod} ${url};`));

console.log(`
✓ Staging (${ref}) has the schema, the migration history and the API.

Left to do (docs/OPERATIONS.md, "Staging"):
  1. Commit environments.json and vercel.json, and push to staging.
  2. GitHub → Settings → Secrets and variables → Actions → Variables:
     STAGING_PROJECT_REF = ${ref}
  3. Staging's sign-in settings, with your own keys (dry run first, then --apply):
     SUPABASE_PROJECT_REF=${ref} PORTAL_URLS=${site} node --env-file=.env scripts/configure-auth.mjs
  4. A first Super Admin on staging: sign up on the staging site, then
     npx ${CLI} db query --project-ref ${ref} "update public.profiles set role = 'super_admin', status = 'active' where email = '<you>'"
`);
