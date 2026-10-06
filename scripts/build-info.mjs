/* ============================================================
   What the build produced, read back from dist/ — shared by
   build-sw.mjs (the service worker's lists) and bundle-report.mjs.
   ============================================================ */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const DIST = join(import.meta.dirname, "..", "dist");
if (!existsSync(join(DIST, ".vite", "manifest.json"))) {
  console.error("✗ No build found — run `npm run build` first.");
  process.exit(1);
}
export const manifest = JSON.parse(readFileSync(join(DIST, ".vite", "manifest.json"), "utf8"));
const byFile = new Map(Object.entries(manifest).map(([key, c]) => [c.file, key]));

/** Every file in dist/, as a path relative to it with "/" separators. */
export function distFiles(dir = DIST) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? distFiles(full) : [relative(DIST, full).split(sep).join("/")];
  });
}

/** The built pages (not the 404 page). */
export const builtPages = () => readdirSync(DIST).filter((f) => f.endsWith(".html") && f !== "404.html");

const refs = (html, re) => [...html.matchAll(re)].map((m) => m[1].replace(/^\.\//, "")).filter((f) => !/^https?:/.test(f));

/* Each built page's own <script>, modulepreload and stylesheet tags say
   what it loads up front (the four workspace pages share one script, so
   the manifest alone doesn't list them as pages); the manifest says what
   each of those files imports, statically and with import(). */
export function pageFiles(page) {
  const html = readFileSync(join(DIST, page), "utf8");
  const upFront = new Set(), later = new Set();
  const css = new Set(refs(html, /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g));
  const walk = (key, set) => {
    const chunk = manifest[key];
    if (!chunk || set.has(chunk.file)) return;
    set.add(chunk.file);
    for (const c of chunk.css ?? []) css.add(c);
    for (const i of chunk.imports ?? []) walk(i, set);
  };
  for (const f of [...refs(html, /<script[^>]+src="([^"]+)"/g), ...refs(html, /<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)]) {
    if (byFile.has(f)) walk(byFile.get(f), upFront); else if (f.endsWith(".js")) upFront.add(f);
  }
  const seen = new Set();
  const dyn = (key) => {
    const chunk = manifest[key];
    if (!chunk || seen.has(key)) return;
    seen.add(key);
    for (const d of chunk.dynamicImports ?? []) {
      const s = new Set();
      walk(d, s);
      for (const x of s) if (!upFront.has(x)) later.add(x);
      dyn(d);
    }
    for (const i of chunk.imports ?? []) dyn(i);
  };
  for (const f of upFront) if (byFile.has(f)) dyn(byFile.get(f));
  return { js: [...upFront], css: [...css], later: [...later] };
}
