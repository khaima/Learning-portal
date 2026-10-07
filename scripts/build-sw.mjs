#!/usr/bin/env node
/* ============================================================
   Writes dist/sw.js from sw-template.js, after `vite build`
   (npm run build does both). Nothing in the service worker is kept by
   hand any more:
   - VERSION   — a hash of every file the build produced and of the
                 service worker's own code, so it changes exactly when
                 something the browser downloads changes;
   - CORE      — kept on every device: the site's address and every page,
                 the app manifest and icons, the stylesheets, and the
                 sign-in page's code (what everyone needs first);
   - FILES     — every fingerprinted file (static/name-[hash].ext); a
                 device keeps the ones it has used (sw-template.js).
   It also writes version.json — { version } — which error reports carry
   (telemetry.js), kept on the device with the code it describes.
   ============================================================ */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtPages, DIST, distFiles, pageFiles } from "./build-info.mjs";

const ROOT = join(import.meta.dirname, "..");
// What the build made (sw.js and version.json are written below, from it).
const all = distFiles().filter((f) => f !== "sw.js" && f !== "version.json" && !f.startsWith(".vite/")).sort();

const FILES = all.filter((f) => f.startsWith("static/"));
const pages = builtPages();
const signIn = pageFiles("index.html");
const stylesheets = new Set(pages.flatMap((p) => pageFiles(p).css));
const CORE = [
  "", // the site's own address (opens index.html)
  ...pages, "404.html",
  "manifest.webmanifest", "assets/icon-192.png", "assets/icon-512.png",
  ...stylesheets, ...signIn.js,
].filter((f, i, a) => a.indexOf(f) === i);
for (const f of CORE) if (f && !all.includes(f)) throw new Error(`build-sw: ${f} is in CORE but not in the build`);

const sha = (data) => createHash("sha256").update(data).digest("hex");
const template = readFileSync(join(ROOT, "sw-template.js"), "utf8");
const VERSION = "hpf-" + sha([
  `sw-template.js:${sha(template)}`, // the worker's own code is part of the version too
  ...all.map((f) => `${f}:${sha(readFileSync(join(DIST, f)))}`),
].join("\n")).slice(0, 12);

// Kept with the code it names, so a page reports the version it is really running.
writeFileSync(join(DIST, "version.json"), `${JSON.stringify({ version: VERSION })}\n`);
CORE.push("version.json");

const sw = template
  .replace('"__VERSION__"', JSON.stringify(VERSION))
  .replace("__CORE__", JSON.stringify(CORE))
  .replace("__FILES__", JSON.stringify(FILES));
for (const marker of ["__VERSION__", "__CORE__", "__FILES__"]) {
  if (sw.includes(marker)) throw new Error(`build-sw: ${marker} wasn't filled in`);
}
writeFileSync(join(DIST, "sw.js"), sw);
console.log(`✓ dist/sw.js — ${VERSION}: ${CORE.length} files on every device, ${FILES.length} fingerprinted files in all`);
