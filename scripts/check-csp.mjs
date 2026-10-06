#!/usr/bin/env node
/* ============================================================
   Keeps the pages and the Content-Security-Policy (vercel.json) in step.
   Run in CI (.github/workflows/test.yml); fails with a list of problems.

     node scripts/check-csp.mjs           # check
     node scripts/check-csp.mjs --print   # also print every inline block's hash

   Checks:
   - every inline <script> / <style> in a page has its SHA-256 in the CSP
     (script-src / style-src-elem) — anything else would be blocked;
   - no inline event handlers (onclick="…") or javascript: URLs, in pages
     or in the HTML the scripts build;
   - every external script and stylesheet a page loads is from a host the
     CSP allows, and no script imports code from a URL (vendor/ instead);
   - every file the service worker keeps for offline use exists.
   ============================================================ */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRINT = process.argv.includes("--print");
const problems = [];
const read = (f) => readFileSync(join(ROOT, f), "utf8");

// ---- the policy
const vercel = JSON.parse(read("vercel.json"));
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

// ---- pages
const pages = readdirSync(ROOT).filter((f) => f.endsWith(".html"));
for (const page of pages) {
  const html = read(page);
  for (const [tag, directive] of [["script", "script-src"], ["style", "style-src-elem"]]) {
    for (const m of html.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))) {
      const attrs = m[1] ?? "";
      if (tag === "script" && /\ssrc=/i.test(attrs)) continue;
      const hash = sha256(m[2]);
      if (PRINT) console.log(`${page} inline <${tag}>: ${hash}`);
      if (!sourcesFor(directive).includes(hash)) problems.push(`${page}: an inline <${tag}> isn't allowed by ${directive} — add ${hash} to it, or move the code into a file`);
    }
  }
  for (const m of html.matchAll(/<script\s[^>]*src="(https?:[^"]+)"/gi)) {
    if (!hostAllowed(m[1], "script-src")) problems.push(`${page}: loads a script from ${m[1]}, which script-src doesn't allow`);
  }
  for (const m of html.matchAll(/<link\s[^>]*rel="stylesheet"[^>]*href="(https?:[^"]+)"/gi)) {
    if (!hostAllowed(m[1], "style-src-elem")) problems.push(`${page}: loads a stylesheet from ${m[1]}, which style-src-elem doesn't allow`);
  }
}

// ---- inline handlers and javascript: URLs, in pages and in the HTML scripts build
const scripts = readdirSync(ROOT).filter((f) => f.endsWith(".js"));
const HANDLER = /<[a-z][^>]*\son[a-z]+\s*=\s*["'{]/i;
const JS_URL = /(href|src|action)\s*=\s*["']\s*javascript:/i;
for (const file of [...pages, ...scripts]) {
  read(file).split("\n").forEach((line, i) => {
    if (HANDLER.test(line)) problems.push(`${file}:${i + 1}: inline event handler — use addEventListener instead`);
    if (JS_URL.test(line)) problems.push(`${file}:${i + 1}: javascript: URL`);
  });
}

// ---- no code from a URL at run time
for (const file of scripts) {
  read(file).split("\n").forEach((line, i) => {
    if (/(\bfrom\s+|\bimport\s*\(\s*)["']https?:/.test(line)) problems.push(`${file}:${i + 1}: imports code from a URL — vendor it (vendor/README.md)`);
  });
}

// ---- the service worker's offline copy
const shell = read("sw.js").match(/const SHELL = \[([\s\S]*?)\];/)?.[1] ?? "";
for (const [, path] of shell.matchAll(/"\.\/([^"]*)"/g)) {
  if (path && !existsSync(join(ROOT, path))) problems.push(`sw.js keeps ./${path} offline, but there's no such file`);
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exitCode = 1;
} else {
  console.log(`✓ CSP and pages agree (${pages.length} pages, ${scripts.length} scripts).`);
}
