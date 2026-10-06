#!/usr/bin/env node
/* ============================================================
   What each page downloads, from the build (dist/.vite/manifest.json).

     npm run build && node scripts/bundle-report.mjs [--json] [--budget=150]

   For every page: the JavaScript and CSS it loads up front (its entry and
   everything that imports statically), and what it can load later on
   demand (import()). Sizes are as built (minified) and gzipped. With
   --budget=N, fails if the sign-in page's up-front JavaScript is over N KB
   (minified, before compression) — the target in README "The build".
   ============================================================ */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { builtPages, DIST, pageFiles } from "./build-info.mjs";

const args = process.argv.slice(2);
const budget = Number(args.find((a) => a.startsWith("--budget="))?.split("=")[1] ?? NaN);

const size = new Map();
const sizeOf = (file) => {
  if (!size.has(file)) {
    const buf = readFileSync(join(DIST, file));
    size.set(file, { raw: buf.length, gz: gzipSync(buf, { level: 9 }).length });
  }
  return size.get(file);
};
const pages = builtPages();
const kb = (n) => (n / 1024).toFixed(1);
const total = (files) => files.reduce((t, f) => ({ raw: t.raw + sizeOf(f).raw, gz: t.gz + sizeOf(f).gz }), { raw: 0, gz: 0 });
const rows = pages.map((page) => {
  const p = pageFiles(page);
  return { page, js: total(p.js), jsFiles: p.js.length, css: total(p.css), later: total(p.later), laterFiles: p.later.length };
}).sort((a, b) => a.page.localeCompare(b.page));

if (args.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log("page".padEnd(16), "JS up front (min / gzip, files)".padEnd(34), "CSS (min / gzip)".padEnd(20), "on demand (min / gzip, files)");
  for (const r of rows) {
    console.log(r.page.padEnd(16),
      `${kb(r.js.raw)} / ${kb(r.js.gz)} KB, ${r.jsFiles}`.padEnd(34),
      `${kb(r.css.raw)} / ${kb(r.css.gz)} KB`.padEnd(20),
      `${kb(r.later.raw)} / ${kb(r.later.gz)} KB, ${r.laterFiles}`);
  }
}
if (Number.isFinite(budget)) {
  const signIn = rows.find((r) => r.page === "index.html");
  const over = signIn.js.raw / 1024 > budget;
  console.log(`${over ? "✗" : "✓"} sign-in page JavaScript up front: ${kb(signIn.js.raw)} KB (budget ${budget} KB)`);
  if (over) process.exitCode = 1;
}
