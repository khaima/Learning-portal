#!/usr/bin/env node
/* ============================================================
   Keeps the pages and the Content-Security-Policy (vercel.json) in step.
   Run in CI after the build (.github/workflows/test.yml); fails with a
   list of problems.

     npm run build && node scripts/check-csp.mjs           # check
     npm run build && node scripts/check-csp.mjs --print   # also print every inline block's hash

   Checks the BUILT pages in dist/ (what is deployed) and the sources:
   - every inline <script> / <style> in a built page has its SHA-256 in the
     CSP (script-src / style-src-elem) — anything else would be blocked;
   - no inline event handlers (onclick="…") or javascript: URLs, in the
     pages or in the HTML the scripts build;
   - every external script and stylesheet a page loads is from a host the
     CSP allows, and no source module imports code from a URL (it comes
     from npm and is bundled instead);
   - every file the generated service worker lists exists in the build.
   ============================================================ */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const PRINT = process.argv.includes("--print");
const problems = [];
const read = (dir, f) => readFileSync(join(dir, f), "utf8");
if (!existsSync(join(DIST, "sw.js"))) {
  console.error("✗ No build found — run `npm run build` first.");
  process.exit(1);
}

// ---- the policy
const vercel = JSON.parse(read(ROOT, "vercel.json"));
const all = vercel.headers.find((h) => h.source === "/(.*)");
const cspValue = all?.headers.find((h) => h.key.toLowerCase() === "content-security-policy")?.value;
if (!cspValue) {
  console.error("✗ vercel.json has no Content-Security-Policy for /(.*)");
  process.exit(1);
}
const csp = new Map(cspValue.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
  const [name, ...values] = d.split(/\s+/);
  return [name, values];
}));
const sourcesFor = (directive) => csp.get(directive) ?? csp.get("default-src") ?? [];
const hostAllowed = (url, directive) => {
  const u = new URL(url);
  return sourcesFor(directive).some((s) => s === u.origin || (s.startsWith("https://*.") && u.protocol === "https:" && u.hostname.endsWith(s.slice(9))));
};
const sha256 = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

// ---- built pages: inline blocks, external hosts
const builtPages = readdirSync(DIST).filter((f) => f.endsWith(".html"));
for (const page of builtPages) {
  const html = read(DIST, page);
  for (const [tag, directive] of [["script", "script-src"], ["style", "style-src-elem"]]) {
    for (const m of html.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))) {
      const attrs = m[1] ?? "";
      if (tag === "script" && /\ssrc=/i.test(attrs)) continue;
      const hash = sha256(m[2]);
      if (PRINT) console.log(`${page} inline <${tag}>: ${hash}`);
      if (!sourcesFor(directive).includes(hash)) problems.push(`dist/${page}: an inline <${tag}> isn't allowed by ${directive} — add ${hash} to it, or move the code into a file`);
    }
  }
  for (const m of html.matchAll(/<script\s[^>]*src="(https?:[^"]+)"/gi)) {
    if (!hostAllowed(m[1], "script-src")) problems.push(`dist/${page}: loads a script from ${m[1]}, which script-src doesn't allow`);
  }
  for (const m of html.matchAll(/<link\s[^>]*rel="stylesheet"[^>]*href="(https?:[^"]+)"/gi)) {
    if (!hostAllowed(m[1], "style-src-elem")) problems.push(`dist/${page}: loads a stylesheet from ${m[1]}, which style-src-elem doesn't allow`);
  }
}

// ---- inline handlers and javascript: URLs — sources and the build
const sourceFiles = readdirSync(ROOT).filter((f) => /\.(js|html)$/.test(f)).map((f) => [ROOT, f]);
const builtFiles = [...builtPages.map((f) => [DIST, f]), ...readdirSync(join(DIST, "static")).filter((f) => f.endsWith(".js")).map((f) => [join(DIST, "static"), f])];
const HANDLER = /<[a-z][^>]*\son[a-z]+\s*=\s*["'{]/i;
const JS_URL = /(href|src|action)\s*=\s*["']\s*javascript:/i;
for (const [dir, file] of [...sourceFiles, ...builtFiles]) {
  const where = dir === ROOT ? file : `${dir.slice(ROOT.length + 1).replace(/\\/g, "/")}/${file}`;
  read(dir, file).split("\n").forEach((line, i) => {
    if (HANDLER.test(line)) problems.push(`${where}:${i + 1}: inline event handler — use addEventListener instead`);
    if (JS_URL.test(line)) problems.push(`${where}:${i + 1}: javascript: URL`);
  });
}

// ---- no code from a URL at run time
for (const [dir, file] of sourceFiles.filter(([, f]) => f.endsWith(".js"))) {
  read(dir, file).split("\n").forEach((line, i) => {
    if (/(\bfrom\s+|\bimport\s*\(\s*)["']https?:/.test(line)) problems.push(`${file}:${i + 1}: imports code from a URL — install it from npm so the build bundles it`);
  });
}

// ---- the generated service worker's lists
const sw = read(DIST, "sw.js");
for (const name of ["CORE", "FILES"]) {
  const list = JSON.parse(sw.match(new RegExp(`const ${name} = (\\[.*?\\]);`))?.[1] ?? "[]");
  if (!list.length) problems.push(`dist/sw.js has no ${name} list`);
  for (const f of list) if (f && !existsSync(join(DIST, f))) problems.push(`dist/sw.js lists ${f}, but the build has no such file`);
}

// ---- every project a build can talk to (environments.json) is one the CSP lets it reach
const environments = JSON.parse(read(ROOT, "environments.json"));
for (const [name, env] of Object.entries(environments)) {
  if (!env) continue; // not set up yet
  for (const directive of ["connect-src", "img-src", "media-src", "frame-src"]) {
    if (!hostAllowed(env.supabaseUrl, directive)) problems.push(`environments.json: ${name} (${env.supabaseUrl}) isn't in ${directive} — add it to the CSP in vercel.json`);
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exitCode = 1;
} else {
  console.log(`✓ CSP and pages agree (${builtPages.length} built pages, ${builtFiles.length - builtPages.length} built scripts, ${sourceFiles.length} sources).`);
}
