#!/usr/bin/env node
/* ============================================================
   Deploys the `api` Edge Function, stamped with the release it came from.

     node scripts/deploy-api.mjs                       # production
     node scripts/deploy-api.mjs --project-ref=<ref>   # e.g. staging

   Writes the git commit into supabase/functions/api/release.ts (error
   reports and GET /health carry it), deploys with the Supabase CLI, and
   puts "dev" back. Needs the CLI to be signed in: `npx supabase login` on
   a computer, or SUPABASE_ACCESS_TOKEN in CI (.github/workflows/release.yml).
   ============================================================ */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PRODUCTION = "fwpqytrdlmxymvegvgji";
const CLI = "supabase@2.114.0";
/** Runs a command; on Windows through the shell (npx is a .cmd there) as one quoted string. */
const run = (cmd, args, opts) => (process.platform === "win32"
  ? spawnSync([cmd, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" "), { ...opts, shell: true })
  : spawnSync(cmd, args, opts));
const ref = process.argv.find((a) => a.startsWith("--project-ref="))?.slice(14) || PRODUCTION;
if (!/^[a-z]{20}$/.test(ref)) throw new Error(`deploy-api: "${ref}" isn't a project ref`);

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const changed = git("status", "--porcelain", "--", "supabase/functions/api").length > 0;
const release = `${git("rev-parse", "--short=12", "HEAD")}${changed ? "-local" : ""}`;

const file = join(ROOT, "supabase", "functions", "api", "release.ts");
const original = readFileSync(file, "utf8");
writeFileSync(file, original.replace(/export const RELEASE = "[^"]*";/, `export const RELEASE = ${JSON.stringify(release)};`));
let status = 1;
try {
  console.log(`Deploying api ${release} to ${ref === PRODUCTION ? "production" : ref}…`);
  status = run("npx", ["--yes", CLI, "functions", "deploy", "api", "--project-ref", ref, "--no-verify-jwt", "--use-api"], {
    cwd: ROOT, stdio: "inherit",
  }).status ?? 1;
} finally {
  writeFileSync(file, original);
}
if (status !== 0) {
  process.exitCode = status;
} else {
  console.log(`✓ api ${release} deployed`);
}
